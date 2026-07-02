import type { LanguageModel } from 'ai'

/** WebGPU feature-detect — WebLLM requires it. Call before offering local models. */
export const isWebGPUAvailable = (): boolean =>
  typeof navigator !== 'undefined' && 'gpu' in navigator

export interface WebLLMModelOptions {
  /**
   * Progress callback for weight download / engine init. `report.progress` is
   * 0..1. Forwarded to WebLLM's `initProgressCallback`.
   */
  initProgressCallback?: (report: { progress: number; text: string }) => void
  /** Any other @browser-ai/web-llm setting (temperature, worker handler, …). */
  [k: string]: unknown
}

/**
 * Build an AI SDK `LanguageModel` backed by WebLLM (WebGPU) via the community
 * provider `@browser-ai/web-llm` (an optional peer, dynamically imported so it
 * is code-split and never loads until a local model is actually used). Accepts
 * any WebLLM prebuilt model id, e.g. "Llama-3.2-3B-Instruct-q4f16_1-MLC".
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
  // webLLM(modelId, settings) returns a LanguageModel. The model id is a strict
  // union in the provider's types; we accept any string and cast at the seam.
  return mod.webLLM(
    model as Parameters<typeof mod.webLLM>[0],
    options as Parameters<typeof mod.webLLM>[1],
  )
}
