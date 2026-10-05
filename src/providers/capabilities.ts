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
 * Checked October 2026 (a preflight from a page origin, then the API's answer):
 *
 * - `google`, `openai`, `xai`, `deepseek`: the APIs send CORS headers.
 * - `anthropic`: works, but only with the direct-browser-access header, which
 *   the registry injects automatically.
 * - `gateway` / `openai-compatible`: the host controls the endpoint / CORS.
 * - `web-llm`: runs in the page — nothing to call.
 */
export const directBrowserOk = (p: ProviderType): boolean => p !== 'web-llm'

// Local / on-device runtimes: text-only, unless the model id names a vision model.
const LOCAL_RE = /web-?llm|mlc|browser-ai|transformers|built-?in/i
const LOCAL_VISION_RE = /vision|[-_]vl\b|[-_]vl[-_]|llava|smolvlm|moondream|gemma-?3n/i
// Text-only model families under otherwise vision-capable providers.
const TEXT_ONLY_MODEL_RE =
  /gpt-3\.5|o1-mini|o3-mini|deepseek|text-(davinci|embedding)|embedding|babbage|davinci|codestral/i
const VISION_PROVIDER_RE =
  /^(google|anthropic|openai|azure|xai|vertex|bedrock|gemini|moonshot|mistral)/i
// Providers that read PDFs natively (as file parts).
const PDF_PROVIDER_RE = /^(google|anthropic|openai|azure|vertex|bedrock|gemini)/i

/**
 * Whether a model accepts image input: `true` (expected to — also a local
 * vision model such as WebLLM's Phi-3.5-vision), `false` (known not to — other
 * local models, DeepSeek, text-only families), or `undefined`
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
  if (LOCAL_RE.test(provider)) return LOCAL_VISION_RE.test(id)
  // DeepSeek's Flash line reads images; the rest of DeepSeek is text-only.
  if (/deepseek/i.test(provider)) return /flash/i.test(id)
  if (TEXT_ONLY_MODEL_RE.test(id)) return false
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
  // A local vision model reads images, not PDFs; Kimi's API takes no PDF parts.
  if (LOCAL_RE.test(provider) || /moonshot/i.test(provider)) return false
  return PDF_PROVIDER_RE.test(provider) ? true : undefined
}
