import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { addUsage, BLOCKER, emptyUsage, type IToolCall, type IUsage } from '../agent/loop-types.js'
import { parseExecutorResponse } from '../parse.js'
import { dispatch } from '../tools/prompted.js'
import { clip, normalizeUsage, promptOf, timeoutSignal } from './util.js'

export interface ToolLoopCallbacks {
  onTextDelta?: (delta: string) => void
  onToolCall?: (name: string, input: unknown) => void
  onToolResult?: (name: string, output: unknown, ok: boolean) => void
}

export interface ToolLoopOptions {
  /** 'native' = SDK function-calling; 'prompted' = parse JSON out of plain text. */
  mode: 'native' | 'prompted'
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  /** In native mode: the callable tools. In prompted mode: used to dispatch salvaged calls. */
  tools: ToolSet
  /**
   * Restrict callable tools to these names (plan-narrowed). Native mode passes
   * them to the SDK's `activeTools`; prompted mode bounds `dispatch` to them.
   */
  activeTools?: string[]
  /** Cap on tool-calling rounds within this call, in both modes (default 4). */
  maxSteps?: number
  maxOutputTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  timeoutMs?: number
  callbacks?: ToolLoopCallbacks
}

export interface ToolLoopResult {
  text: string
  toolCalls: IToolCall[]
  usage: IUsage
}

/**
 * Run tool-calling in whichever mode the model needs, returning a normalised
 * result. Native mode streams the SDK's multi-step function-calling; prompted
 * mode salvages `{ reply, actions }` JSON out of plain text, dispatches each
 * action through the tool's own execute, then feeds the TOOL RESULTS back and
 * lets the model continue the same task — up to `maxSteps` rounds in both
 * modes. Both modes call the exact same tool implementations.
 */
export const runToolLoop = (
  model: LanguageModel,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> =>
  opts.mode === 'prompted' ? runPrompted(model, opts) : runNative(model, opts)

const runNative = async (model: LanguageModel, opts: ToolLoopOptions): Promise<ToolLoopResult> => {
  const toolCalls: IToolCall[] = []
  const pending = new Map<string, { name: string; input: unknown }>()

  const result = streamText({
    model,
    tools: opts.tools,
    ...(opts.activeTools ? { activeTools: opts.activeTools } : {}),
    stopWhen: stepCountIs(opts.maxSteps ?? 4),
    system: opts.system,
    ...promptOf(opts),
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
  })

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) opts.callbacks?.onTextDelta?.(part.text)
        break
      case 'tool-call':
        pending.set(part.toolCallId, { name: part.toolName, input: part.input })
        opts.callbacks?.onToolCall?.(part.toolName, part.input)
        break
      case 'tool-result': {
        const known = pending.get(part.toolCallId)
        toolCalls.push({
          name: part.toolName,
          input: known?.input ?? part.input,
          output: part.output,
          ok: true,
        })
        opts.callbacks?.onToolResult?.(part.toolName, part.output, true)
        pending.delete(part.toolCallId)
        break
      }
      case 'tool-error': {
        const known = pending.get(part.toolCallId)
        toolCalls.push({
          name: part.toolName,
          input: known?.input ?? part.input,
          output: part.error,
          ok: false,
        })
        opts.callbacks?.onToolResult?.(part.toolName, part.error, false)
        pending.delete(part.toolCallId)
        break
      }
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }

  const [text, usage] = await Promise.all([result.text, result.usage])
  return { text: text.trim(), toolCalls, usage: normalizeUsage(usage) }
}

/** JSON one-liner for a tool input/output; never throws (circular → String). */
const asJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** One round's results + the continue-or-finish contract for the next round. */
const toolResultsPrompt = (results: IToolCall[]): string => {
  const lines = results.map(
    (r) =>
      `- ${r.name} ${clip(asJson(r.input), 160)} → ${r.ok ? 'ok' : 'FAILED'}: ${clip(asJson(r.output), 400)}`,
  )
  return `TOOL RESULTS:
${lines.join('\n')}

Continue THIS step using the results above. Reply with a single JSON object, nothing else:
{ "reply": string, "actions": [ { "tool": string, "args": object } ] }
- If the step is now complete: "actions": [] and a short outcome in "reply".
- Otherwise emit ONLY the remaining or corrective calls — never repeat a successful call.`
}

const runPrompted = async (
  model: LanguageModel,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> => {
  // Prompted mode does NOT pass tools to the SDK — the tool catalogue is
  // already rendered into the prompt (see tools/prompted.ts renderCatalog); the
  // model replies with JSON, which we salvage and dispatch ourselves.
  //
  // After a round's actions run, the model is shown their TOOL RESULTS and may
  // continue the same task (react to a read-tool's output, fix a failed call)
  // until it returns no actions, signals [BLOCKER], re-emits a batch it already
  // ran, or `maxSteps` rounds are spent. Without this feedback a prompted model
  // never learns what its calls returned — a read-tool would be write-only. Set
  // maxSteps: 1 for the old single-round behaviour.
  const maxRounds = Math.max(1, opts.maxSteps ?? 4)
  const active = opts.activeTools
  const tools = active
    ? Object.fromEntries(Object.entries(opts.tools).filter(([name]) => active.includes(name)))
    : opts.tools

  // One watchdog for the WHOLE call (as native mode does with its single
  // stream), so a slow local model can't run up to maxRounds × timeoutMs; every
  // round's generation and every dispatch share this one deadline.
  const signal = timeoutSignal(opts.abortSignal, opts.timeoutMs)

  // The conversation grows across rounds: the model's own raw reply, then a
  // user message with the results — the standard chat shape every model knows.
  const messages: ModelMessage[] = opts.messages
    ? [...opts.messages]
    : [{ role: 'user', content: opts.prompt ?? '' }]
  const toolCalls: IToolCall[] = []
  // Every batch this loop has dispatched, so an exact repeat is caught even
  // when it isn't consecutive (A→B→A oscillation, not just A→A stutter).
  const seen = new Set<string>()
  let usage = emptyUsage()
  let text = ''

  for (let round = 1; round <= maxRounds; round += 1) {
    if (signal?.aborted) break
    const result = await generateText({
      model,
      system: opts.system,
      messages,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature,
      abortSignal: signal,
    })
    usage = addUsage(usage, normalizeUsage(result.usage))

    const parsed = parseExecutorResponse(result.text)
    // The LAST round's reply wins — an empty final reply is left empty (the
    // executor's summaryOf fills it in) rather than surfacing a stale, often
    // future-tense reply from an earlier round. Never the raw JSON envelope.
    text = parsed.reply

    // [BLOCKER] in any round is authoritative: the model says it cannot finish,
    // so preserve that reply (the executor detects the sentinel to drive the
    // replanner) and stop WITHOUT dispatching this round's speculative actions.
    if (parsed.reply.includes(BLOCKER)) break
    if (parsed.actions.length === 0) break

    // A batch this loop already ran is a stutter, not progress — re-running it
    // would apply every side effect again.
    const batch = asJson(parsed.actions)
    if (seen.has(batch)) break
    seen.add(batch)

    const results: IToolCall[] = []
    for (const action of parsed.actions) {
      if (signal?.aborted) break // stop mid-batch the moment the caller aborts
      opts.callbacks?.onToolCall?.(action.tool, action.args)
      const rec = await dispatch(action, tools, { abortSignal: signal })
      toolCalls.push(rec)
      results.push(rec)
      opts.callbacks?.onToolResult?.(rec.name, rec.output, rec.ok)
    }

    if (round === maxRounds || signal?.aborted) break
    messages.push({ role: 'assistant', content: result.text })
    messages.push({ role: 'user', content: toolResultsPrompt(results) })
  }

  // Prompted mode can't stream, so surface the final reply ONCE (not per round)
  // — a consumer accumulating deltas (as native mode's fragments require) would
  // otherwise concatenate every round's full reply.
  if (text) opts.callbacks?.onTextDelta?.(text)

  return { text, toolCalls, usage }
}
