import type { ProviderType } from './types.js'

// Cloud providers are reliable at native function-calling and JSON-schema
// structured output. Local WebGPU models (web-llm) technically support both,
// but tiny (1–3B) models are unreliable at them, so we default local models to
// the prompted/salvage path (overridable via config.toolMode).
const CLOUD: ReadonlySet<ProviderType> = new Set<ProviderType>([
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
  'xai',
  'deepseek',
  'gateway',
])

/** Whether native tool-calling is reliable enough to be the default for a provider. */
export const supportsNativeTools = (p: ProviderType): boolean => CLOUD.has(p)

/** Whether native structured output (generateObject) is the default for a provider. */
export const supportsStructuredOutput = (p: ProviderType): boolean => CLOUD.has(p)

/**
 * Whether calling this provider straight from a browser origin with a BYOK key
 * is expected to work (CORS + browser-access policy). Hosts can use this to
 * warn users before a direct call fails.
 *
 * - `google`: Gemini's endpoint is CORS-enabled — the most reliable direct BYOK path.
 * - `gateway` / `openai-compatible`: the host controls the endpoint / CORS.
 * - `anthropic`: works, but only with the direct-browser-access header, which
 *   the registry injects automatically.
 * - `openai`: api.openai.com does NOT reliably send CORS for browser calls —
 *   route through a proxy `baseURL` or the gateway.
 * - `xai` / `deepseek`: unreliable from the browser; prefer a proxy.
 */
export const directBrowserOk = (p: ProviderType): boolean =>
  p === 'google' || p === 'gateway' || p === 'openai-compatible' || p === 'anthropic'
