import type { LanguageModel } from 'ai'

/**
 * Providers the browser registry can resolve from a spec. This is deliberately
 * a browser-safe subset of the Node sibling's list: Amazon Bedrock (SigV4
 * signing), Google Vertex (ADC via google-auth-library) and Cloudflare
 * (Worker bindings / process.env) are Node-only and omitted; Azure folds into
 * `openai-compatible`. `web-llm` is the local WebGPU pseudo-provider (no API
 * key). Any other runtime — Chrome/Edge built-in AI, a custom LanguageModel —
 * is passed to the agent directly and never touches this registry.
 */
export type ProviderType =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'openai-compatible'
  | 'xai'
  | 'deepseek'
  | 'gateway'
  | 'web-llm'

/** A model described by provider + id, resolved through the registry (+ vault). */
export interface ProviderModelSpec {
  providerType: ProviderType
  /** Model id, e.g. "gpt-4o-mini", "claude-haiku-4-5", "Llama-3.2-3B-Instruct-q4f16_1-MLC". */
  model: string
  /** Provider endpoint override. Required for `openai-compatible`; a proxy URL for the rest. */
  baseURL?: string
  /** Id under which the API key is stored in the CredentialStore / vault. Preferred. */
  credentialRef?: string
  /**
   * Dev-only inline API key. Prefer `credentialRef` so the key lives encrypted
   * in the vault, not on a long-lived config object. Using this logs a warning.
   */
  apiKey?: string
  /** Extra request headers merged into the provider factory (e.g. a proxy auth header). */
  headers?: Record<string, string>
  /** Escape hatch spread into the SDK factory after baseURL / apiKey / headers. */
  providerOptions?: Record<string, unknown>
}

/**
 * A per-stage override that inherits the base provider + credentials and
 * changes only the fields it sets (typically just `model`). Distinguished from
 * a full ProviderModelSpec by the absence of `providerType`.
 */
export interface StageOverride {
  model?: string
  baseURL?: string
  credentialRef?: string
  apiKey?: string
  headers?: Record<string, string>
  providerOptions?: Record<string, unknown>
}

/** What a caller hands us for a model: a ready AI SDK model, or a spec to resolve. */
export type ModelInput = LanguageModel | ProviderModelSpec

/** A model input, plus the partial-override form usable for per-stage layering. */
export type StageInput = ModelInput | StageOverride

/** Outcome of resolving one stage: either a ready model, or a fully-resolved spec. */
export type ResolvedStage =
  { type: 'direct'; model: LanguageModel } | { type: 'spec'; spec: ProviderModelSpec }

/** True for a ready AI SDK model: a gateway model-id string or a LanguageModelV* object. */
export const isDirectModel = (m: unknown): m is LanguageModel =>
  typeof m === 'string' || (typeof m === 'object' && m !== null && 'specificationVersion' in m)

/** True for a full provider spec (carries the `providerType` discriminator). */
export const isProviderSpec = (m: unknown): m is ProviderModelSpec =>
  typeof m === 'object' &&
  m !== null &&
  !isDirectModel(m) &&
  typeof (m as { providerType?: unknown }).providerType === 'string'
