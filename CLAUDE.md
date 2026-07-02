# @dudko.dev/agent-web — instructions for Claude

Headless, UI-agnostic, **universal in-browser** LLM agent built on the **Vercel
AI SDK** (`ai` v6). One package drives cloud providers (bring-your-own-key),
local WebGPU/WebLLM models, and any AI SDK `LanguageModel` (e.g. Chrome/Edge
built-in AI). It exposes low-level primitives (generate/stream/tool-loop/
structured output) and a high-level **plan → execute → replan → synthesize**
agent. Browser sibling of the Node package `@dudko.dev/agent` — shared shapes,
separate packages.

See [docs/design.md](docs/design.md) for the architecture and the rationale
behind every decision.

## Principles

- **The model is the only seam.** Everything accepts an AI SDK `LanguageModel`,
  supplied directly or via a `ProviderModelSpec` the registry resolves.
- **No UI, no framework, no `node:*` in the core bundle.** Streams typed
  `AgentEvent`s, returns a `RunResult`. Browser Web APIs (IndexedDB, WebGPU,
  WebCrypto) are fine.
- **Two tool-modes over one tool shape.** Native function-calling / structured
  output for capable models; a prompted JSON-salvage fallback (`parse.ts`) for
  tiny local models. `selectToolMode` picks per model.
- **Everything configurable**: models per stage, providers, credentials, tools,
  MCP, prompts, budgets, timeouts, iteration caps, replan/synthesize, memory.
- **Secrets encrypted at rest.** A non-extractable WebCrypto AES-GCM key in
  IndexedDB; API keys never inlined into config. BYOK only — shared keys go
  through a proxy/gateway (see docs/security.md).
- **Optional peers, imported dynamically.** `@ai-sdk/*`, `@browser-ai/*`,
  `@modelcontextprotocol/sdk`, `@mlc-ai/web-llm` — external in the bundle so
  hosts install and code-split only what they use. `ai`, `zod`, `idb` are deps.
- Pinned to **AI SDK v6** because `@browser-ai/web-llm` peers `ai@^6`.

## Layout

- `src/providers/` — `types`, `registry` (resolveStage/buildModelFromStage),
  `webllm`, `capabilities`.
- `src/secrets/` — `crypto` (AES-GCM key), `vault` (IndexedDBVault),
  `store` (CredentialStore).
- `src/storage/db.ts` — the single IndexedDB owner (keys/secrets/sessions).
- `src/llm/` — `generate`/`stream`/`generateStructured`, `tool-loop`.
- `src/tools/` — `define`, `prompted` (catalog + dispatch), `mode`, `types`.
- `src/agent/` — `schemas`, `planner`/`executor`/`replanner`/`synthesizer`,
  `runner` (createAgent), `loop-types`.
- `src/memory/` — `store`, `sessions` (IndexedDBStore), `compress`.
- `src/mcp/` — optional HTTP connector (`./mcp` subpath).
- `src/{parse,prompts,events,config,index}.ts`.
- `tests/` — `node --test` with `--experimental-strip-types` (Node ≥ 22.6);
  tests import from `dist` (pretest builds).

## Commands

```bash
npm run typecheck     # tsc --noEmit
npm run format:check  # prettier
npm run build         # tsup → dist (ESM + CJS + d.ts; entries: ., ./mcp)
npm test              # node --test tests/*.test.ts (builds first)
```

CI (`.github/workflows/test.yml`) runs typecheck → format:check → build → test.
Release (`release.yml`) publishes to npm via Trusted Publishing after CI passes
on `main`. Keep all four green before pushing.

## Conventions

- Prettier: no semicolons, single quotes, trailing commas, width 100.
- Keep the core free of DOM-UI, framework, and `node:*` imports. Use
  `globalThis.crypto` (WebCrypto), never `node:crypto`. Anything Node-only
  (stdio MCP, fs) belongs in the sibling package, not here.
- New providers: add to the `ProviderType` union + `PROVIDER_PACKAGE` map +
  the `buildModelFromStage` switch, and declare the peer as optional.
