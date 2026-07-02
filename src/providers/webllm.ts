import { generateText, type LanguageModel } from 'ai'

/** WebGPU feature-detect — WebLLM requires it. Call before offering local models. */
export const isWebGPUAvailable = (): boolean =>
  typeof navigator !== 'undefined' && 'gpu' in navigator

export interface WebLLMModelOptions {
  /**
   * Progress callback for weight download / engine init. `report.progress` is
   * 0..1. Forwarded to WebLLM's `initProgressCallback`.
   */
  initProgressCallback?: (report: { progress: number; text: string }) => void
  /**
   * Download the weights and initialize the engine NOW (default true).
   *
   * The underlying provider initializes lazily on the first generation — with
   * a multi-GB model that means the download would silently happen on the
   * user's first message, with `initProgressCallback` never firing at a moment
   * the host can show it. Preloading runs a 1-token warm-up so the returned
   * model is truly ready and progress is reported during creation. Re-creating
   * an already-downloaded model is fast (weights live in the browser cache).
   *
   * Set to `false` to keep the lazy behavior.
   */
  preload?: boolean
  /** Any other @browser-ai/web-llm setting (temperature, worker handler, …). */
  [k: string]: unknown
}

/**
 * Force a model to download its weights and initialize its engine by running
 * a 1-token generation. Exposed for hosts that create models with
 * `preload: false` and want to warm them up later (e.g. behind their own UI).
 */
export const preloadWebLLMModel = async (model: LanguageModel): Promise<void> => {
  await generateText({ model, prompt: 'ok', maxOutputTokens: 1 })
}

/**
 * Best-effort release of a model's GPU memory (call when switching models —
 * an abandoned engine otherwise holds its buffers until the page reloads).
 *
 * `@browser-ai/web-llm` keeps its MLCEngine private and exposes no public
 * `unload()`, so this reaches into the instance defensively; it is a no-op on
 * an uninitialized model or if the provider's internals change shape.
 */
export const unloadWebLLMModel = async (model: LanguageModel): Promise<void> => {
  const engine = (model as { engine?: { unload?: () => Promise<void> } }).engine
  try {
    await engine?.unload?.()
  } catch {
    /* best-effort */
  }
}

/**
 * Build an AI SDK `LanguageModel` backed by WebLLM (WebGPU) via the community
 * provider `@browser-ai/web-llm` (an optional peer, dynamically imported so it
 * is code-split and never loads until a local model is actually used). Accepts
 * any WebLLM prebuilt model id, e.g. "Llama-3.2-3B-Instruct-q4f16_1-MLC".
 *
 * By default the weights are downloaded eagerly with progress (see
 * `WebLLMModelOptions.preload`).
 */
export const createWebLLMModel = async (
  model: string,
  options?: WebLLMModelOptions,
): Promise<LanguageModel> => {
  let mod: typeof import('@browser-ai/web-llm')
  try {
    mod = await import('@browser-ai/web-llm')
  } catch {
    throw new Error(
      'Local models require "@browser-ai/web-llm" and its peer "@mlc-ai/web-llm". Install: npm install @browser-ai/web-llm @mlc-ai/web-llm',
    )
  }
  const { preload = true, ...settings } = options ?? {}
  // webLLM(modelId, settings) returns a LanguageModel. The model id is a strict
  // union in the provider's types; we accept any string and cast at the seam.
  const languageModel = mod.webLLM(
    model as Parameters<typeof mod.webLLM>[0],
    settings as Parameters<typeof mod.webLLM>[1],
  )
  if (preload) await preloadWebLLMModel(languageModel)
  return languageModel
}
