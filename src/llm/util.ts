import type { ModelMessage } from 'ai'
import type { IUsage } from '../agent/loop-types.js'

/** Truncate to `max` characters, ellipsising the overflow. */
export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max - 1)}…` : s

/**
 * The AI SDK prompt is `{ prompt } XOR { messages }` — passing both keys (even
 * with one undefined) breaks the discriminated union. Pick exactly one.
 */
export const promptOf = (opts: {
  prompt?: string
  messages?: ModelMessage[]
}): { prompt: string } | { messages: ModelMessage[] } =>
  opts.messages ? { messages: opts.messages } : { prompt: opts.prompt ?? '' }

/** Normalise the AI SDK usage shape (fields can be undefined) into IUsage. */
export const normalizeUsage = (u?: {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}): IUsage => {
  const inputTokens = u?.inputTokens ?? 0
  const outputTokens = u?.outputTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    totalTokens: u?.totalTokens ?? inputTokens + outputTokens,
  }
}

/**
 * Combine the caller's AbortSignal with a timeout so a hung generation can't
 * freeze a run. Returns the original signal when no timeout is set. Uses the
 * standard `AbortSignal.timeout`/`AbortSignal.any` (Node ≥ 20, modern browsers).
 */
export const timeoutSignal = (signal?: AbortSignal, ms?: number): AbortSignal | undefined => {
  if (!ms || ms <= 0) return signal
  const timeout = AbortSignal.timeout(ms)
  if (!signal) return timeout
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal
}
