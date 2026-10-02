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
