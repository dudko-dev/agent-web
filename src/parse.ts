/**
 * Robust parsing of model output. Small in-browser models emit JSON wrapped in
 * prose or code fences, truncate it mid-token when they loop, or drift to plain
 * text. Every parser here is defensive: it salvages what it can and NEVER
 * throws, and it never surfaces raw JSON as user-facing text. This is the
 * backbone of the "prompted" tool-mode (see tools/mode.ts).
 */

/** A tool the executor asked to run. */
export interface RawAction {
  tool: string
  args: Record<string, unknown>
}

export type ReplanDecision = 'continue' | 'revise' | 'finish'

const stripFences = (text: string): string => (text || '').replace(/```(?:json)?/gi, '').trim()

/** Extracts the first balanced {...} or [...] block, respecting strings. */
const extractBalanced = (text: string, open: '{' | '['): string | undefined => {
  const close = open === '{' ? '}' : ']'
  const start = text.indexOf(open)
  if (start < 0) return undefined
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i += 1) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth += 1
    else if (c === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

const tryParse = (s: string | undefined): unknown => {
  if (!s) return undefined
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/** True when a string is (or is dominated by) raw JSON — kept out of the UI. */
export const looksLikeJson = (s: string): boolean => {
  const t = (s || '').trim()
  return (
    t.startsWith('{') ||
    t.startsWith('[') ||
    /"(tool|args|plan|reply|actions|decision)"\s*:/.test(t)
  )
}

const asObject = (text: string): Record<string, unknown> | undefined => {
  const v = tryParse(text) ?? tryParse(extractBalanced(text, '{'))
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

/** Trim, drop empties, de-duplicate (case-insensitive), cap length. */
export const normalizeSteps = (arr: unknown, cap = 12): string[] => {
  if (!Array.isArray(arr)) return []
  const seen: Record<string, boolean> = {}
  const out: string[] = []
  for (const s of arr) {
    if (out.length >= cap || typeof s !== 'string') continue
    const step = s.trim()
    const key = step.toLowerCase()
    if (!step || seen[key]) continue
    seen[key] = true
    out.push(step)
  }
  return out
}

/** Decode a JSON string body (\" \\n \\uXXXX …); falls back to the raw text. */
const decodeJsonString = (body: string): string => {
  const v = tryParse(`"${body}"`)
  return typeof v === 'string' ? v : body
}

/**
 * Pull "..."-quoted strings out of a (possibly truncated) named array. The scan
 * is bounded to the array itself — from its `[` to the matching `]`, or the end
 * of the text when truncated — so values of LATER fields are never swept in.
 */
const salvageStringArray = (text: string, field: string): string[] => {
  const m = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(text)
  if (!m) return []
  const out: string[] = []
  let i = m.index + m[0].length
  while (i < text.length && text[i] !== ']') {
    if (text[i] !== '"') {
      i += 1
      continue
    }
    let j = i + 1
    let esc = false
    while (j < text.length && (esc || text[j] !== '"')) {
      esc = !esc && text[j] === '\\'
      j += 1
    }
    if (j >= text.length) break // truncated mid-string — drop the fragment
    out.push(decodeJsonString(text.slice(i + 1, j)))
    i = j + 1
  }
  return out
}

const salvageString = (text: string, field: string): string => {
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  return m ? decodeJsonString(m[1]).trim() : ''
}

// --- planner ---------------------------------------------------------------

export interface PlannerResult {
  reply: string
  plan: string[]
}

export const parsePlannerResponse = (raw: string): PlannerResult => {
  const text = stripFences(raw)
  const obj = asObject(text)
  if (obj) {
    const reply = typeof obj.reply === 'string' ? obj.reply.trim() : ''
    return { reply, plan: normalizeSteps(obj.plan) }
  }
  if (/"plan"\s*:/.test(text)) {
    return {
      reply: salvageString(text, 'reply'),
      plan: normalizeSteps(salvageStringArray(text, 'plan')),
    }
  }
  return { reply: looksLikeJson(text) ? '' : text.trim(), plan: [] }
}

// --- executor (tool calls) -------------------------------------------------

export interface ExecutorResult {
  reply: string
  actions: RawAction[]
}

const toActions = (value: unknown): RawAction[] => {
  if (!Array.isArray(value)) return []
  const out: RawAction[] = []
  for (const a of value) {
    if (a && typeof a === 'object' && typeof (a as { tool?: unknown }).tool === 'string') {
      const rec = a as { tool: string; args?: unknown }
      out.push({
        tool: rec.tool,
        args:
          rec.args && typeof rec.args === 'object' && !Array.isArray(rec.args)
            ? (rec.args as Record<string, unknown>)
            : {},
      })
    }
  }
  return out
}

export const parseExecutorResponse = (raw: string): ExecutorResult => {
  const text = stripFences(raw)
  const obj = asObject(text)
  if (obj) {
    const reply = typeof obj.reply === 'string' ? obj.reply.trim() : ''
    return { reply, actions: toActions(obj.actions) }
  }
  // Bare actions array.
  const arr = tryParse(extractBalanced(text, '['))
  if (Array.isArray(arr)) {
    const actions = toActions(arr)
    return { reply: '', actions }
  }
  return { reply: looksLikeJson(text) ? '' : text.trim(), actions: [] }
}

// --- replanner -------------------------------------------------------------

export interface ReplannerResult {
  decision: ReplanDecision
  reason: string
  plan: string[]
}

export const parseReplannerResponse = (raw: string): ReplannerResult => {
  const obj = asObject(stripFences(raw))
  const decision: ReplanDecision =
    obj?.decision === 'revise' || obj?.decision === 'finish' ? obj.decision : 'continue'
  const reason = typeof obj?.reason === 'string' ? obj.reason.trim() : ''
  return { decision, reason, plan: normalizeSteps(obj?.plan) }
}

// --- plain text (synthesizer / chat answers) -------------------------------

/** Extracts a clean human sentence, never raw JSON. */
export const parsePlainText = (raw: string): string => {
  const text = stripFences(raw)
  const obj = asObject(text)
  if (obj && typeof obj.reply === 'string') return obj.reply.trim()
  return looksLikeJson(text) ? '' : text.trim()
}
