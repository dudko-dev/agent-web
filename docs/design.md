# Design

## Goal

A **headless, UI-agnostic, universal** in-browser LLM agent that any web app can
embed. It runs entirely in the browser and can drive **any** model:

- **Cloud providers via bring-your-own-key (BYOK)** — OpenAI, Anthropic, Google,
  xAI, DeepSeek, any OpenAI-compatible server, and the Vercel AI Gateway.
- **Local WebGPU models** — via [`@browser-ai/web-llm`](https://www.npmjs.com/package/@browser-ai/web-llm)
  (WebLLM), no server and no key.
- **Any AI SDK `LanguageModel`** you hand it — e.g. Chrome/Edge built-in AI
  (`@browser-ai/core`).

It exposes both **low-level primitives** (text generation, streaming,
tool-calling, structured output) and a **high-level agent** that runs a
**plan → execute → replan → synthesize** loop. It stores data in **IndexedDB**
and keeps **API tokens encrypted at rest** in a WebCrypto-backed vault.

It is the browser sibling of the Node package `@dudko.dev/agent`. They
deliberately share shapes (provider-type union, config field names, event
names) but are **separate packages** — Node and browser diverge in exactly the
load-bearing places (credentials, tool I/O, MCP transport, model runtime,
bundling), so unifying them would help nothing and couple two release cadences.

## The one seam: an AI SDK `LanguageModel`

Everything is built on the [Vercel AI SDK](https://ai-sdk.dev) (`ai` v6). The
whole package accepts an AI SDK `LanguageModel`; providers are just different
ways of producing one. You give the agent a model in one of two ways:

1. **Directly** — pass a ready `LanguageModel` (WebLLM, built-in AI, or any
   custom model). It bypasses the registry entirely.
2. **By spec** — pass a `ProviderModelSpec { providerType, model, baseURL?,
   credentialRef?, providerOptions? }`. The registry resolves it, fetching the
   API key from the credential vault **at build time** — a plaintext key never
   lives on the long-lived config object.

Because the model is the only seam, "simple text generation", "tool-calling",
and "structured output" are just thin wrappers over `generateText` /
`streamText` / `generateObject`, and the planning agent sits on top of the same
primitives.

## Why AI SDK v6 (not v7)

The ecosystem's `ai` is at v7, but the local-model provider
`@browser-ai/web-llm` still peers `ai@^6` (it implements the v6/`@ai-sdk/provider@3`
model spec, `specificationVersion: 'v3'`). Since local models are a core
requirement, the whole package is pinned to the **coherent v6 stack**
(`ai@^6`, `@ai-sdk/*` v3/v2, `@browser-ai/web-llm@^2`). When browser-ai ships v7
support we bump together.

## Modules

```text
src/
├── providers/           the universal model layer
│   ├── types.ts         ProviderType, ProviderModelSpec, ModelInput, guards
│   ├── registry.ts      resolveStage() + buildModelFromStage() (dynamic @ai-sdk/* imports)
│   ├── webllm.ts        createWebLLMModel() + isWebGPUAvailable()
│   └── capabilities.ts  supportsNativeTools / directBrowserOk hints
├── secrets/             the encrypted token vault
│   ├── crypto.ts        non-extractable AES-GCM key in IDB; encryptJSON/decryptJSON
│   ├── vault.ts         IndexedDBVault (secrets encrypted at rest)
│   └── store.ts         CredentialStore + Vault/Memory implementations
├── storage/db.ts        single IndexedDB owner (keys, secrets, sessions stores)
├── llm/                 low-level primitives
│   ├── generate.ts      generate / stream / generateStructured
│   └── tool-loop.ts     runToolLoop() — native OR prompted, one signature
├── tools/               host tools
│   ├── define.ts        defineTool() → an AI SDK tool (+ optional promptHint)
│   ├── prompted.ts      renderCatalog() + dispatch() (the salvage path)
│   ├── mode.ts          selectToolMode() — native vs prompted per model
│   └── types.ts         AgentTool / AgentToolSet
├── agent/               the plan→execute→replan→synthesize loop
│   ├── schemas.ts       zod Plan/Replan schemas (native path)
│   ├── planner/executor/replanner/synthesizer.ts
│   ├── runner.ts        createAgent() — orchestration + events
│   └── loop-types.ts    IPlan / IStepResult / IUsage
├── memory/              store.ts, sessions.ts (IndexedDBStore), compress.ts
├── mcp/http.ts          OPTIONAL HTTP MCP connector (./mcp subpath)
├── parse.ts             robust JSON-salvage parsers (the prompted backbone)
├── prompts.ts           default phase prompts (native + prompted variants)
├── events.ts            AgentEvent union
├── config.ts            BrowserAgentConfig + resolveConfig
└── index.ts             public surface
```

## Two tool-modes (robust on small models)

Cloud models do reliable native function-calling and JSON-schema output. Tiny
in-browser models (1–3B) do not — they wrap JSON in prose, truncate it, or drift
to text. So the agent has two strategies over **one** tool shape (an AI SDK
`ToolSet`):

- **native** — pass the tools straight to `streamText({ tools, stopWhen })`;
  plan via `generateObject(PlanSchema)`.
- **prompted** — render the tool catalogue into the prompt, let the model reply
  with text, and salvage `{ reply, actions }` JSON with `parse.ts`; each action
  is validated against the tool's own `inputSchema` and dispatched to the same
  `execute`. Plan via `parsePlannerResponse`. After a round's actions run, the
  model is shown their `TOOL RESULTS` as a follow-up user turn and may continue
  the same task — so read-tools and failed calls are visible to it — until it
  returns no actions, signals `[BLOCKER]`, re-emits a batch it already ran
  (stutter guard, catches A→B→A oscillation too), or `maxSteps` rounds are spent
  (default 4; `maxSteps: 1` restores single-round). All rounds share ONE
  `chatTimeoutMs` watchdog, so a slow model can't stretch a step to
  `maxSteps × chatTimeoutMs`.

`selectToolMode` picks per model: `toolMode: 'auto'` (default) → cloud = native,
local/on-device = prompted; override with `'native'` / `'prompted'`. Native
failures on the planner/replanner **degrade gracefully** to the prompted parse
instead of throwing.

## The run loop (`agent/runner.ts`)

`plan → (execute step → replan on block/failure)* → synthesize → compress`, with:

- **Intent gate** — an empty plan (greeting/question/unclear) short-circuits to a
  friendly answer; no tools run.
- **Grounded steps** — optional `describeState()` is re-read before each phase so
  the model always sees the real, mutated world.
- **Replan** — by default after a **blocked** step (`[BLOCKER]` sentinel) or an
  **unresolved failed** tool call (a failure a later same-tool call retried is
  not counted); `replanAfter` widens the trigger to `'always'` or a host
  predicate on the step result (e.g. "issues found in my state") — the predicate
  is bounded by the `chatTimeoutMs` watchdog and abort, falling back to the
  failure rule if it throws or hangs. Bounded by `maxIterations` / `maxRevisions`.
- **Watchdog + abort** — every model call is time-boxed (`chatTimeoutMs`, via
  `AbortSignal.timeout`); `RunOptions.signal` cancels between phases.
- **Events** — `run.start · model.load · plan.* · step.* · replan.decision ·
  usage · final · stopped · error`.

No `AsyncLocalStorage`, no filesystem sandbox, no OpenTelemetry, no run
persistence/resume — those Node-only concerns from the sibling are intentionally
dropped for the browser.

## Secrets

API keys are encrypted at rest with a **non-extractable AES-GCM `CryptoKey`**
generated by WebCrypto and stored (as a live, unreadable `CryptoKey`) in
IndexedDB. See [`security.md`](./security.md) for the full threat model — the
short version: this is safe for the **user's own key on their own device**;
**shared/app-owned keys must go through a proxy or the gateway**, never the
client.

## Memory

`ContextStore` persists `{role, content, ts}[]` per `sessionId`.
`IndexedDBStore` (via the shared `storage/db.ts` owner) is the browser default;
`MemoryStore` is the fallback. After a run, if the transcript exceeds
`compressAfterChars`, `compressHistory` summarizes old turns via the synthesizer
model.

## Build & packaging

**tsup** → `dist/` as ESM + CJS + `.d.ts`, two entries: `.` (core) and `./mcp`
(the MCP connector, isolated so `@modelcontextprotocol/sdk` never enters the core
bundle). All model providers, WebLLM, and the MCP SDK are **optional peers**,
imported dynamically — a consumer installs only what they use, and the core
bundle contains **no `node:*`**. Target ES2022, `moduleResolution: Bundler`.

See [`providers.md`](./providers.md) for the provider matrix and the
direct-vs-proxy / CORS guidance.

## Not in scope (the host's job)

- Any UI (React hook, chat panel). A `./react` subpath is reserved for later.
- Domain tools — the host registers its own via `defineTool`.
- stdio MCP — Node-only; browsers get HTTP MCP only.
