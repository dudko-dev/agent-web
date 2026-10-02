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

// Local / on-device runtimes: the prompted path is text-only.
const LOCAL_RE = /web-?llm|mlc|browser-ai|transformers|built-?in/i
// Text-only model families under otherwise vision-capable providers.
const TEXT_ONLY_MODEL_RE =
  /gpt-3\.5|o1-mini|o3-mini|deepseek|text-(davinci|embedding)|embedding|babbage|davinci|codestral/i
const VISION_PROVIDER_RE = /^(google|anthropic|openai|azure|xai|vertex|bedrock|gemini)/i
// Providers that read PDFs natively (as file parts).
const PDF_PROVIDER_RE = /^(google|anthropic|openai|azure|vertex|bedrock|gemini)/i

/**
 * Whether a model accepts image input: `true` (expected to), `false` (known
 * not to — local runtimes, DeepSeek, text-only families), or `undefined`
 * (unknown, e.g. an OpenAI-compatible server — the agent tries and turns a
 * provider refusal into a clear error). Override per agent with `vision`.
 */
export const supportsImages = (model: unknown): boolean | undefined => {
  if (typeof model === 'string') {
    // A gateway model id: "provider/model".
    const [provider = '', id = model] = model.includes('/') ? model.split('/', 2) : ['', model]
    if (TEXT_ONLY_MODEL_RE.test(id) || /deepseek/i.test(provider)) return false
    return VISION_PROVIDER_RE.test(provider) ? true : undefined
  }
  if (!model || typeof model !== 'object') return undefined
  const provider = String((model as { provider?: unknown }).provider ?? '')
  const id = String((model as { modelId?: unknown }).modelId ?? '')
  if (LOCAL_RE.test(provider)) return false
  if (/deepseek/i.test(provider) || TEXT_ONLY_MODEL_RE.test(id)) return false
  return VISION_PROVIDER_RE.test(provider) ? true : undefined
}

/**
 * Whether a model reads PDF files natively: `false` for local runtimes and
 * text-only families, `true` for Gemini, Claude and OpenAI's vision models,
 * `undefined` when unknown (tried; a refusal becomes a clear error).
 */
export const supportsPdf = (model: unknown): boolean | undefined => {
  const vision = supportsImages(model)
  if (vision === false) return false
  const provider =
    typeof model === 'string'
      ? (model.split('/')[0] ?? '')
      : String((model as { provider?: unknown } | undefined)?.provider ?? '')
  return PDF_PROVIDER_RE.test(provider) ? true : undefined
}
