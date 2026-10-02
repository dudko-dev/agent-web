import type { SystemModelMessage } from 'ai'
import type { ProviderOptionsMap } from './thinking.js'

/**
 * Prompt caching. Every stage's SYSTEM prompt holds only run-stable content
 * (role, domain context, skills, tool catalogue) and the dynamic parts go to
 * the user prompt — so OpenAI's and Gemini's automatic prefix caches hit.
 * Anthropic caches only behind an explicit breakpoint, placed on the system
 * message; OpenAI additionally routes by `promptCacheKey`. Other providers
 * ignore option keys that are not theirs.
 */
export type PromptCachingSetting = boolean | { ttl?: '5m' | '1h'; key?: string }

export interface ResolvedCaching {
  enabled: boolean
  ttl?: '5m' | '1h'
  key?: string
}

export const resolveCaching = (s: PromptCachingSetting | undefined): ResolvedCaching => {
  if (s === false) return { enabled: false }
  if (s === undefined || s === true) return { enabled: true }
  return { enabled: true, ttl: s.ttl, key: s.key }
}

/** The system prompt as the AI SDK `instructions`, with a cache breakpoint when enabled. */
export const cachedInstructions = (
  system: string,
  caching: ResolvedCaching,
): string | SystemModelMessage =>
  caching.enabled
    ? {
        role: 'system',
        content: system,
        providerOptions: {
          anthropic: {
            cacheControl: { type: 'ephemeral', ...(caching.ttl ? { ttl: caching.ttl } : {}) },
          },
        },
      }
    : system

/** Call-level provider options for caching (OpenAI cache routing key). */
export const cachingProviderOptions = (
  caching: ResolvedCaching,
  clientName: string,
  stage: string,
): ProviderOptionsMap | undefined =>
  caching.enabled
    ? { openai: { promptCacheKey: caching.key ?? `${clientName}:${stage}` } }
    : undefined

/** An Anthropic cache breakpoint (other providers ignore the key). */
const breakpoint = (ttl?: '5m' | '1h') => ({
  anthropic: { cacheControl: { type: 'ephemeral' as const, ...(ttl ? { ttl } : {}) } },
})

/** The message without an Anthropic breakpoint (other provider options kept). */
const withoutBreakpoint = <M extends { providerOptions?: unknown }>(m: M): M => {
  const own = m.providerOptions as Record<string, Record<string, unknown>> | undefined
  if (!own?.anthropic || !('cacheControl' in own.anthropic)) return m
  const { cacheControl: _drop, ...anthropic } = own.anthropic
  const { anthropic: _old, ...rest } = own
  const providerOptions = Object.keys(anthropic).length ? { ...rest, anthropic } : rest
  const { providerOptions: _po, ...base } = m as M & { providerOptions?: unknown }
  return (Object.keys(providerOptions).length ? { ...base, providerOptions } : base) as M
}

/**
 * The conversation with a rolling cache breakpoint on its LAST message — the
 * agent-loop pattern Claude Code uses: every tool-calling round re-sends the
 * rounds before it, and with the breakpoint moved to the newest message each
 * request reads all of them from the cache and writes only the new tail.
 * Earlier message breakpoints are removed (the SDK carries a round's messages
 * into the next one), so a request holds at most two: system + newest —
 * Anthropic rejects more than four.
 */
export const withRollingBreakpoint = <M extends { providerOptions?: unknown }>(
  messages: M[],
  caching: ResolvedCaching,
): M[] => {
  if (!caching.enabled || messages.length === 0) return messages
  const out = messages.map((m, i) => (i < messages.length - 1 ? withoutBreakpoint(m) : m))
  const last = out[out.length - 1]
  const own = (last.providerOptions ?? {}) as Record<string, Record<string, unknown>>
  out[out.length - 1] = {
    ...last,
    providerOptions: {
      ...own,
      anthropic: { ...own.anthropic, ...breakpoint(caching.ttl).anthropic },
    },
  }
  return out
}
