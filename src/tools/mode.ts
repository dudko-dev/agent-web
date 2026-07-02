import type { LanguageModel } from 'ai'
import type { ToolMode } from '../config.js'

// Local / on-device runtimes whose tiny models are unreliable at native
// function-calling and JSON-schema output — default them to the prompted path.
const LOCAL_RE = /web-?llm|mlc|browser-ai|transformers|nano|built-?in/i

/**
 * Decide the tool-calling strategy for a resolved model. An explicit
 * config.toolMode of 'native'/'prompted' always wins; 'auto' (default) inspects
 * the model's provider id — local/on-device runtimes → 'prompted', cloud → 'native'.
 * A string model is a gateway model id ("openai/gpt-4o") — always cloud; the
 * LOCAL_RE must not see it, or model names like "gpt-5-nano" would match `nano`.
 */
export const selectToolMode = (
  model: LanguageModel,
  mode: ToolMode = 'auto',
): 'native' | 'prompted' => {
  if (mode === 'native' || mode === 'prompted') return mode
  if (typeof model === 'string') return 'native'
  const provider = (model as { provider?: string }).provider ?? ''
  return LOCAL_RE.test(provider) ? 'prompted' : 'native'
}
