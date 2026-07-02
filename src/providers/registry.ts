import type { LanguageModel } from 'ai'
import type { CredentialStore } from '../secrets/store.js'
import {
  isDirectModel,
  isProviderSpec,
  type ModelInput,
  type ProviderModelSpec,
  type ProviderType,
  type ResolvedStage,
  type StageInput,
  type StageOverride,
} from './types.js'

// Providers whose endpoint the SDK cannot imply and must be given explicitly.
const REQUIRES_BASE_URL: ReadonlySet<ProviderType> = new Set<ProviderType>(['openai-compatible'])

// Providers that authenticate without an API key.
const NO_KEY: ReadonlySet<ProviderType> = new Set<ProviderType>(['web-llm'])

// provider -> npm package for the dynamic import and the "please install X"
// message. `gateway` (ships in `ai`) and `web-llm` (its own adapter) are not here.
const PROVIDER_PACKAGE: Record<Exclude<ProviderType, 'gateway' | 'web-llm'>, string> = {
  openai: '@ai-sdk/openai',
  anthropic: '@ai-sdk/anthropic',
  google: '@ai-sdk/google',
  'openai-compatible': '@ai-sdk/openai-compatible',
  xai: '@ai-sdk/xai',
  deepseek: '@ai-sdk/deepseek',
}

const loadProvider = async <T>(pkg: string): Promise<T> => {
  try {
    // A variable dynamic import of an optional peer. Both bundler hints are
    // required: without `webpackIgnore` webpack emits "Critical dependency:
    // the request of a dependency is an expression" (an error under CI) and
    // tries to build a context module; without `@vite-ignore` Vite warns.
    // Bundlers thus leave the import to the runtime — bundler-less pages map
    // the bare specifier via an import map (see README), and hosts that never
    // use cloud providers (e.g. local WebLLM only) are unaffected.
    return (await import(/* webpackIgnore: true */ /* @vite-ignore */ pkg)) as T
  } catch {
    throw new Error(
      `Provider package "${pkg}" is not installed. Add it to your app: npm install ${pkg}`,
    )
  }
}

const normalizeSpec = (spec: ProviderModelSpec): ProviderModelSpec => {
  if (REQUIRES_BASE_URL.has(spec.providerType) && !spec.baseURL) {
    throw new Error(`provider "${spec.providerType}" requires a baseURL (point it at your server)`)
  }
  return spec
}

/**
 * Resolve one stage to either a ready model or a fully-resolved spec, layering
 * an optional override on the base:
 *  - a direct model (or full spec) override wins outright;
 *  - a partial StageOverride inherits the base provider + credentials, changing
 *    only the fields it sets (e.g. `{ model: 'gpt-4o-mini' }`);
 *  - a full-spec override that switches provider MUST carry its own key
 *    (credentialRef/apiKey) — inheriting a key across vendors is a footgun.
 */
export const resolveStage = (
  base: ModelInput,
  override: StageInput | undefined,
  stageName: string,
): ResolvedStage => {
  if (override !== undefined && isDirectModel(override)) {
    return { type: 'direct', model: override }
  }
  if (override !== undefined && isProviderSpec(override)) {
    if (
      isProviderSpec(base) &&
      override.providerType !== base.providerType &&
      !override.credentialRef &&
      !override.apiKey &&
      !NO_KEY.has(override.providerType)
    ) {
      throw new Error(
        `${stageName}: provider "${override.providerType}" differs from the base "${base.providerType}"; set ${stageName}.credentialRef or apiKey (cross-provider key inheritance is unsafe)`,
      )
    }
    return { type: 'spec', spec: normalizeSpec(override) }
  }

  // No override, or a partial StageOverride to layer onto the base.
  if (isDirectModel(base)) {
    if (override && Object.keys(override).length > 0) {
      throw new Error(
        `${stageName}: cannot layer a partial override onto a direct model — pass a full model or ProviderModelSpec for ${stageName}`,
      )
    }
    return { type: 'direct', model: base }
  }
  if (!isProviderSpec(base)) {
    throw new Error(`${stageName}: base model must be a LanguageModel or a ProviderModelSpec`)
  }

  const ov = (override ?? {}) as StageOverride
  const merged: ProviderModelSpec = {
    providerType: base.providerType,
    model: ov.model ?? base.model,
    baseURL: ov.baseURL ?? base.baseURL,
    credentialRef: ov.credentialRef ?? base.credentialRef,
    apiKey: ov.apiKey ?? base.apiKey,
    headers: ov.headers ?? base.headers,
    providerOptions: ov.providerOptions ?? base.providerOptions,
  }
  return { type: 'spec', spec: normalizeSpec(merged) }
}

const resolveApiKey = async (
  spec: ProviderModelSpec,
  credentials?: CredentialStore,
): Promise<string | undefined> => {
  if (spec.apiKey) {
    console.warn(
      `[agent-web] using an inline apiKey for provider "${spec.providerType}"; prefer credentialRef so the key stays in the encrypted vault`,
    )
    return spec.apiKey
  }
  if (spec.credentialRef) {
    if (!credentials) {
      throw new Error(
        `credentialRef "${spec.credentialRef}" is set but no CredentialStore was provided to the agent`,
      )
    }
    const key = await credentials.getApiKey(spec.credentialRef)
    if (!key) {
      throw new Error(
        `no API key found in the CredentialStore for credentialRef "${spec.credentialRef}"`,
      )
    }
    return key
  }
  return undefined
}

/**
 * Turn a resolved stage into an AI SDK `LanguageModel`. Direct models pass
 * through untouched; specs are built by dynamically importing the provider's
 * optional-peer package and fetching the API key from the CredentialStore.
 */
export const buildModelFromStage = async (
  resolved: ResolvedStage,
  credentials?: CredentialStore,
  clientName = 'agent-web',
): Promise<LanguageModel> => {
  if (resolved.type === 'direct') return resolved.model
  const spec = resolved.spec
  const providerOptions = spec.providerOptions ?? {}
  const apiKey = await resolveApiKey(spec, credentials)

  switch (spec.providerType) {
    case 'web-llm': {
      const { createWebLLMModel } = await import('./webllm.js')
      return createWebLLMModel(spec.model, providerOptions)
    }
    case 'gateway': {
      // The Vercel AI Gateway ships inside `ai` — no separate peer to install.
      const { createGateway } = await import('ai')
      const provider = createGateway({
        baseURL: spec.baseURL || undefined,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'openai': {
      const { createOpenAI } = await loadProvider<typeof import('@ai-sdk/openai')>(
        PROVIDER_PACKAGE.openai,
      )
      const provider = createOpenAI({
        baseURL: spec.baseURL || undefined,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'anthropic': {
      const { createAnthropic } = await loadProvider<typeof import('@ai-sdk/anthropic')>(
        PROVIDER_PACKAGE.anthropic,
      )
      const provider = createAnthropic({
        baseURL: spec.baseURL || undefined,
        apiKey,
        // Anthropic's SDK refuses browser calls unless this opt-in header is
        // set; host headers may override it.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true', ...spec.headers },
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await loadProvider<typeof import('@ai-sdk/google')>(
        PROVIDER_PACKAGE.google,
      )
      const provider = createGoogleGenerativeAI({
        baseURL: spec.baseURL || undefined,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await loadProvider<
        typeof import('@ai-sdk/openai-compatible')
      >(PROVIDER_PACKAGE['openai-compatible'])
      const provider = createOpenAICompatible({
        name: clientName,
        baseURL: spec.baseURL as string,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'xai': {
      const { createXai } = await loadProvider<typeof import('@ai-sdk/xai')>(PROVIDER_PACKAGE.xai)
      const provider = createXai({
        baseURL: spec.baseURL || undefined,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
    case 'deepseek': {
      const { createDeepSeek } = await loadProvider<typeof import('@ai-sdk/deepseek')>(
        PROVIDER_PACKAGE.deepseek,
      )
      const provider = createDeepSeek({
        baseURL: spec.baseURL || undefined,
        apiKey,
        headers: spec.headers,
        ...providerOptions,
      })
      return provider(spec.model)
    }
  }
}

/** Resolve a single ModelInput straight to a LanguageModel (no per-stage layering). */
export const resolveModel = (
  input: ModelInput,
  credentials?: CredentialStore,
  clientName?: string,
): Promise<LanguageModel> =>
  buildModelFromStage(resolveStage(input, undefined, 'model'), credentials, clientName)
