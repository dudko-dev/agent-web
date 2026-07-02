# Providers

Every model in `@dudko.dev/agent-web` is an AI SDK `LanguageModel`. You supply
one either **directly** (a ready model) or **by spec** (`ProviderModelSpec`),
which the registry resolves by dynamically importing the provider's optional
peer package and fetching the API key from your `CredentialStore`.

```ts
{ providerType, model, baseURL?, credentialRef?, apiKey?, headers?, providerOptions? }
```

## Supported providers

| `providerType` | Peer package | Needs key | `baseURL` | Notes |
| --- | --- | --- | --- | --- |
| `openai` | `@ai-sdk/openai` | yes | optional | See CORS note below. |
| `anthropic` | `@ai-sdk/anthropic` | yes | optional | Browser-access header injected for you. |
| `google` | `@ai-sdk/google` | yes | optional | Gemini; the most reliable **direct** BYOK path. |
| `openai-compatible` | `@ai-sdk/openai-compatible` | yes | **required** | vLLM, Ollama, LM Studio, LocalAI, your proxy… |
| `xai` | `@ai-sdk/xai` | yes | optional | Prefer a proxy from the browser. |
| `deepseek` | `@ai-sdk/deepseek` | yes | optional | Prefer a proxy from the browser. |
| `gateway` | *(ships in `ai`)* | Vercel key | optional | Vercel AI Gateway — recommended for shared keys. |
| `web-llm` | `@browser-ai/web-llm` | **no** | — | Local WebGPU model; resolved via `createWebLLMModel`. |

Passing a **direct** `LanguageModel` bypasses the registry entirely — use this
for Chrome/Edge built-in AI (`@browser-ai/core`, `browserAI()`),
`@browser-ai/transformers-js`, or any custom model.

### Deliberately excluded (Node-only)

`amazon-bedrock` (SigV4 signing), `google-vertex` (ADC via `google-auth-library`),
and `cloudflare` (`workers-ai-provider`, Worker bindings / `process.env`) are not
browser-safe. Gemini is covered by `google`; anything else can be reached through
`openai-compatible` or `gateway` pointed at your own endpoint. Azure folds into
`openai-compatible`.

## The elephant: API keys in a browser + CORS

Two independent facts govern direct BYOK from the browser:

1. **Key exposure.** Any key that reaches the browser is, in principle,
   extractable by the user and by any script on your origin. That is acceptable
   for the **user's own key** (BYOK). It is **never** acceptable for a **shared,
   app-owned key**.
2. **CORS.** Many provider endpoints don't send permissive CORS headers, so a
   direct `fetch` from a browser origin fails regardless of the key.

Practical guidance, exposed programmatically via `directBrowserOk(providerType)`:

- **Direct BYOK works well:** `google`, `openai-compatible`, `gateway`, and
  `anthropic` (the registry adds `anthropic-dangerous-direct-browser-access:
  true`).
- **Direct BYOK is unreliable:** `openai` (`api.openai.com` blocks browser CORS),
  `xai`, `deepseek`. Route these through a proxy.

### Recommended production pattern — proxy or gateway

For **shared** keys, or any provider that blocks browser CORS, don't ship the
key to the client. Point `baseURL` at **your own server** (which injects the real
key server-side), or use the **Vercel AI Gateway**:

```ts
// Your proxy — the key lives on your server, not in the browser.
{ providerType: 'openai-compatible', model: 'gpt-4o-mini', baseURL: 'https://api.myapp.com/llm' }

// Vercel AI Gateway.
{ providerType: 'gateway', model: 'openai/gpt-4o-mini', credentialRef: 'vercel' }
```

## Per-stage models

`model` is the default (executor). `planner` and `synthesizer` accept either a
full `ProviderModelSpec`/direct model, **or** a partial override that inherits
the base provider + credentials and changes only what it sets:

```ts
await createAgent({
  model: { providerType: 'openai', model: 'gpt-4o', credentialRef: 'openai' },
  planner: { model: 'gpt-4o-mini' },        // same provider + key, cheaper model
  synthesizer: {                             // a different provider — must bring its own key
    providerType: 'anthropic', model: 'claude-haiku-4-5', credentialRef: 'anthropic',
  },
  credentials,
})
```

A cross-provider override **without** its own `credentialRef`/`apiKey` throws —
inheriting a key across vendors is almost always a misconfiguration.

## `providerOptions` escape hatch

Anything not covered by the fields above is spread into the provider factory,
e.g. `providerOptions: { fetch: myFetch }`, WebLLM engine settings, etc.

## Bundler notes

Providers are optional peers imported dynamically. If your bundler tries to
eagerly resolve or pre-bundle them, mark the ones you don't install as external
(Vite: `optimizeDeps.exclude` / `build.rollupOptions.external`; webpack:
`externals`). The `./mcp` subpath keeps `@modelcontextprotocol/sdk` out of the
core bundle automatically.
