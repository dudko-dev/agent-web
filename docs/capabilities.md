# Agent capabilities

Everything the agent loop does beyond "plan → execute → replan → synthesize":
thinking, token budgets, context compaction, skills, tool consent and
autopilot, large MCP catalogues, prompt caching, subagents and autonomy. The
Node sibling [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent)
implements the same features with the same field and event names.

- [Thinking](#thinking)
- [Token limits and step caps](#token-limits-and-step-caps)
- [Context management and compaction](#context-management-and-compaction)
- [Prompt caching](#prompt-caching)
- [Skills](#skills)
- [Tool consent and autopilot](#tool-consent-and-autopilot)
- [Large tool catalogues (several MCP servers)](#large-tool-catalogues-several-mcp-servers)
- [Subagents (in-process or Web Workers)](#subagents-in-process-or-web-workers)
- [Images in, and models that can't see them](#images-in-and-models-that-cant-see-them)
- [Virtual file system](#virtual-file-system)
- [Autonomy](#autonomy)
- [Event reference](#event-reference)

## Thinking

```ts
createAgent({
  model,
  thinking: 'high', // true | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'none'
  stageThinking: { executor: 'low', synthesizer: false }, // per stage; wins over `thinking`
})
// exact budget for providers that take one (Anthropic, Gemini):
createAgent({ model, thinking: { level: 'high', budgetTokens: 8_000, includeThoughts: true } })
```

- The level is the AI SDK's portable `reasoning` setting; each provider maps it
  to its native API (OpenAI reasoning effort, Anthropic adaptive thinking,
  Gemini thinking level, xAI, DeepSeek, …). Providers without reasoning ignore it
  with a warning.
- `budgetTokens` becomes `anthropic.thinking.budgetTokens` and
  `google.thinkingConfig.thinkingBudget` (these win over the level for those
  providers, by the SDK's precedence rules).
- `includeThoughts` (default `true`) asks Gemini for thought summaries and OpenAI
  for a reasoning summary, so thoughts can be streamed.
- `false` / unset sends nothing — the provider default applies.
- Thoughts stream as `step.reasoning-delta` (executor) and
  `final.reasoning-delta` (synthesizer); thinking tokens are reported in
  `usage.reasoningTokens`.
- Local reasoning models (Qwen3, R1 distills) that inline `<think>…</think>` in
  their text have those blocks stripped from parsed output and the answer.

`resolveThinking(setting)` is exported if you call the AI SDK yourself.

## Token limits and step caps

```ts
createAgent({
  model,
  limits: {
    maxInputTokens: 200_000,   // cumulative per run
    maxOutputTokens: 20_000,   // cumulative per run, thinking included
    maxReasoningTokens: 10_000,
    maxTotalTokens: 220_000,
    perCall: { planner: 800, executor: 1200, replanner: 400, synthesizer: 600, compaction: 1024 },
  },
  maxIterations: 8,     // executed steps per run (incl. after a revise)
  maxStepsPerTask: 4,   // tool-calling rounds inside one step
  maxRevisions: 2,      // replanner "revise" decisions per run
  maxToolCalls: 30,     // tool calls per run
  maxPlanSteps: 8,      // steps in one plan
})
```

Run-level caps are **soft**: they are checked between steps and at every
tool-calling round inside a step, so a run stops at the next boundary after
crossing one, emits `budget.exceeded { kind, tokens, cap }`, and still writes its
answer (bounded by `perCall.synthesizer`). `RunResult.budgetExceeded` tells you
which cap ended the run. `checkLimits(usage, limits)` is exported.

`usage` carries `inputTokens`, `outputTokens`, `totalTokens`, plus
`reasoningTokens`, `cachedInputTokens` and `cacheWriteTokens` when the provider
reports them. The legacy `budgets` option still works; `limits.perCall` wins.

## Context management and compaction

What each stage sees:

| Stage | System prompt (stable, cached) | User prompt (dynamic) |
| --- | --- | --- |
| Planner | role, skills index, tool catalogue | goal, recent conversation, `describeState` |
| Executor | role, skills index, active skill instructions | goal, state, earlier steps **with their results**, current step (+ catalogue in prompted mode) |
| Replanner | role, active skills | goal, state, progress, remaining plan |
| Synthesizer | role, active skills | goal, state, progress, **tool findings** |

Each executed step contributes its executor summary (the data it found) to every
later step and to the answer, and the synthesizer also gets clipped excerpts of
successful tool results — so a "find X, then do Y with X" run, or a question
answered from an MCP server, works without `describeState`.

Compaction keeps long sessions and long runs inside the window:

```ts
createAgent({
  model,
  memory: new IndexedDBStore(),
  compaction: {
    auto: true,                  // default
    contextWindowTokens: 128_000,
    thresholdTokens: 64_000,     // default: half the window
    keepRecentTurns: 4,          // transcript messages kept verbatim
    keepRecentSteps: 3,          // run steps kept verbatim
    summaryMaxTokens: 1024,
    maxToolOutputChars: 20_000,  // per tool result, as the MODEL sees it
  },
})
await agent.compact()           // manual: summarise the stored transcript now
```

- **History** — before planning (and after the run) a transcript above the
  threshold is summarised into one message, keeping the last `keepRecentTurns`.
- **Run trace** — between steps a step log above the threshold is folded into a
  summary, keeping the last `keepRecentSteps`.
- **Tool results** — every tool's model-facing output is capped at
  `maxToolOutputChars` (via the AI SDK `toModelOutput`); events and the trace
  still get the full result.

Each compaction emits `context.compacted { scope, beforeTokens, afterTokens }`
and a `usage` event with phase `'compact'`. Without `compaction`, the legacy
`compressAfterChars` post-run compression applies as before.

## Prompt caching

`promptCaching` is on by default:

- every stage's **system** prompt holds only run-stable content, the dynamic
  parts go to the user prompt — OpenAI's and Gemini's automatic prefix caches hit;
- the system message carries an Anthropic `cacheControl` breakpoint
  (`promptCaching: { ttl: '1h' }` for the longer TTL);
- OpenAI calls get a `promptCacheKey` (`<clientName>:<stage>`, or your `key`).

Cache reads/writes show up as `usage.cachedInputTokens` / `cacheWriteTokens`.
`promptCaching: false` sends plain system strings.

## Skills

Skills are reusable instruction bundles in the [agentskills.io](https://agentskills.io/)
shape (a `SKILL.md` with `name` / `description` frontmatter, a markdown body,
optional bundled files).

```ts
import { createAgent, defineSkill, parseSkillMarkdown, loadSkillFromUrl } from '@dudko.dev/agent-web'

const skills = [
  defineSkill({ name: 'release-notes', description: 'Write release notes', content: '…' }),
  parseSkillMarkdown(markdownText, [{ path: 'template.md', content: '…' }]),
  await loadSkillFromUrl('/skills/triage/SKILL.md', { files: ['labels.md'] }),
]
createAgent({ model, skills })
```

Progressive disclosure:

1. Only the index (`- name: description`) sits in the planner/executor system prompts.
2. The planner lists the skills that apply (`plan.skills`); their full
   instructions enter the executor, replanner and synthesizer prompts.
3. The executor can pull one in later with the built-in `load_skill` tool and
   read bundled files with `read_skill_file` (both read-only, never gated).

`skill.activated { name, by: 'plan' | 'tool' }` is emitted; `RunResult.skills`
lists the skills used; `agent.skills` lists the configured ones.

## Tool consent and autopilot

```ts
const agent = await createAgent({
  model,
  tools,
  toolApproval: {
    mode: 'ask-writes', // 'autopilot' (default) | 'ask-writes' | 'ask-all' | 'read-only'
    rules: { 'github__delete_*': 'deny', 'docs__*': 'allow' }, // exact names or * globs
    onRequest: async (req) => ({ approved: await confirm(`Run ${req.toolName}?`), remember: false }),
    timeoutMs: 120_000, // no answer → deny
  },
})
agent.setToolApprovalMode('autopilot') // the "autopilot" switch, live — even mid-run
```

| Mode | Read-only tools | Other tools |
| --- | --- | --- |
| `autopilot` | run | run |
| `ask-writes` | run | ask |
| `ask-all` | ask | ask |
| `read-only` | run | refused (no prompt) |

Decision order per call: a tool the user chose to **always allow**
(`remember: true`) → the most specific `rules` entry (an exact name, else the
longest glob — rules apply even under autopilot) → the mode. A tool is
read-only when its MCP server says so (`annotations.readOnlyHint`) or you marked
it: `defineTool({ readOnly: true, … })` / `markReadOnly(tool)`. Unknown counts as
"may write".

A denied call fails with `ToolDeniedError` ("…do not retry it…"), so the model
sees the refusal and the replanner can route around it. Events:
`tool.approval-requested { id, name, input, readOnly }` (only when someone is
asked) and `tool.approval-resolved { id, name, approved, reason, automatic }`.
The gate runs inside each tool's `execute`, so it covers native and prompted
tool-calling, MCP tools and host tools called by subagents alike.

## Large tool catalogues (several MCP servers)

Several MCP servers easily add up to hundreds of tools. Sending every schema on
every call wastes the window — and OpenAI rejects more than 128 tools.

**Loading** (`@dudko.dev/agent-web/mcp`):

- servers connect **concurrently**; one failing server is reported in `results`
  and the others still mount;
- `tools/list` is **paginated** — every `nextCursor` page is followed;
- each server has a **deadline** (`connectTimeoutMs`, default 30 s, per server
  or per `connectMcpHttp` call) — a hanging server can't block the rest;
- names are `server__tool`, sanitised to `[a-zA-Z0-9_-]` and capped at 64
  chars; collisions get a `_2` suffix;
- `annotations.readOnlyHint` marks tools read-only for the consent gate;
- `notifications/tools/list_changed` → `onToolsChanged(server)` → `refreshServer`.

**Selection** — `toolSelectionStrategy` (default `'auto'`):

| Strategy | Executor sees | Planner sees |
| --- | --- | --- |
| `all` | every tool | full catalogue |
| `plan-narrowed` | the step's `suggestedTools` | full catalogue |
| `search` | built-ins + the step's suggested tools + tools discovered earlier, plus `find_tools` | condensed catalogue grouped by server |
| `auto` | `all` up to `toolSearchThreshold` (40) tools, `search` above | — |

`find_tools({ query, server?, limit? })` ranks the catalogue by keywords (name
> server > description, prefix matching, no model call) and activates the hits
for the rest of the run (`tools.discovered` event). In prompted mode the newly
available tools — with parameter hints derived from their JSON schemas — are
listed in the next round's prompt. `searchTools(catalog, query)` is exported.

## Subagents (in-process or Web Workers)

A subagent is a tool: the parent delegates `{ task }`, the child runs its own
loop and its answer is the tool result. Several delegations in one model step
run in parallel (`maxConcurrent`, default 4).

```ts
import { createSubagentTool } from '@dudko.dev/agent-web'

// In-process (shares the page's thread and models, e.g. a loaded WebLLM engine):
const researcher = createSubagentTool({
  name: 'researcher',
  description: 'Research a question with the docs tools and report the facts.',
  config: { model, tools: docsTools, maxIterations: 4 },
})

// Isolated in a Web Worker:
const analyst = createSubagentTool({
  name: 'analyst',
  description: 'Analyse a chess position deeply.',
  worker: () => new Worker(new URL('./analyst.worker.ts', import.meta.url), { type: 'module' }),
  workerConfig: { model: { providerType: 'google', model: 'gemini-3.5-flash', credentialRef: 'google' } },
  credentials,           // resolves the key in the main thread, per task
  tools: { get_board },  // host tools, called back over RPC
  timeoutMs: 60_000,
})
createAgent({ model, tools: { researcher, analyst } })
```

```ts
// analyst.worker.ts
import { serveSubagentWorker, defineTool } from '@dudko.dev/agent-web'
import { createGoogleGenerativeAI } from '@ai-sdk/google'

serveSubagentWorker({
  // Bundlers can't resolve the core's dynamic provider imports in a worker —
  // import the factory statically and build the model here.
  resolveModel: (spec) => createGoogleGenerativeAI({ apiKey: spec.apiKey })(spec.model),
  tools: { deep_search: defineTool({ /* CPU-heavy, runs off the main thread */ }) },
})
```

- **Worker-local tools** run in the worker — heavy computation never blocks the UI.
- **Host tools** (`tools`) stay in the main thread and are proxied over
  `postMessage`; every such call passes the **parent's** consent gate.
- The parent's abort signal and `timeoutMs` stop the child; a worker is
  terminated after each task.
- Events: `subagent.start`, `subagent.event` (the child's events, verbatim),
  `subagent.complete { text, usage }`, `subagent.error`. Child tokens are
  charged to the parent (`usage` with phase `'subagent'`), so the parent's limits
  apply.
- The protocol is plain structured-clone messages over any `MessageEndpoint`
  (a `Worker`, a worker's `self`, a `MessagePort`).

## Images in, and models that can't see them

```ts
await agent.run('What is wrong on this screenshot?', {
  images: [{ data: 'data:image/png;base64,…', name: 'screen.png' }], // or base64 + mediaType, or bytes
})
```

Images reach the planner, the executor (every step) and the synthesizer as
image parts of the user message. Whether a model can take them is
`agent.capabilities.images`:

- `false` — local / prompted-mode models (WebLLM, built-in AI), DeepSeek and
  text-only families (`gpt-3.5`, `o1-mini`, …), or `vision: false` in the
  config. A run with images then **ends immediately** — no tokens spent — with
  an `error` event (phase `run`) and `RunResult.final` set to
  `ImagesNotSupportedError`'s message: *The model "…" can't take images (…).
  Remove the image, or switch to a vision-capable model…*
- `true` — Gemini, Claude, GPT-4o/4.1/5, Grok (or `vision: true`).
- `undefined` — unknown (an OpenAI-compatible server): the run tries, and a
  provider refusal is turned into the same `ImagesNotSupportedError` message
  ("the provider said: …") instead of a raw API error.

A UI should check `agent.capabilities.images` before accepting a paste
(`@dudko.dev/agent-web-react`'s composer does). Memory stores a text note of
the images ("[attached image(s): screen.png]"), never their bytes.

## Virtual file system

```ts
import { VirtualFileSystem, createFileTools } from '@dudko.dev/agent-web'

const vfs = new VirtualFileSystem() // IndexedDB; { memory: true } for tests / private mode
await vfs.write('/notes/todo.md', '- ship it')
await vfs.writeDataUrl('/img/screen.png', dataUrl)
createAgent({ model, tools: { ...tools, ...createFileTools(vfs) } }) // fs_list, fs_read, fs_write, fs_delete
```

A browser workspace shared by the user and the agent: attachments land there,
the agent reads them and writes reports back. Paths are absolute and POSIX-like
(`..` cannot escape the root); text is stored as UTF-8, binary as base64 with a
MIME type; `list(prefix)`, `read`, `readDataUrl`, `delete`, `clear`, and
`onChange(listener)` for live UIs. `namespace` isolates several file systems
in one database; `maxFileBytes` (10 MB) caps a file. `fs_list` / `fs_read` are
read-only (no consent prompt in `ask-writes`); `fs_write` / `fs_delete` are
not; `createFileTools(vfs, { readOnly: true })` mounts only the readers. The
files live in the shared IndexedDB database (`files` store, schema v2 — an
existing v1 database is upgraded in place).

## Autonomy

The default prompts make the agent act on its own:

- the planner plans tool use for anything the tools can do **or look up** —
  questions that need data are real goals; an empty plan is reserved for pure
  greetings / small talk / questions answerable without tools;
- no stage ever asks the user for confirmation or plans an "ask the user" step;
  ambiguity is resolved by the most reasonable interpretation, stated as an
  assumption;
- the executor uses `[BLOCKER]` only when a step is truly impossible (a tool is
  missing or denied, credentials or data are unavailable);
- the replanner prefers routing around a failure over giving up;
- permission is the host's `toolApproval` policy — never a question in text.

Soften it per app with `systemPrompt`, or replace any phase via `prompts`.

## Event reference

New events (in addition to plan/step/replan/final/usage/retry/stopped/error):

| Event | Payload |
| --- | --- |
| `step.reasoning-delta` | `step, delta` |
| `final.reasoning-delta` | `delta` |
| `budget.exceeded` | `kind: 'input' \| 'output' \| 'reasoning' \| 'total' \| 'tool-calls', tokens, cap` |
| `context.compacted` | `scope: 'history' \| 'trace', beforeTokens, afterTokens` |
| `skill.activated` | `name, by: 'plan' \| 'tool'` |
| `tools.discovered` | `step?, query, names` |
| `tool.approval-requested` | `id, name, input, readOnly, step?` |
| `tool.approval-resolved` | `id, name, approved, reason?, automatic` |
| `subagent.start` / `subagent.event` / `subagent.complete` / `subagent.error` | `id, name` + `task` / `event` / `text, usage` / `error` |

`usage` events can now carry phase `'compact'` and `'subagent'`.
