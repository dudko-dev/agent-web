import { asSchema, type ToolSet } from 'ai'
import { modelLabel } from './images.js'
import {
  estimateTokens,
  type CompactionConfig,
  type ResolvedCompaction,
} from './memory/compress.js'

/**
 * The model's context window is a hard limit: a prompt that does not fit is
 * refused outright (WebLLM: "Prompt tokens exceed context window size"). The
 * agent sizes everything that grows — compaction thresholds, tool-result
 * clearing, the cap on one tool result, whether tools are listed or searched —
 * from the window, so it has to be the model's real one.
 *
 * Cloud windows are large and the host states them (`compaction.
 * contextWindowTokens`); a local WebLLM model's window is small (4096 tokens
 * by default — WebLLM's choice to save VRAM, not the model's limit) and is read
 * from the model itself.
 */

interface WebLLMRecordLike {
  model_id: string
  overrides?: { context_window_size?: number } & Record<string, unknown>
}

/** The shape of a WebLLM `AppConfig` this module touches. */
export interface WebLLMAppConfigLike {
  model_list: WebLLMRecordLike[]
}

/** WebLLM's default window for its prebuilt models. */
export const WEBLLM_DEFAULT_CONTEXT_WINDOW = 4096

/**
 * A copy of a WebLLM app config (e.g. `prebuiltAppConfig` from
 * `@mlc-ai/web-llm`) with one model's context window set. Pass it as
 * `engineConfig.appConfig` when building the model: the weights are the same,
 * only the KV cache (VRAM) grows with the window. Models trained on long
 * contexts (Qwen3, Llama 3.x) take far more than the default 4096; models
 * trained on 4k (Llama 2) don't.
 */
export const withWebLLMContextWindow = <T extends WebLLMAppConfigLike>(
  appConfig: T,
  modelId: string,
  tokens: number,
): T => ({
  ...appConfig,
  model_list: appConfig.model_list.map((r) =>
    r.model_id === modelId
      ? { ...r, overrides: { ...r.overrides, context_window_size: tokens } }
      : r,
  ),
})

interface WebLLMModelLike {
  provider?: string
  modelId?: string
  engine?: {
    loadedModelIdToPipeline?: { get?: (id: string) => { contextWindowSize?: number } | undefined }
  }
  config?: { options?: { engineConfig?: { appConfig?: WebLLMAppConfigLike } } }
}

/**
 * The context window of a WebLLM model (`@browser-ai/web-llm`), or undefined
 * for any other model. Read from the loaded engine when it runs in this
 * thread, else from the app config it was built with, else WebLLM's defaults
 * (1024 for its "-1k" builds, 4096 otherwise). The provider keeps these
 * private, so this reaches in defensively.
 */
export const webLLMContextWindow = (model: unknown): number | undefined => {
  const m = model as WebLLMModelLike | undefined
  if (!m || typeof m !== 'object' || m.provider !== 'web-llm') return undefined
  const id = String(m.modelId ?? '')
  try {
    const live = m.engine?.loadedModelIdToPipeline?.get?.(id)?.contextWindowSize
    if (typeof live === 'number' && live > 0) return live
  } catch {
    /* the engine lives in a worker, or changed shape */
  }
  const record = m.config?.options?.engineConfig?.appConfig?.model_list?.find(
    (r) => r.model_id === id,
  )
  const configured = record?.overrides?.context_window_size
  if (typeof configured === 'number' && configured > 0) return configured
  return /-1k$/i.test(id) ? 1024 : WEBLLM_DEFAULT_CONTEXT_WINDOW
}

/**
 * The model's own context window when it can be known (local models), else
 * undefined: WebLLM's (see above), or the browser's built-in model's
 * (`@browser-ai/core` reports it once its session exists).
 */
export const contextWindowOf = (model: unknown): number | undefined => {
  const webllm = webLLMContextWindow(model)
  if (webllm !== undefined) return webllm
  const m = model as { provider?: string; getContextWindow?: () => number | undefined } | undefined
  if (m && typeof m === 'object' && m.provider === 'browser-ai') {
    try {
      const w = m.getContextWindow?.()
      return typeof w === 'number' && w > 0 ? w : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Fit the compaction settings to the model's window: the window in use is the
 * configured one, never larger than the model's own, and every size derived
 * from it shrinks with it — also a size the host set for a larger window.
 */
export const fitCompactionToWindow = (
  resolved: ResolvedCompaction,
  configured: CompactionConfig | undefined,
  modelWindow: number | undefined,
): ResolvedCompaction => {
  const window = Math.min(
    configured?.contextWindowTokens ?? modelWindow ?? resolved.contextWindowTokens,
    modelWindow ?? Infinity,
  )
  if (window === resolved.contextWindowTokens && modelWindow === undefined) return resolved
  const half = Math.floor(window / 2)
  const quarter = Math.floor(window / 4)
  const clearAfter = configured?.clearToolResultsAfterTokens
  return {
    ...resolved,
    contextWindowTokens: window,
    thresholdTokens: Math.min(configured?.thresholdTokens ?? half, half),
    // 0 = never stays never.
    clearToolResultsAfterTokens: clearAfter === 0 ? 0 : Math.min(clearAfter ?? quarter, quarter),
    // One result may take a quarter of the window (~4 chars per token).
    maxToolOutputChars:
      configured?.maxToolOutputChars === 0
        ? 0
        : Math.min(configured?.maxToolOutputChars ?? 20_000, window),
    // A small window holds fewer verbatim results.
    keepToolResults:
      configured?.keepToolResults ?? Math.max(1, Math.min(3, Math.floor(window / 8192))),
  }
}

/**
 * Estimated tokens of the tool definitions a model is sent (name, description,
 * JSON schema of the input) — for tools natively, or rendered into the prompt.
 */
export const toolDefinitionTokens = async (tools: ToolSet): Promise<number> => {
  const sizes = await Promise.all(
    Object.entries(tools).map(async ([name, t]) => {
      let parameters: unknown
      try {
        parameters = await asSchema(t.inputSchema as never).jsonSchema
      } catch {
        parameters = undefined
      }
      return estimateTokens(JSON.stringify({ name, description: t.description ?? '', parameters }))
    }),
  )
  return sizes.reduce((a, b) => a + b, 0)
}

/** 'auto' switches to tool search once the definitions would take this share of the window. */
export const TOOL_SEARCH_WINDOW_SHARE = 0.25

/** Raised when a prompt does not fit the model's context window. */
export class ContextWindowExceededError extends Error {
  /** The prompt's size as the provider counted it, when it said. */
  readonly promptTokens?: number
  /** The model's window as the provider reported it, when it said. */
  readonly contextWindowTokens?: number
  constructor(model: string, promptTokens?: number, contextWindowTokens?: number) {
    const sizes =
      promptTokens && contextWindowTokens
        ? ` (${promptTokens} tokens; the window is ${contextWindowTokens})`
        : ''
    super(
      `The conversation no longer fits the context window of "${model}"${sizes}. Start a new chat or compact this one, connect fewer tools, or switch to a model with a larger window.`,
    )
    this.name = 'ContextWindowExceededError'
    this.promptTokens = promptTokens
    this.contextWindowTokens = contextWindowTokens
  }

  toJSON(): string {
    return this.message
  }
}

// What providers say when the prompt is too long: WebLLM, OpenAI
// (context_length_exceeded), Anthropic, Gemini, llama.cpp, vLLM / OpenRouter.
const OVERFLOW_RE =
  /prompt tokens exceed context window|context window size|context_length_exceeded|maximum context length|prompt is too long|input token count.*exceeds|exceeds the maximum number of tokens|exceeds the available context size|context length exceeded|too many tokens in (the )?(prompt|input)/i
const WEBLLM_SIZES_RE = /number of prompt tokens:\s*(\d+);\s*context window size:\s*(\d+)/i

/**
 * The clear error to raise when a provider refused a prompt for its length
 * (else undefined) — instead of the provider's raw text.
 */
export const contextOverflowOf = (
  err: unknown,
  model: unknown,
): ContextWindowExceededError | undefined => {
  if (err instanceof ContextWindowExceededError) return err
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  if (!OVERFLOW_RE.test(text)) return undefined
  const sizes = WEBLLM_SIZES_RE.exec(text)
  return new ContextWindowExceededError(
    modelLabel(model),
    sizes ? Number(sizes[1]) : undefined,
    sizes ? Number(sizes[2]) : (webLLMContextWindow(model) ?? undefined),
  )
}
