/**
 * Thinking (a.k.a. reasoning) activation, portable across providers.
 *
 * The AI SDK exposes a top-level `reasoning` level on every call and translates
 * it to each provider's native API (OpenAI reasoning effort, Anthropic adaptive
 * thinking, Gemini thinking level, …). An exact token budget is not portable,
 * so a `budgetTokens` is mapped to the provider-specific options of the two
 * providers that take one (Anthropic, Google); provider options win over the
 * portable level by the SDK's precedence rules.
 */

export type ThinkingLevel =
  'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface ThinkingConfig {
  /** Portable effort level (default 'medium'). */
  level?: ThinkingLevel
  /** Exact thinking budget — mapped to Anthropic `thinking` / Google `thinkingConfig`. */
  budgetTokens?: number
  /** Stream the model's thoughts where the provider can (default true). */
  includeThoughts?: boolean
}

/**
 * `false`/undefined → leave the provider default alone; `true` → 'medium';
 * a level string → that level; an object → full control.
 */
export type ThinkingSetting = boolean | ThinkingLevel | ThinkingConfig

export type ThinkingStage = 'planner' | 'executor' | 'replanner' | 'synthesizer'

/** Provider-keyed options, the shape of the AI SDK's `providerOptions`. */
export type ProviderOptionsMap = Record<string, Record<string, unknown>>

export interface ResolvedThinking {
  reasoning?: ThinkingLevel
  providerOptions?: ProviderOptionsMap
}

const normalize = (setting: ThinkingSetting | undefined): ThinkingConfig | undefined => {
  if (setting === undefined || setting === false) return undefined
  if (setting === true) return { level: 'medium' }
  if (typeof setting === 'string') return { level: setting }
  return setting
}

/**
 * Turn a thinking setting into call options: the portable `reasoning` level
 * plus the provider-specific extras for an exact budget or streamed thoughts.
 * Pure — unit-tested.
 */
export const resolveThinking = (setting: ThinkingSetting | undefined): ResolvedThinking => {
  const cfg = normalize(setting)
  if (!cfg) return {}
  const level = cfg.level ?? 'medium'
  if (level === 'none') return { reasoning: 'none' }
  const includeThoughts = cfg.includeThoughts !== false
  const budget = cfg.budgetTokens
  if (typeof budget === 'number' && budget > 0) {
    return {
      reasoning: level,
      providerOptions: {
        anthropic: { thinking: { type: 'enabled', budgetTokens: budget } },
        google: { thinkingConfig: { thinkingBudget: budget, includeThoughts } },
      },
    }
  }
  if (!includeThoughts) return { reasoning: level }
  return {
    reasoning: level,
    providerOptions: {
      google: { thinkingConfig: { includeThoughts: true } },
      openai: { reasoningSummary: 'auto' },
    },
  }
}

/** The setting that applies to one stage: a stage entry wins over the top level. */
export const thinkingFor = (
  stage: ThinkingStage,
  top: ThinkingSetting | undefined,
  perStage: Partial<Record<ThinkingStage, ThinkingSetting>> | undefined,
): ThinkingSetting | undefined => (perStage && stage in perStage ? perStage[stage] : top)

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const deepMerge = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(out[k]) && isPlainObject(v) ? deepMerge(out[k], v) : v
  }
  return out
}

/**
 * Deep-merge provider-option maps left to right (later wins). Returns undefined
 * when there is nothing to send, so callers can spread it unconditionally.
 */
export const mergeProviderOptions = (
  ...maps: (ProviderOptionsMap | undefined)[]
): ProviderOptionsMap | undefined => {
  let out: Record<string, unknown> | undefined
  for (const m of maps) {
    if (!m || Object.keys(m).length === 0) continue
    out = out ? deepMerge(out, m) : { ...m }
  }
  return out as ProviderOptionsMap | undefined
}
