# Tasks & roadmap

Status of the work. See [design.md](./design.md) for the architecture,
[providers.md](./providers.md) for the provider matrix, and
[security.md](./security.md) for the token vault.

## Done — universal rebuild (on the Vercel AI SDK)

- [x] **Model substrate** — everything is an AI SDK `LanguageModel`. Supply a
      model directly, or by `ProviderModelSpec` resolved through the registry.
- [x] **Provider registry** — `openai · anthropic · google · openai-compatible ·
      xai · deepseek · gateway` (dynamic optional-peer imports) + `web-llm`
      local; per-stage overrides with a cross-provider key guard; Anthropic
      browser header injected; `directBrowserOk` hints.
- [x] **Local models** — `createWebLLMModel` (WebGPU, `@browser-ai/web-llm`),
      `isWebGPUAvailable`; any custom model (incl. Chrome/Edge built-in AI) works
      by passing it directly.
- [x] **Secure token vault** — non-extractable AES-GCM key in IndexedDB;
      secrets encrypted at rest; `CredentialStore` (Vault + Memory).
- [x] **Low-level primitives** — `generate` / `stream` / `generateStructured` /
      `runToolLoop`.
- [x] **Tools** — `defineTool` (one AI SDK `ToolSet` shape); native tool-calling
      **and** a prompted/salvage fallback for weak local models; `selectToolMode`.
- [x] **Agent loop** — `createAgent().run()`: plan → execute → replan →
      synthesize, grounded, time-boxed, `AbortSignal`, typed events; graceful
      native→prompted degradation.
- [x] **Memory** — `ContextStore` + `MemoryStore` + `IndexedDBStore` (session
      list/delete) + `compressHistory`.
- [x] **MCP** — optional `./mcp` subpath: HTTP (StreamableHTTP) connector.
- [x] **Packaging** — tsup ESM + CJS + d.ts, `.`/`./mcp` entries, optional peers,
      **no `node:*` in the core bundle**.
- [x] **Tests** — `node --test`: registry resolution, vault crypto round-trip
      (fake-indexeddb), parsers, prompts, tool-mode, prompted dispatch, and a
      full prompted end-to-end run via `MockLanguageModelV3`.

## Next

- [ ] **`./react` subpath** — a `useAgent` hook (kept out of core to stay
      UI-agnostic).
- [ ] **Streaming structured plan** — surface `plan.thought-delta` /
      `plan.step-added` from a streamed `generateObject`.
- [ ] **Model-load events** — wire WebLLM download progress to `model.load`
      automatically (today: pass `initProgressCallback` via `providerOptions`).
- [ ] **AI SDK v7** — bump once `@browser-ai/web-llm` supports the v7 provider spec.
- [ ] **MCP niceties** — `tools/list_changed` refresh; per-tool allow/deny filter.
- [ ] **Examples** — a vanilla-JS demo and a React demo (cloud BYOK + local WebLLM).
- [ ] **OPFS/Blob tool outputs** — optional spill target for binary MCP results.

## Non-goals

- Built-in UI (chat panel, components) — belongs in host apps.
- Domain-specific tools — hosts register their own via `defineTool`.
- stdio MCP, filesystem sandbox, run persistence/resume, OpenTelemetry — Node-only
  concerns that live in the sibling package `@dudko.dev/agent`.
- Shipping shared/app-owned API keys to the client — use a proxy or the gateway
  (see [security.md](./security.md)).
