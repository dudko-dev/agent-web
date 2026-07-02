# @dudko.dev/agent-web

Headless, **universal**, configurable **in-browser** LLM agent built on the
[Vercel AI SDK](https://ai-sdk.dev). One package drives **any** model from the
browser:

- ☁️ **Cloud providers, bring-your-own-key** — OpenAI, Anthropic, Google, xAI,
  DeepSeek, any OpenAI-compatible server, and the Vercel AI Gateway.
- 🖥️ **Local WebGPU models** — via [WebLLM](https://github.com/mlc-ai/web-llm)
  (`@browser-ai/web-llm`); no server, no key, data never leaves the device.
- 🔌 **Any AI SDK `LanguageModel`** — e.g. Chrome/Edge built-in AI.

It gives you **simple text generation, streaming, native tool-calling, and
structured output**, plus a high-level **plan → execute → replan → synthesize**
agent — with host-defined **tools**, optional **MCP**, **system prompts**,
**IndexedDB** storage, and an **encrypted token vault**. UI-agnostic: it streams
typed events; you render them however you like.

> Browser sibling of the Node package
> [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent).

## Install

```bash
npm install @dudko.dev/agent-web ai zod
```

Then add **only the providers you use** (all optional peers, dynamically
imported):

```bash
# cloud, pick what you need
npm install @ai-sdk/openai        # or @ai-sdk/anthropic, @ai-sdk/google, @ai-sdk/xai, @ai-sdk/deepseek, @ai-sdk/openai-compatible
# local WebGPU models
npm install @browser-ai/web-llm @mlc-ai/web-llm
# optional: HTTP MCP
npm install @modelcontextprotocol/sdk
```

## Quick start — cloud model, bring-your-own-key

Keys are stored **encrypted at rest** (WebCrypto, IndexedDB) and referenced by
id — never inlined into config. See [security](docs/security.md).

```ts
import {
  createAgent,
  defineTool,
  VaultCredentialStore,
} from '@dudko.dev/agent-web'
import { z } from 'zod'

// 1. Store the user's key once (e.g. from a settings form). Encrypted at rest.
const credentials = new VaultCredentialStore()
await credentials.setApiKey('openai', userProvidedKey)

// 2. Tools = your app's actions.
const tools = {
  add_text: defineTool({
    description: 'Add a text block to the page.',
    inputSchema: z.object({ text: z.string(), x: z.number().optional() }),
    execute: async ({ text, x }) => addTextBlock(text, x), // your code
  }),
}

// 3. Create the agent. The key is fetched from the vault at build time.
const agent = await createAgent({
  model: { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'openai' },
  credentials,
  tools,
  describeState: () => serializeMyCanvas(), // optional grounding
})

// 4. Run. Every step is a typed event.
const result = await agent.run('Add a centered title and a totals line', {
  onEvent: (e) => {
    if (e.type === 'plan.created') console.log('plan:', e.plan.steps)
    if (e.type === 'step.tool-call') console.log('tool:', e.name, e.input)
    if (e.type === 'final') console.log('done:', e.text)
  },
})
console.log(result.final, `— ${result.applied} changes`)
```

> **Direct browser calls & CORS:** not every provider allows direct BYOK calls
> from a browser origin. Google (Gemini) and openai-compatible/gateway are the
> reliable direct paths; Anthropic works (a required header is injected for you);
> OpenAI/xAI/DeepSeek usually need a proxy. See
> [docs/providers.md](docs/providers.md).

## Quick start — local WebGPU model (no key, offline)

```ts
import { createAgent, createWebLLMModel, isWebGPUAvailable } from '@dudko.dev/agent-web'

if (!isWebGPUAvailable()) throw new Error('WebGPU required for local models')

const model = await createWebLLMModel('Llama-3.2-3B-Instruct-q4f16_1-MLC', {
  initProgressCallback: (r) => console.log('loading', Math.round(r.progress * 100), '%'),
})

// Local models default to the robust "prompted" tool-mode automatically.
const agent = await createAgent({ model, tools /* ...same as above */ })
await agent.run('Summarize the current page and add a heading')
```

You can also pass a model by spec: `{ providerType: 'web-llm', model: '…' }`.

## Simple generation & tool-calling (no agent loop)

```ts
import { generate, stream, generateStructured, runToolLoop } from '@dudko.dev/agent-web'
import { z } from 'zod'

const { text } = await generate(model, { prompt: 'Write a haiku about WebGPU' })

const { textStream } = stream(model, { prompt: 'Explain IndexedDB' })
for await (const chunk of textStream) process.stdout.write(chunk)

const { object } = await generateStructured(
  model,
  z.object({ title: z.string(), tags: z.array(z.string()) }),
  { prompt: 'Suggest a title and tags for this article: …' },
)

// One round of tool-calling (native or prompted), normalized result:
const { text: reply, toolCalls } = await runToolLoop(model, {
  mode: 'native',
  prompt: 'Add a title',
  tools,
})
```

## Optional: MCP tools over HTTP

```ts
import { connectMcpHttp } from '@dudko.dev/agent-web/mcp'

const mcp = await connectMcpHttp({
  docs: { url: 'https://my-mcp-server.example/mcp', headers: { Authorization: `Bearer ${t}` } },
})
const agent = await createAgent({ model, tools: { ...tools, ...mcp.tools } })
// ... later: await mcp.close()
```

Browsers can only speak the **HTTP (StreamableHTTP)** transport — stdio MCP is
Node-only. The connector lives in the `./mcp` subpath so the MCP SDK never
enters your core bundle.

## Configuration (highlights)

| Option | Default | Purpose |
| --- | --- | --- |
| `model` | — | a `LanguageModel` or `ProviderModelSpec` (the executor/default) |
| `planner` / `synthesizer` | = `model` | per-stage model overrides (inherit base provider/creds if partial) |
| `credentials` | — | a `CredentialStore` for `credentialRef` keys |
| `tools` | `{}` | host tools (`defineTool`) |
| `toolMode` | `'auto'` | `native` \| `prompted` \| `auto` (cloud→native, local→prompted) |
| `systemPrompt` | — | prepended to every phase |
| `describeState` | — | serialize world state into prompt context |
| `memory` | — | `ContextStore` (`IndexedDBStore` / `MemoryStore`) |
| `maxIterations` / `maxStepsPerTask` / `maxRevisions` | 8 / 4 / 2 | loop caps |
| `chatTimeoutMs` | 120000 | per-call watchdog |
| `replan` / `synthesize` | `true` | toggle phases |
| `compressAfterChars` | 12000 | summarize old history past this size |

## Docs

- [docs/design.md](docs/design.md) — architecture & rationale.
- [docs/providers.md](docs/providers.md) — every provider, CORS & direct-vs-proxy.
- [docs/security.md](docs/security.md) — the token vault & its threat model.
- [docs/tasks.md](docs/tasks.md) — status & roadmap.

## License

MIT © Siarhei Dudko
