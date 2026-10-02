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
  /** Compact once the estimated context exceeds this (default: half the window). */
  thresholdTokens?: number
  /** Transcript messages kept verbatim (default 4). */
  keepRecentTurns?: number
  /** Executed steps kept verbatim in the run's trace (default 3). */
  keepRecentSteps?: number
  /** Output cap of a summary call (default 1024). */
  summaryMaxTokens?: number
  /** Cap on ONE tool result as the model sees it, in chars (default 20 000; 0 = no cap). */
  maxToolOutputChars?: number
}

export interface ResolvedCompaction {
  auto: boolean
  contextWindowTokens: number
  thresholdTokens: number
  keepRecentTurns: number
  keepRecentSteps: number
  summaryMaxTokens: number
  maxToolOutputChars: number
}

export const resolveCompaction = (c: CompactionConfig | undefined): ResolvedCompaction => {
  const contextWindowTokens = c?.contextWindowTokens ?? 128_000
  return {
    auto: c?.auto ?? true,
    contextWindowTokens,
    thresholdTokens: c?.thresholdTokens ?? Math.floor(contextWindowTokens / 2),
    keepRecentTurns: c?.keepRecentTurns ?? 4,
    keepRecentSteps: c?.keepRecentSteps ?? 3,
    summaryMaxTokens: c?.summaryMaxTokens ?? 1024,
    maxToolOutputChars: c?.maxToolOutputChars ?? 20_000,
  }
}

/** Cheap, provider-independent token estimate (~4 chars per token). */
export const estimateTokens = (text: string): number => Math.ceil((text ?? '').length / 4)

const messageTokens = (msgs: StoredMessage[]): number =>
  msgs.reduce((n, m) => n + estimateTokens(`${m.role}: ${m.content}\n`), 0)

export interface CompressOptions {
  /** Compress once the transcript exceeds this many characters (0 = never). */
  maxChars?: number
  /** Compress once the transcript's estimated tokens exceed this (wins over maxChars). */
  thresholdTokens?: number
  /** How many most-recent messages to keep verbatim. */
  keepRecent?: number
  /** Output cap of the summary call. */
  summaryMaxTokens?: number
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
  const transcript = head
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(-48_000)
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
      prompt: head.map((d, i) => `${i + 1}. ${d}`).join('\n'),
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
