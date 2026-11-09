# Tasks & roadmap

Status of the work. See [design.md](./design.md) for the architecture,
[providers.md](./providers.md) for the provider matrix, and
[security.md](./security.md) for the token vault, egress and learning.

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
      list/delete) + `compressHistory`; recent turns are read back into the
      planner prompt so follow-up goals can reference earlier ones.
- [x] **Tool filtering** — `availableTools` whitelist / `excludedTools`
      blacklist; `plan-narrowed` selection honoured on both tool paths.
- [x] **Streaming final answer** — the synthesizer streams `final.text-delta`
      (suppressed when the model drifts into JSON).
- [x] **MCP** — optional `./mcp` subpath: HTTP (StreamableHTTP) connector.
- [x] **Packaging** — tsup ESM + CJS + d.ts, `.`/`./mcp` entries, optional peers,
      **no `node:*` in the core bundle**.
- [x] **Tests** — `node --test`: registry resolution, vault crypto round-trip
      (fake-indexeddb), parsers, prompts, tool-mode, prompted dispatch, and a
      full prompted end-to-end run via `MockLanguageModelV3`.

## Added after the universal rebuild

- [x] **Eager model preload** — `createWebLLMModel` now defaults to
      `preload: true` (1-token warm-up), so weights download during creation
      with `initProgressCallback` firing, not silently on the first message;
      `preloadWebLLMModel` / `unloadWebLLMModel` helpers exported (the latter
      frees GPU memory best-effort when switching models).
- [x] **Leveled logger** — `logLevel` ('silent'|'error'|'warn'|'info'|'debug',
      default 'warn') + console-like `logger` sink in the config; phases log
      raw outputs (debug), plans/steps/tool calls (info), empty plans, no-tool
      steps, failed tools and salvage fallbacks (warn). `createLogger` exported.
- [x] **Empty-plan retry** — when the planner returns no steps for a multi-word
      goal (small models sometimes reply "done!" with an empty plan and the run
      would claim success without acting), the runner retries once with an
      explicit nudge before treating the turn as conversational.

## Next


- [x] **React bindings** — shipped as a separate package,
      [`@dudko.dev/agent-web-react`](https://www.npmjs.com/package/@dudko.dev/agent-web-react)
      (kept out of core to stay UI-agnostic).
- [x] **Streaming structured plan** — `plan.thought-delta` / `plan.step-added`
      from a streamed structured plan.
- [ ] **Model-load events** — wire WebLLM download progress to `model.load`
      automatically (today: pass `initProgressCallback` via `providerOptions`).
- [x] **AI SDK v7** — the package tracks `ai` v7 with `@browser-ai/*` v3.
- [x] **MCP OAuth** — `authProvider` + `BrowserOAuthProvider`: DCR (RFC 7591),
      PKCE, vault-stored tokens, refresh on 401, proactive refresh on connect.
- [x] **MCP niceties** — `tools/list_changed` notification + `refreshServer()`.
      (Allow/deny filtering stays a host concern: `tools` is a plain object.)
- [x] **React demo** — cloud BYOK, local WebLLM and your own MCP servers
      ([live](https://dudko-dev.github.io/agent-web-react/)).
- [ ] **Vanilla-JS example** — a demo without a framework.
- [ ] **OPFS/Blob tool outputs** — optional spill target for binary MCP results.

## Non-goals

- Built-in UI (chat panel, components) — belongs in host apps.
- Domain-specific tools — hosts register their own via `defineTool`.
- stdio MCP, filesystem sandbox, OpenTelemetry — Node-only concerns that live in
  the sibling package `@dudko.dev/agent`. (Run persistence/resume is NOT one of
  them: the browser has it too, over IndexedDB.)
- Shipping shared/app-owned API keys to the client — use a proxy or the gateway
  (see [security.md](./security.md)).

## Done — agent capabilities (see [capabilities.md](./capabilities.md))

- [x] **Thinking** — `thinking` / `stageThinking` (portable level or exact
      budget), streamed thoughts, reasoning tokens in usage.
- [x] **Token limits** — `limits` (input / output / reasoning / total per run,
      per-call output caps), `maxToolCalls`, `maxPlanSteps`; soft caps that stop
      at the next boundary and still answer.
- [x] **Context** — step results and tool findings flow into later steps and
      the answer; auto + manual compaction (history, run trace); model-facing
      tool-output cap.
- [x] **Prompt caching** — stable system prefixes, Anthropic breakpoints,
      OpenAI cache keys; cached tokens in usage.
- [x] **Skills** — SKILL.md parsing/loading, planner selection, `load_skill` /
      `read_skill_file`.
- [x] **Tool consent** — autopilot / ask-writes / ask-all / read-only, glob
      rules, "always allow", live `setToolApprovalMode`.
- [x] **Large MCP catalogues** — pagination, per-server deadlines, readOnly
      annotations, `search` strategy with `find_tools`.
- [x] **Subagents** — `createSubagentTool` in-process or in a Web Worker
      (`serveSubagentWorker`), proxied host tools under the parent's consent gate.
- [x] **Autonomy** — prompts never ask the user; questions that need data are
      planned as tool work.
- [x] **Attachments** — `run(goal, { images, files })`: images, PDFs, files,
      http(s) URLs as file parts; `agent.capabilities` per kind;
      `AttachmentsNotSupportedError` before any call (known text-only models)
      or from a provider refusal.
- [x] **Virtual file system** — `VirtualFileSystem` (IndexedDB / memory) +
      `createFileTools` (`fs_list` / `fs_read` / `fs_write` / `fs_delete`).

## Done — later additions (see [capabilities.md](./capabilities.md))

- [x] **Resume** — `persistence` (`IndexedDBRunStore` / `MemoryRunStore`) and
      `run(goal, { resumeFromRunId })`, with the same hook names as the Node sibling.
- [x] **Steering** — `RunControl`: `send()` a message to a running agent (delivered
      at the next round / step / final boundary, the replanner re-checks the plan),
      `stopSubagent()`; `undelivered` returns what never reached the model.
- [x] **Subagent profiles** — the parent picks a named profile (model, params,
      context) per call.
- [x] **WebMCP** — the `./webmcp` subpath publishes a `ToolSet` to the page's model
      context and consumes the tools a page registered.
- [x] **Egress** — `egress` / `web_fetch`: off by default, host lists, IP-literal
      and internal-name refusal, no ambient credentials, redirects fail by default;
      the same policy shape as the server's `createSafeFetch`.
- [x] **Learning** — `learning`: `save_skill` / `forget_skill`, lessons are skills
      (`VfsSkillStore` keeps them across sessions), secret scan, caps, provenance.
- [x] **Compaction on the whole context** — the fixed prompt, transcript and step
      log are judged together against 85% of the window, with a calibrated
      (deliberately high) token estimate.
- [x] **Usage** — `agent.usage` / `agent.sessionUsage()`, counted as each `usage`
      event arrives, failed attempts and subagents included.
- [x] **Window-derived caps** — per-call output caps default to shares of the
      model's window (`resolveBudgets`).
