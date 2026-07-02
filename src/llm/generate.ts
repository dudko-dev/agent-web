import {
  generateObject,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { ZodType } from 'zod'
import { promptOf, timeoutSignal } from './util.js'

/** Options shared by the low-level generation helpers. Provide `prompt` OR `messages`. */
export interface GenerateOptions {
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  tools?: ToolSet
  maxOutputTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  /** Time-box the call; combined with `abortSignal` (0/undefined = no timeout). */
  timeoutMs?: number
}

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
    system: opts.system,
    ...promptOf(opts),
    tools: opts.tools,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
  })

/** Streaming text generation. Returns the AI SDK `streamText` result (`.textStream`, `.fullStream`). */
export const stream = (
  model: LanguageModel,
  opts: GenerateOptions = {},
): ReturnType<typeof streamText> =>
  streamText({
    model,
    system: opts.system,
    ...promptOf(opts),
    tools: opts.tools,
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
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
    system: opts.system,
    ...promptOf(opts),
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
  })
