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

Everything is built on the [Vercel AI SDK](https://ai-sdk.dev) (`ai` v7). The
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

## Why AI SDK v7

The package tracks the current `ai` major (v7) together with the provider
packages and `@browser-ai/*` v3, which peers `ai@^7`. (It was pinned to v6 while
the local-model provider `@browser-ai/web-llm` still peered `ai@^6`; the whole
stack moved together once it shipped v7 support.) v7 also brings what the agent
builds on: the portable `reasoning` setting, `instructions` system messages that
carry provider options (Anthropic cache breakpoints), `prepareStep` for
per-step active tools (tool search), and `toModelOutput` (tool-output caps).

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
│   ├── approval.ts      the consent gate (autopilot / ask-writes / ask-all / read-only)
│   ├── search.ts        searchTools() + find_tools for large catalogues
│   ├── wrap.ts          per-run wrapping: gate, call budget, model-facing output cap
│   └── types.ts         AgentTool / AgentToolSet
├── agent/               the plan→execute→replan→synthesize loop
│   ├── schemas.ts       zod Plan/Replan schemas (native path)
│   ├── planner/executor/replanner/synthesizer.ts
│   ├── runner.ts        createAgent() — orchestration, events, usage accounting
│   ├── internal.ts      per-run state + the prompt/option plumbing the stages share (not public)
│   ├── control.ts       RunControl: say something to a running agent, stop one subagent
│   ├── persistence.ts   run checkpoints (RunSnapshot) for resuming after a reload
│   └── loop-types.ts    IPlan / IStepResult / IUsage
├── memory/              store.ts, sessions.ts (IndexedDBStore), compress.ts (compaction + the
│                        token estimate), runs.ts (IndexedDBRunStore / MemoryRunStore)
├── files/               vfs.ts (VirtualFileSystem on IndexedDB) + tools.ts (the fs_* tools)
├── subagent/            tool.ts (createSubagentTool), worker.ts (serveSubagentWorker), protocol.ts
├── tools/egress.ts      `egress` / `web_fetch`: the model's one way to make a request
├── learning.ts          `learning`: save_skill / forget_skill, the skill stores, the secret scan
├── context-window.ts    the model's real window; compaction, tool search and caps sized to it
├── thinking.ts limits.ts caching.ts skills.ts images.ts   — see docs/capabilities.md
├── llm/context-editing.ts  stale tool results → stubs inside one step's tool loop
├── llm/util.ts          clip / prompt helpers / usageOfError (the spend of a failed structured call)
├── mcp/                 OPTIONAL HTTP MCP connector (./mcp subpath)
│   ├── http.ts          StreamableHTTP connect / mount / refresh
│   └── oauth.ts         OAuth 2.1 + DCR client provider (vault-backed)
├── webmcp/              OPTIONAL bridge to the browser's WebMCP API (./webmcp subpath)
├── parse.ts             robust JSON-salvage parsers (the prompted backbone)
├── prompts.ts           default phase prompts (native + prompted variants)
├── events.ts            AgentEvent union
├── logger.ts            leveled logging onto a console-like sink
├── config.ts            BrowserAgentConfig + resolveConfig + resolveBudgets
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
- **Events** — the full list is the table in
  [capabilities.md](./capabilities.md#event-reference).

No `AsyncLocalStorage`, no filesystem sandbox, no OpenTelemetry — those
Node-only concerns from the sibling are intentionally dropped for the browser.
Run persistence and resume are NOT dropped: see "Resuming" below.

## Resuming an interrupted run

A reload or a crashed tab must not lose finished work, so with `persistence` a
checkpoint is written when the plan is in hand and again after every step
(`RunSnapshot`, in IndexedDB: `IndexedDBRunStore`). `run(goal, { resumeFromRunId })`
continues from the last boundary: the planner does not run again and a finished
step is not repeated. What is deliberately NOT kept: the step that was in flight
(it runs again from its start — so a tool with side effects should be
idempotent, or the consent gate should stay on) and attachments (pass them
again). A hook that throws is logged and the run carries on: persistence is
observability, not a correctness boundary. The hook names match the Node
sibling, where the contract originated.

## Steering a run (`RunControl`)

`run()` returns when the run is over, so a host with something to say mid-run
("use staging instead") had nothing to call. A `RunControl` passed as
`run(goal, { control })` is the handle. A message is **not an interrupt**: the
run never cuts a tool call short (it may be a write); it is held to the next
boundary — the next tool-calling round inside a step, the end of the step, or
just before the answer — and shown to the model there. At a step boundary it
also forces the replanner to look at the plan, because a plan made before the
user spoke may be the wrong one. Whatever never reached the model (the answer
was already being written) comes back as `undelivered`, to be sent as the next
run — nothing the user typed is dropped silently. `stopSubagent(id)` ends one of
several parallel subagents without ending the run.

## Compaction: judged on the whole context

A window fills from three things: the transcript, the run's step log, and the
**fixed prompt** every call carries (stage instructions, the goal and plan, tool
definitions, skills). Judging only the transcript would let a 15k-token tool
catalogue push a call over the window while the "history" looked small. So
compaction is decided on all three together against `thresholdRatio`
(default **85%**) of the window - late enough not to throw away context early,
early enough that the answer and a step's growth still fit; a host-set
`thresholdTokens` wins but is never allowed past 95% of the model's own window.
Under tool search only a few definitions are sent at a time, so the tools count
as a bounded allowance instead of the whole catalogue. The summariser's own input
is capped at 60% of the window, so compacting can never itself overflow.

The estimate (`estimateTokens`) is **calibrated against a real tokenizer and
leans high on purpose**: 1.1-1.4x the count Claude reports for English, code,
JSON and CJK, never below. An estimate that errs low compacts too late and the
provider refuses the prompt; one that errs high compacts a little early, which
costs a summary. It is script-aware (Latin letters, digits, Cyrillic and other
scripts, CJK and emoji, whitespace each weigh differently) and computed in integer thousandths so a fixture sized by it does
not move with float rounding. Do not "fix" it down to look more accurate.

## Usage is counted as it arrives

`agent.usage` / `agent.sessionUsage()` charge every `usage` event the moment it
is emitted (`charge` in the runner), not by summing the result at the end of a
run. A run that throws, is stopped, or ends on a budget breach has still spent
tokens, and an unparsable structured-output attempt (`usageOfError`) is billed
too. Subagent spend is counted once; a manual `compact()` is counted; a resumed
run adds only what *this* process spent after the checkpoint.

## Output caps are shares of the window

A fixed "synthesizer: 400 tokens" cut a normal answer short on a 128k model and
would eat a 4k local model's whole window. The per-call output caps
(`resolveBudgets`) are therefore shares of the window - planner 1/160, executor
3/320, replanner 1/320, synthesizer 3/128, compaction 1/125 - each with a floor
and a ceiling, which gives 800 / 1200 / 400 / 3000 / 1024 at the default 128k
window. A cap the host set (`limits.perCall`, then the legacy `budgets`) wins.

## Egress: off, and bounded by what a page can enforce

The agent has no way to make a request of its own unless `egress` is set; the
provider's API, MCP servers and the host's tools are configuration, not the
model's choice. With it on, the model gets exactly one tool, `web_fetch`, whose
policy has the **same shape and names as the server's `createSafeFetch`**
(`@dudko.dev/agent`) - and the address/pattern core is a copy of the server's, so
the two cannot disagree about what "private" means.

The browser cannot do what the server does: it cannot resolve a name itself, so
it **cannot pin DNS** (a public-looking name that resolves to a private address
is invisible), and it cannot see where a redirect leads. The design answers
honestly rather than pretending: refuse everything decidable *before* the
request (scheme, port, credentials in the URL, host lists, IP literals in every
spelling, names that are internal by shape); fail a redirect by default; send
nothing of the user's (no cookies, referrer or credentials); bound size and time;
treat the result as `untrusted`; and make an open-internet fetch ask like a
write, because the URL itself is a way to leak data. CORS and Private Network
Access are the backstop, and `egress.fetch` lets a host route the request through
a gateway running the real safe fetch. See [security.md](./security.md).

## Learning: a notebook, knowledge never policy

An agent that solves a problem and forgets it solves it again next session.
`learning` gives it `save_skill` / `forget_skill`; a lesson **is a skill**
(`origin.kind: 'learned'`), so the reading side is the machinery that already
exists: it appears in the planner's `SKILLS:` index at once and loads with
`load_skill`. The design choices are all about what a notebook must not become:

- **Knowledge, never policy.** A lesson loads under a header that says it is the
  agent's own hint; the user's request and the host's rules win a conflict. It
  cannot grant a permission or loosen `egress`.
- **Written in the imperative, from what works.** Tested against a real model: a
  diary-style lesson ("I tried X, it failed, then Y") made the next run repeat
  the detour. The tool description asks for what to do next time.
- **Gated like any write**, scanned for secrets, capped in number and size,
  never allowed to overwrite a host-configured skill, and stamped with
  provenance by the harness (not by the model).
- **Its tools stay callable** under `plan-narrowed` and `search` tool selection,
  or a notebook would silently stop working on large catalogues.
- **Off by default**: no extra tools and not a word more in the prompts.

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

**tsup** → `dist/` as ESM + CJS + `.d.ts`, three entries: `.` (core), `./mcp`
(the MCP connector, isolated so `@modelcontextprotocol/sdk` never enters the core
bundle) and `./webmcp` (the WebMCP bridge), plus a standalone browser bundle
`dist/agent-web.js` for a `<script type="module">` tag or a CDN. All model providers, WebLLM, and the MCP SDK are **optional peers**,
imported dynamically — a consumer installs only what they use, and the core
bundle contains **no `node:*`**. Target ES2022, `moduleResolution: Bundler`.

See [`providers.md`](./providers.md) for the provider matrix and the
direct-vs-proxy / CORS guidance.

## Not in scope (the host's job)

- Any UI. The React hook and chat panel are a separate package,
  [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react).
- Domain tools — the host registers its own via `defineTool`.
- stdio MCP — Node-only; browsers get HTTP MCP only.
