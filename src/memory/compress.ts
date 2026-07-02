import type { LanguageModel } from 'ai'
import { generate } from '../llm/generate.js'
import type { StoredMessage } from './store.js'

export interface CompressOptions {
  /** Compress once the transcript exceeds this many characters (0 = never). */
  maxChars?: number
  /** How many most-recent messages to keep verbatim. */
  keepRecent?: number
  /** Time-box the summarisation call so it can never hang the caller. */
  timeoutMs?: number
  abortSignal?: AbortSignal
}

const totalChars = (msgs: StoredMessage[]): number => msgs.reduce((n, m) => n + m.content.length, 0)

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
  const maxChars = opts.maxChars ?? 12_000
  const keepRecent = opts.keepRecent ?? 6
  if (maxChars <= 0 || messages.length <= keepRecent + 1 || totalChars(messages) <= maxChars) {
    return messages
  }
  const head = messages.slice(0, messages.length - keepRecent)
  const tail = messages.slice(messages.length - keepRecent)
  const transcript = head
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 8000)
  try {
    const result = await generate(model, {
      system:
        'Summarize the following conversation into a compact set of durable facts and decisions. Output plain text only.',
      prompt: transcript,
      maxOutputTokens: 400,
      timeoutMs: opts.timeoutMs,
      abortSignal: opts.abortSignal,
    })
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
