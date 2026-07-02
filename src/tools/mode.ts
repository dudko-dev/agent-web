import type { LanguageModel } from 'ai'
import type { ToolMode } from '../config.js'

const modelProviderId = (model: LanguageModel): string =>
  typeof model === 'string' ? model : ((model as { provider?: string }).provider ?? '')

// Local / on-device runtimes whose tiny models are unreliable at native
// function-calling and JSON-schema output — default them to the prompted path.
const LOCAL_RE = /web-?llm|mlc|browser-ai|transformers|nano|built-?in/i

/**
 * Decide the tool-calling strategy for a resolved model. An explicit
 * config.toolMode of 'native'/'prompted' always wins; 'auto' (default) inspects
 * the model's provider id — local/on-device runtimes → 'prompted', cloud → 'native'.
 */
export const selectToolMode = (
  model: LanguageModel,
  mode: ToolMode = 'auto',
): 'native' | 'prompted' => {
  if (mode === 'native' || mode === 'prompted') return mode
  return LOCAL_RE.test(modelProviderId(model)) ? 'prompted' : 'native'
}
