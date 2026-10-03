import {
  generateObject,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai'
import type { ZodType } from 'zod'
import type { ProviderOptionsMap, ThinkingLevel } from '../thinking.js'
import { promptOf, timeoutSignal } from './util.js'

/** Options shared by the low-level generation helpers. Provide `prompt` OR `messages`. */
export interface GenerateOptions {
  /** The system prompt — a string, or a SystemModelMessage (e.g. with a cache breakpoint). */
  system?: string | SystemModelMessage
  prompt?: string
  messages?: ModelMessage[]
  tools?: ToolSet
  maxOutputTokens?: number
  temperature?: number
  /** Portable thinking level (see `resolveThinking`). */
  reasoning?: ThinkingLevel
  /** Provider-keyed options (thinking budgets, cache keys, …). */
  providerOptions?: ProviderOptionsMap
  abortSignal?: AbortSignal
  /** Time-box the call; combined with `abortSignal` (0/undefined = no timeout). */
  timeoutMs?: number
}

/** The settings every helper forwards; omits undefined keys the SDK would reject. */
const callSettings = (opts: GenerateOptions) => ({
  ...(opts.system !== undefined ? { instructions: opts.system } : {}),
  maxOutputTokens: opts.maxOutputTokens,
  temperature: opts.temperature,
  ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
  ...(opts.providerOptions ? { providerOptions: opts.providerOptions as never } : {}),
  abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
})

/**
 * One-shot text generation. Thin, provider-agnostic wrapper over the AI SDK's
 * `generateText` — the same call works against a cloud model, a local WebLLM
 * model, or Chrome/Edge built-in AI. Returns the full AI SDK result (`.text`,
 * `.usage`, `.toolCalls`, `.steps`, …).
 */
export const generate = (
  model: LanguageModel,
  opts: GenerateOptions = {},
): ReturnType<typeof generateText> =>
  generateText({
    model,
    ...callSettings(opts),
    ...promptOf(opts),
    tools: opts.tools,
  })

/** Streaming text generation. Returns the AI SDK `streamText` result (`.textStream`, `.fullStream`). */
export const stream = (
  model: LanguageModel,
  opts: GenerateOptions = {},
): ReturnType<typeof streamText> =>
  streamText({
    model,
    ...callSettings(opts),
    ...promptOf(opts),
    tools: opts.tools,
  })

/**
 * Structured output constrained to a Zod schema, via the AI SDK's
 * `generateObject`. Cloud models and WebLLM both support this; tiny local
 * models can be unreliable — the agent's prompted mode is the fallback.
 * Returns the AI SDK result (`.object`, `.usage`).
 */
export const generateStructured = <OBJECT>(
  model: LanguageModel,
  schema: ZodType<OBJECT>,
  opts: GenerateOptions = {},
) =>
  generateObject({
    model,
    schema,
    ...callSettings(opts),
    ...promptOf(opts),
  })
