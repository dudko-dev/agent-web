import type { LanguageModel } from 'ai'
import { generate } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import type { IUsage } from '../agent/loop-types.js'
import type { StoredMessage } from './store.js'

/**
 * Context compaction. A model's window is finite and every token in it is paid
 * for on every call, so long transcripts and long runs are folded into a
 * summary: the oldest material is summarised by a model, the most recent is
 * kept verbatim.
 */
export interface CompactionConfig {
  /** Compact automatically before planning and between steps (default true). */
  auto?: boolean
  /** The model's context window, in tokens (default 128 000). */
  contextWindowTokens?: number
  /**
   * Compact once the estimated context - the fixed prompt (system, tools, skills), the transcript
   * and the run's step log together - exceeds this many tokens. Default: `thresholdRatio` of the
   * window.
   */
  thresholdTokens?: number
  /**
   * The same threshold as a share of the window, 0 < ratio <= 1 (default 0.85). `thresholdTokens`
   * wins when both are set; it follows the window if the model turns out to have a smaller one.
   */
  thresholdRatio?: number
  /** Transcript messages kept verbatim (default 4). */
  keepRecentTurns?: number
  /** Executed steps kept verbatim in the run's trace (default 3). */
  keepRecentSteps?: number
  /** Output cap of a summary call (default 1024). */
  summaryMaxTokens?: number
  /** Cap on ONE tool result as the model sees it, in chars (default 20 000; 0 = no cap). */
  maxToolOutputChars?: number
  /**
   * Inside one step's tool loop: once its context passes this many tokens,
   * replace the oldest tool results with one-line stubs (context editing;
   * default: a quarter of the window; 0 = never).
   */
  clearToolResultsAfterTokens?: number
  /** Most recent tool results kept verbatim when clearing (default 3). */
  keepToolResults?: number
}

export interface ResolvedCompaction {
  auto: boolean
  contextWindowTokens: number
  thresholdTokens: number
  thresholdRatio: number
  keepRecentTurns: number
  keepRecentSteps: number
  summaryMaxTokens: number
  maxToolOutputChars: number
  clearToolResultsAfterTokens: number
  keepToolResults: number
}

/**
 * Compaction starts at this share of the window unless configured. The estimate leans high (see
 * `estimateTokens`), so on a Claude model this is roughly 70-75% really used - the rest is room
 * for the answer and for what one step adds before the next check.
 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.85

const ratioOf = (r: number | undefined): number =>
  typeof r === 'number' && r > 0 && r <= 1 ? r : DEFAULT_COMPACTION_THRESHOLD_RATIO

export const resolveCompaction = (c: CompactionConfig | undefined): ResolvedCompaction => {
  const contextWindowTokens = c?.contextWindowTokens ?? 128_000
  const thresholdRatio = ratioOf(c?.thresholdRatio)
  return {
    auto: c?.auto ?? true,
    contextWindowTokens,
    thresholdTokens: c?.thresholdTokens ?? Math.floor(contextWindowTokens * thresholdRatio),
    thresholdRatio,
    keepRecentTurns: c?.keepRecentTurns ?? 4,
    keepRecentSteps: c?.keepRecentSteps ?? 3,
    summaryMaxTokens: c?.summaryMaxTokens ?? 1024,
    maxToolOutputChars: c?.maxToolOutputChars ?? 20_000,
    clearToolResultsAfterTokens:
      c?.clearToolResultsAfterTokens ?? Math.floor(contextWindowTokens / 4),
    keepToolResults: c?.keepToolResults ?? 3,
  }
}

// Chinese / Japanese / Korean characters and the halves of a surrogate pair (emoji): about a
// token each. Other non-ASCII text (Cyrillic, Greek, accented Latin...) about two characters.
const isWide = (c: number): boolean =>
  (c >= 0x3040 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xd800 && c <= 0xdfff)

/**
 * Cheap, provider-independent token estimate, by kind of character - because text is not one
 * thing: letters run ~2.5 to a token (prose is kinder; code, markdown and JSON are not), digits
 * and punctuation about one each (JSON, tables, ids), a space a quarter, a newline one, other
 * scripts (Russian...) two characters, CJK and emoji one. Calibrated against Claude's tokenizer,
 * the most token-hungry in use, over prose, markdown, code, JSON, a table, Russian and a mix: it
 * comes out 1.1-1.4x the real count and never below it (a flat "4 characters a token" was
 * 0.4-0.7x for everything but Russian). It errs high ON PURPOSE: it decides when to compact, and
 * compacting a little early is cheap while overflowing the window is a failed run. A tokenizer
 * that packs tighter (OpenAI, Gemini) makes it higher still - then raise `thresholdRatio`.
 */
export const estimateTokens = (text: string): number => {
  const s = text ?? ''
  let letters = 0
  let digits = 0
  let spaces = 0
  let newlines = 0
  let punct = 0
  let other = 0
  let wide = 0
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 128) {
      if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90)) letters += 1
      else if (c >= 48 && c <= 57) digits += 1
      else if (c === 32 || c === 9) spaces += 1
      else if (c === 10) newlines += 1
      else punct += 1
    } else if (isWide(c)) wide += 1
    else other += 1
  }
  // In thousandths of a token, so the arithmetic is exact: 1.1 x (letters / 2.5 + digits +
  // punctuation x 1.1 + spaces / 4 + newlines + other / 2 + wide).
  return Math.ceil(
    (440 * letters +
      1100 * digits +
      1210 * punct +
      275 * spaces +
      1100 * newlines +
      550 * other +
      1100 * wide) /
      1000,
  )
}

const messageTokens = (msgs: StoredMessage[]): number =>
  msgs.reduce((n, m) => n + estimateTokens(`${m.role}: ${m.content}\n`), 0)

/**
 * The lines joined, keeping the NEWEST ones that fit `maxTokens` (estimated); with no budget the
 * historical cut: the last 48 000 characters.
 */
const newestWithin = (lines: string[], maxTokens: number | undefined): string => {
  if (maxTokens === undefined) return lines.join('\n').slice(-48_000)
  const kept: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = estimateTokens(lines[i]) + 1
    if (used + t > maxTokens) {
      // A single line larger than the budget: its tail, rather than nothing.
      if (kept.length === 0) kept.push(lines[i].slice(-Math.max(1, maxTokens) * 2))
      break
    }
    kept.unshift(lines[i])
    used += t
  }
  return kept.join('\n')
}

export interface CompressOptions {
  /** Compress once the transcript exceeds this many characters (0 = never). */
  maxChars?: number
  /** Compress once the transcript's estimated tokens exceed this (wins over maxChars). */
  thresholdTokens?: number
  /** How many most-recent messages to keep verbatim. */
  keepRecent?: number
  /** Output cap of the summary call. */
  summaryMaxTokens?: number
  /**
   * The most the summariser is shown, in estimated tokens (the newest part is kept). Default: a
   * fixed 48 000 characters. The agent passes a share of the window, so a long transcript is
   * summarised whole instead of cut to its last few pages first.
   */
  maxInputTokens?: number
  /** Compact even when below the threshold (manual "compact now"). */
  force?: boolean
  /** Time-box the summarisation call so it can never hang the caller. */
  timeoutMs?: number
  abortSignal?: AbortSignal
  /** Receives the summary call's token usage. */
  onUsage?: (usage: IUsage) => void
}

const SUMMARY_SYSTEM =
  'Summarize the following conversation into a compact set of durable facts, decisions, ' +
  'identifiers, open tasks and user preferences. Keep names, numbers and IDs verbatim. ' +
  'Output plain text only.'

/**
 * When the transcript grows too long, summarise everything except the last
 * `keepRecent` messages into a single system message (via the model), so the
 * session stays within the model's context window. Returns the same array
 * unchanged when no compression is needed; never throws.
 */
export const compressHistory = async (
  messages: StoredMessage[],
  model: LanguageModel,
  opts: CompressOptions = {},
): Promise<StoredMessage[]> => {
  const keepRecent = opts.keepRecent ?? 6
  if (messages.length <= keepRecent + 1) return messages
  if (!opts.force) {
    if (opts.thresholdTokens !== undefined) {
      if (opts.thresholdTokens <= 0 || messageTokens(messages) <= opts.thresholdTokens) {
        return messages
      }
    } else {
      const maxChars = opts.maxChars ?? 12_000
      const chars = messages.reduce((n, m) => n + m.content.length, 0)
      if (maxChars <= 0 || chars <= maxChars) return messages
    }
  }
  const head = messages.slice(0, messages.length - keepRecent)
  const tail = messages.slice(messages.length - keepRecent)
  // The newest part of the head matters most; keep the tail end of it when it
  // has to be cut to fit the summariser's own window.
  const transcript = newestWithin(
    head.map((m) => `${m.role}: ${m.content}`),
    opts.maxInputTokens,
  )
  try {
    const result = await generate(model, {
      system: SUMMARY_SYSTEM,
      prompt: transcript,
      maxOutputTokens: opts.summaryMaxTokens ?? 400,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    })
    opts.onUsage?.(normalizeUsage(result.usage))
    const clean = (result.text || '').trim()
    if (!clean) return messages
    const summaryMsg: StoredMessage = {
      role: 'system',
      content: `Summary of earlier conversation:\n${clean}`,
      ts: head[0]?.ts,
    }
    return [summaryMsg, ...tail]
  } catch {
    return messages
  }
}

/** Alias with the sibling package's name; same behaviour as compressHistory. */
export const compactHistory = compressHistory

const TRACE_SYSTEM =
  'Summarize these completed agent steps into a compact progress note: what was done, ' +
  'what was found (keep names, numbers and IDs verbatim) and what failed. Plain text only.'

/**
 * Fold the oldest entries of a run's step log into one summary entry, keeping
 * the last `keepRecent` verbatim. Returns the input unchanged when it fits the
 * threshold or on any failure; never throws.
 */
export const compactSteps = async (
  done: string[],
  model: LanguageModel,
  opts: CompressOptions & { thresholdTokens: number },
): Promise<string[]> => {
  const keepRecent = opts.keepRecent ?? 3
  if (done.length <= keepRecent + 1) return done
  if (!opts.force && estimateTokens(done.join('\n')) <= opts.thresholdTokens) return done
  const head = done.slice(0, done.length - keepRecent)
  try {
    const result = await generate(model, {
      system: TRACE_SYSTEM,
      prompt: newestWithin(
        head.map((d, i) => `${i + 1}. ${d}`),
        opts.maxInputTokens ?? 1e9,
      ),
      maxOutputTokens: opts.summaryMaxTokens ?? 600,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    })
    opts.onUsage?.(normalizeUsage(result.usage))
    const clean = (result.text || '').trim()
    if (!clean) return done
    return [`Summary of ${head.length} earlier step(s): ${clean}`, ...done.slice(head.length)]
  } catch {
    return done
  }
}

export { messageTokens as estimateMessagesTokens }
