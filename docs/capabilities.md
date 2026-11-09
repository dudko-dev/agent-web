# Agent capabilities

Everything the agent loop does beyond "plan → execute → replan → synthesize":
thinking, token budgets, context compaction, skills, tool consent and
autopilot, large MCP catalogues, prompt caching, subagents and autonomy. The
Node sibling [`@dudko.dev/agent`](https://www.npmjs.com/package/@dudko.dev/agent)
implements the same features with the same field and event names.

- [Thinking](#thinking)
- [Token limits and step caps](#token-limits-and-step-caps)
- [Usage: what a session has spent](#usage-what-a-session-has-spent)
- [Context management and compaction](#context-management-and-compaction)
- [Prompt caching](#prompt-caching)
- [Token efficiency](#token-efficiency)
- [Skills](#skills)
- [Tool consent and autopilot](#tool-consent-and-autopilot)
- [Large tool catalogues (several MCP servers)](#large-tool-catalogues-several-mcp-servers)
- [Subagents (in-process or Web Workers)](#subagents-in-process-or-web-workers)
- [Images, PDFs, files and URLs in](#images-pdfs-files-and-urls-in--and-models-that-cant-take-them)
- [Virtual file system](#virtual-file-system)
- [Resuming an interrupted run](#resuming-an-interrupted-run)
- [Steering a run that is already going](#steering-a-run-that-is-already-going)
- [Learning: lessons that outlive the task](#learning-lessons-that-outlive-the-task)
- [Egress: what the model may fetch](#egress-what-the-model-may-fetch)
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
- WebLLM ignores the portable level, so every setting also carries
  `web-llm.extra_body.enable_thinking`: `'none'` turns a thinking model (Qwen3)
  off, any other level leaves it on; models without thinking ignore it.
- `false` / unset sends nothing — the provider default applies (a local Qwen3
  thinks by default).
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
    perCall: { planner: 800, executor: 1200, replanner: 400, synthesizer: 3000, compaction: 1024 },
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

`perCall` caps the output of ONE model call per phase. Unless you set them, the defaults are
shares of the **context window** (`compaction.contextWindowTokens`, or a local model's own): at
the default 128k window they are planner 800, executor 1200, replanner 400, **synthesizer 3000**
(the answer the user reads) and compaction 1024; a 32k window gets 256 / 384 / 192 / 768 / 256, a
4k one the floors (256 / 384 / 192 / 512 / 256) and a very large one more, up to ceilings of
2000 / 8192 / 1500 / 8192 / 4096. `resolveBudgets(config, window)` returns them. A thinking model
spends part of its cap on thoughts, so raise the cap together with `thinking`; the executor's cap
also bounds what it can write into one tool call (a long file body, say).

## Usage: what a session has spent

`RunResult.usage` is one run's tokens (`inputTokens`, `outputTokens`, `totalTokens`, and
`reasoningTokens` / `cachedInputTokens` / `cacheWriteTokens` when the provider reports them).
The agent keeps the running total itself:

```ts
agent.usage                  // everything this agent has spent, over all its runs (a snapshot)
agent.sessionUsage()         // the same for the agent's session (or sessionUsage('other-chat'))
agent.resetUsage()           // start counting again
```

It is counted call by call as the usage arrives - so a run that is stopped or fails still counts
what it used, a resumed run adds only what THIS process spent after the checkpoint, a subagent's
tokens (charged to its parent run) count once, and so do the manual `agent.compact()` calls.
That includes a model answer that could not be parsed and was retried (the planner's and the
replanner's structured attempt, then the prompted fallback): both calls were paid for and both
are counted. (`useAgent().totalUsage` in the React package is a conversation's total, kept by the
UI; this is the core's own counter.)

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
    thresholdRatio: 0.85,        // default: compact at 85% of the window (0 < ratio <= 1)
    // thresholdTokens: 100_000, // ...or an absolute number; it wins over the ratio
    keepRecentTurns: 4,          // transcript messages kept verbatim
    keepRecentSteps: 3,          // run steps kept verbatim
    summaryMaxTokens: 1024,
    maxToolOutputChars: 20_000,  // per tool result, as the MODEL sees it
    clearToolResultsAfterTokens: 32_000, // default: a quarter of the window; 0 = never
    keepToolResults: 3,          // newest tool results kept verbatim when clearing
  },
})
await agent.compact()           // manual: summarise the stored transcript now
```

- **History** — before planning (and after the run) a transcript that no longer fits is
  summarised into one message, keeping the last `keepRecentTurns`.
- **Run trace** — between steps a step log that no longer fits is folded into a summary,
  keeping the last `keepRecentSteps`.
- **Tool results** — every tool's model-facing output is capped at
  `maxToolOutputChars` (via the AI SDK `toModelOutput`); events and the trace
  still get the full result.
- **Stale tool results inside a step** (context editing, like Anthropic's
  `clear_tool_uses` and Claude Code's micro-compaction) — once a step's tool
  loop grows past `clearToolResultsAfterTokens`, the oldest results are replaced
  with a one-line stub ("… result cleared — call the tool again if you still
  need it"), keeping the newest `keepToolResults`. The calls stay, so the model
  knows what it did. Clearing is sticky, so the cached prefix doesn't flip back.

**What "fits" means.** The threshold is a share of the window (85% by default) and it is
judged on the **whole context** of the next call: the fixed prompt (stage instructions, tool
definitions, the skills index and active skills, your `systemPrompt`) **plus** the transcript
**plus** the run's step log. Judging each part alone would let a long transcript and a long log
each stay under the line while together overflowing the window. The rest is room for the answer
and for what one step adds before the next check. The fixed prompt is estimated (about 1 500
tokens, your `systemPrompt`, the tool definitions, the skills; under tool search only a few
definitions are sent, so the tools count at most 3 000).

**The estimate** counts by kind of character, because text is not one thing: letters ~2.5 to a
token, digits and punctuation about one each, a space a quarter, a newline one, other scripts
(Russian) two characters, CJK and emoji one. It was calibrated against Claude's tokenizer over
prose, markdown, code, JSON, a table, Russian and a mix, and comes out **1.1-1.4x the real count
and never below it** (a flat "4 characters a token" was 0.4-0.7x for everything but Russian: JSON
and code run 1.6-2.4 characters a token, and tool definitions 2x what 4 would give). It leans high
on purpose: compacting a little early is cheap, overflowing the window is a failed run. So at the
default 85%, a Claude model has roughly 70-75% of its window really used when compaction starts;
a tokenizer that packs tighter (OpenAI, Gemini) starts a little earlier still. Raise
`thresholdRatio` (0.9, 0.95) to compact later. `estimateTokens` is exported. For a local model the
window is its own and the threshold follows it (never past 95% of it).

**What the summariser is shown** is the newest part of what is being folded that fits 60% of the
window (it used to be the last 48 000 characters, whatever the window).

Each compaction emits `context.compacted { scope, beforeTokens, afterTokens }`
(`scope`: `'history' | 'trace' | 'tool-results'`) and, when a model summarised,
a `usage` event with phase `'compact'`. Without `compaction` (and without a
local model, see below), the legacy `compressAfterChars` post-run compression
applies as before.

### The model's window is a hard limit

A prompt that doesn't fit is refused outright, so everything above is sized
from the window, and the window must be the model's real one:

- **Local WebLLM models** report their own window. WebLLM loads its prebuilt
  models with **4096 tokens** (to save VRAM; "-1k" builds with 1024), whatever
  the model was trained on. The agent reads it from the loaded engine (or the
  app config it was built with) and never assumes more — even when
  `contextWindowTokens` says more; it compacts by tokens even without a
  `compaction` config. `agent.contextWindowTokens` is the window in use.
- **Raising it**: Qwen3 and Llama 3.x take far more than 4096. A larger window
  costs KV-cache memory, not a new download:

  ```ts
  createWebLLMModel('Qwen3.5-2B-q4f16_1-MLC', { contextWindowTokens: 32_768 })
  // under a bundler, with your own factory:
  import { prebuiltAppConfig } from '@mlc-ai/web-llm'
  webLLM(id, { engineConfig: { appConfig: withWebLLMContextWindow(prebuiltAppConfig, id, 32_768) } })
  ```

  (`@browser-ai/web-llm` ignores its top-level `appConfig` setting — it has to
  go in `engineConfig`.)
- **Sizes follow the window**: with a small window the threshold (½), the
  tool-result clearing point (¼), the cap on one tool result (a quarter of the
  window) and the verbatim results kept (1 below 16k) shrink with it — also
  when the host set them for a larger window.
- **Tools**: `'auto'` tool selection switches to search not only above
  `toolSearchThreshold` tools but also once the tool definitions would take a
  quarter of the window — a few MCP tools with rich schemas can fill a 4k
  window on their own.
- **Overflow**: when a provider still refuses a prompt for its length (WebLLM,
  OpenAI `context_length_exceeded`, Claude "prompt is too long", Gemini, llama.cpp),
  the run reports a `ContextWindowExceededError` — "The conversation no longer
  fits the context window of … (4124 tokens; the window is 4096). Start a new
  chat or compact this one, connect fewer tools, or switch to a model with a
  larger window." — instead of the provider's text.

Helpers: `webLLMContextWindow(model)`, `withWebLLMContextWindow(appConfig, id,
tokens)`, `fitCompactionToWindow`, `toolDefinitionTokens(tools)`,
`contextOverflowOf(err, model)`.

## Prompt caching

`promptCaching` is on by default:

- every stage's **system** prompt holds only run-stable content, the dynamic
  parts go to the user prompt — OpenAI's and Gemini's automatic prefix caches hit;
- the system message carries an Anthropic `cacheControl` breakpoint
  (`promptCaching: { ttl: '1h' }` for the longer TTL);
- OpenAI calls get a `promptCacheKey` (`<clientName>:<stage>`, or your `key`);
- inside a step's tool loop, a second breakpoint **rolls to the newest message**
  every round, so each round reads all earlier rounds from the cache and writes
  only the new tail (older message breakpoints are removed — a request carries
  at most two, Anthropic allows four);
- tools keep **declaration order** (hosts merge their tool sets in a fixed
  order, `useMcpServers` in list order), so the tool list — the head of every
  cached prefix — is identical from run to run, without reordering what a server
  declared: small models were measured to depend on that order.

Cache reads/writes show up as `usage.cachedInputTokens` / `cacheWriteTokens`.
`promptCaching: false` sends plain system strings.

## Token efficiency

The agent follows the practices coding agents (Claude Code, the Claude and
GitHub Copilot extensions) use to keep a long session cheap:

| Practice | How the agent does it | Knob |
| --- | --- | --- |
| Stable, cacheable prefix | system prompts hold only run-stable content; deterministic tool order; dynamic state goes last | `promptCaching` |
| Cache the growing loop | rolling Anthropic breakpoint on the newest message; OpenAI `promptCacheKey` per stage | `promptCaching: { ttl }` |
| Don't send every tool | above `toolSearchThreshold` the model gets a compact catalogue and `find_tools` (deferred tools) | `toolSelectionStrategy`, `toolSearchThreshold` |
| Load instructions on demand | skills: only name + description in the prompt, the body on activation | `skills` |
| Cap tool output | per result, as the model sees it (events keep the full value) | `compaction.maxToolOutputChars` |
| Clear stale tool results | oldest results in a long loop become stubs | `compaction.clearToolResultsAfterTokens` |
| Auto-compact | history and run trace summarised past a threshold; `agent.compact()` on demand | `compaction` |
| Isolate side quests | subagents run in their own context; only their answer returns | `createSubagentTool` |
| Pass results, not transcripts | later steps and the answer get step summaries + clipped findings, not raw loops | — |
| Bound everything | token caps per run / per kind, tool-call and plan-step caps | `limits`, `maxToolCalls`, `maxPlanSteps` |
| Think only where it pays | thinking per stage (e.g. on for the planner, off for the synthesizer) | `stageThinking` |
| Cheaper model for summaries | compaction and the answer use the `synthesizer` stage model | `synthesizer` |
| Small images | the React composer downsizes images before sending (≈1.15 MP), the size providers bill for | `<AgentComposer imageMaxDimension>` |

The usage events break every call down by kind (input / output / thinking /
cache read / cache write) and by phase, so the effect is measurable:
`cachedInputTokens / inputTokens` is the cache hit rate.

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
lists the skills used; `agent.skills` lists the configured ones (and, with
[`learning`](#learning-lessons-that-outlive-the-task), the agent's own, marked `learned`).

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

### Profiles: other models, params and context per call

A subagent normally has one fixed configuration. `profiles` lets the **parent
model** choose between named variants of it, per call:

```ts
const researcher = createSubagentTool({
  name: 'researcher',
  description: 'Research a question with the docs tools and report the facts.',
  config: { model: fastModel, tools: docsTools, maxIterations: 3 }, // the default: cheap and quick
  profiles: {
    deep: {
      description: 'A hard question that needs a thorough, multi-source answer.',
      config: { model: strongModel, thinking: 'high', maxIterations: 8 },
    },
    skeptic: {
      description: 'Check a claim someone else made; look for what contradicts it.',
      config: { systemPrompt: 'Assume the claim is wrong until the sources show otherwise.' },
    },
  },
})
```

- The tool gains an optional `profile` argument, an enum of the names; leaving it
  out runs the base config. Each profile's `description` is appended to the tool's
  description, so the parent chooses by *when to use it* — write them that way.
- A profile's fields are laid **over** the base config, field by field and
  shallow: a profile's `limits` replaces the base's `limits`, it is not merged
  into it. Anything in `BrowserAgentConfig` can differ — the model (even another
  provider), `thinking`, limits, `systemPrompt`, `skills`, `tools`.
- For a Web Worker subagent the override is `workerConfig` (its model is a
  serializable `ProviderModelSpec`, and a `credentialRef` is resolved to a key in
  the main thread for *that profile's* model). Setting `config` on a worker
  profile, or `workerConfig` on an in-process one, is refused when the tool is
  created.
- The choice is bounded by what **you** listed: the parent cannot pick an
  arbitrary model, so cost stays in the host's hands. An unknown name is a tool
  error the model can correct, raised before any child starts or is announced.
- `subagent.start` carries `profile` when one was chosen. Child tokens are
  charged to the parent as always, whichever profile ran.
- The child's context is still just `task`. A different context means a profile
  that changes `systemPrompt`, `skills` or `tools` — the parent cannot hand a
  child more of its own conversation.

## Images, PDFs, files and URLs in — and models that can't take them

```ts
await agent.run('What is wrong on this screenshot, and does the spec agree?', {
  images: [{ data: 'data:image/png;base64,…', name: 'screen.png' }],
  files: [
    { data: pdfBytes, mediaType: 'application/pdf', name: 'spec.pdf' },
    { data: 'https://example.com/diagram.png' }, // a link: sent as a URL
  ],
})
```

Attachments reach the planner, the executor (every step) and the synthesizer as
file parts of the user message (`toFilePart`). Data can be bytes, base64, a
data URL, or an **http(s) URL** — providers that accept links (Gemini, Claude,
OpenAI) fetch it themselves; for the rest the AI SDK downloads it (from a
browser: subject to CORS). The kind comes from the media type
(`attachmentKind`): `image`, `pdf`, or `file`.

What the model takes is `agent.capabilities` — `{ images, pdf, files }`, each
`true` / `false` / `undefined`:

| | images | pdf | other files |
| --- | --- | --- | --- |
| Gemini, Claude, OpenAI GPT-4o/4.1/5 | ✓ | ✓ | tried |
| xAI Grok | ✓ | tried | tried |
| DeepSeek, `gpt-3.5`, `o1-mini`… | ✗ | ✗ | tried |
| Local vision models (WebLLM `Phi-3.5-vision…`; ids naming vision / VL / LLaVA / SmolVLM / Gemma 3n) | ✓ | ✗ | ✗ |
| Other local models (WebLLM, built-in AI) | ✗ | ✗ | ✗ |
| OpenAI-compatible servers | tried | tried | tried |

Override with `vision` (images) or `inputs: { images, pdf, files }`.

- **Known ✗** — the run ends immediately, no tokens spent, with an `error`
  event (phase `run`) and `RunResult.final` set to a message the user can act
  on: *The model "…" can't take PDF files. Convert the PDF to text first (e.g.
  PDF → Markdown), or switch to a model that reads PDFs such as Gemini, Claude
  or GPT-4o/GPT-5.* (`AttachmentsNotSupportedError`; `ImagesNotSupportedError`
  for images.)
- **Tried** — a provider refusal is turned into the same message ("the provider
  said: …") instead of a raw API error.

A UI should check `agent.capabilities` before accepting a paste or an upload
(`@dudko.dev/agent-web-react`'s composer does, and can convert a PDF to
Markdown first). Memory stores a text note of the attachments ("[attached:
screen.png, spec.pdf]"), never their bytes.

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

## Resuming an interrupted run

A reload, a crashed tab or a killed worker normally loses a run — including the steps
that already ran. `persistence` checkpoints it:

```ts
import { createAgent, IndexedDBRunStore } from '@dudko.dev/agent-web'

const runs = new IndexedDBRunStore()
const agent = await createAgent({ model, tools, persistence: runs, sessionId: chatId })
const result = await agent.run('Triage the new tickets') // result.runId names the run

// After a reload:
const unfinished = await runs.latestResumable(chatId)
if (unfinished) await agent.run('', { resumeFromRunId: unfinished.runId })
```

- A checkpoint is written when the plan is in hand and at the end of **every
  iteration**. Resuming picks up at that boundary: the planner does not run again, a
  finished step is not repeated, and the saved goal, plan, trace, step log, findings,
  skills, discovered tools and counters all carry over. So `maxIterations`,
  `maxRevisions` and `maxToolCalls` are per **run**, not per page load, and token usage
  keeps adding up. The goal you pass to `run()` when resuming is ignored — the saved one
  is the run's.
- `run.start` carries the `runId` and, on a resume, how far the run had got
  (`resumed: { completedSteps, remainingSteps }`); `plan.created` then shows the plan
  as it stands — finished steps first, then what is left.
- A stopped run (`cancelled`) and a failed one can be resumed; a `complete` one cannot.
  `IndexedDBRunStore` drops a completed run's snapshot (`keepCompleted: true` keeps it
  as an audit trail); `MemoryRunStore` does the same but does not survive a reload.
- The hooks are `onRunStart`, `onStepComplete`, `onRunComplete` and `loadRun` — the
  names the Node package uses — so a store of your own is four methods. A hook that
  throws is logged and the run carries on: persistence is observability, not a
  correctness boundary. The snapshot's field names follow this package's `run(goal)`
  (`goal`, not Node's `input`).
- The database gains a `runs` object store (schema v3); an existing database upgrades in
  place and keeps its data.

What a resume does **not** give you:

- **A step in flight when the page died runs again from its start.** For a read that is
  free; for a write it may apply twice, so give tools with side effects idempotency — or
  keep the consent gate on: a resumed run goes through `toolApproval` like any other.
- **Attachments are not stored.** Pass `images` / `files` to `run()` again if the run
  needs them; the snapshot only records how many there were.
- **A snapshot holds the whole trace**, tool outputs included, and is rewritten at each
  checkpoint. For tools that return megabytes, trim in your store's `onStepComplete`.
- Nothing resumes by itself: your app decides when to look for an unfinished run and
  whether to offer it.

## Steering a run that is already going

`run()` takes one goal and returns when the run is over. To say something in the
meantime — "use the staging database", "skip the report" — or to stop one subagent out
of several, make a **`RunControl`** and pass it to the run:

```ts
import { createAgent, createRunControl } from '@dudko.dev/agent-web'

const control = createRunControl()
const running = agent.run('Triage the new tickets', { control, onEvent })

control.send('Ignore anything older than a week') // any time while it runs
control.subagents() // [{ id, name, task, profile?, startedAt }] — who is running now
control.stopSubagent(id) // stops that one; the run goes on
const result = await running
result.undelivered // messages the run never got to show the model — send them as the next run
```

A message is **not an interrupt**. The run never cuts a tool call short (it may be a
write); the message waits for the next boundary and is then shown to the model:

| It arrives… | It is shown… | `message.delivered` `at` |
| --- | --- | --- |
| during a step, while tools are being called | to the executor on its **next round** of that step, as a user turn after the tool results | `round` |
| between steps | to the **replanner**, and to every later step | `step` |
| after the last step, before the answer is written | to the synthesizer | `final` |
| while the answer is being written, or after the run ended | to **nobody** — it comes back in `result.undelivered` | — |

- **A message always makes the replanner look at the plan again**, at the end of the step
  it was delivered in: a plan made before the user spoke may no longer be the right one.
  That call (`replan.decision` with `byUser: true`) ignores `replan: false` and
  `maxRevisions`, and a revise it makes is not counted against `maxRevisions`; it costs
  one extra model call per boundary, not per message, and there is no cap on messages.
  It does need a step left to plan: at `maxIterations` the message still reaches the
  synthesizer. A replanner that says `finish` ends the run early — that is how "stop,
  that is enough" works.
- Every later stage of the run sees what the user said (a `MESSAGES FROM THE USER`
  block), so a correction is not forgotten two steps later. It is also appended to the
  session transcript, in order, and saved in a run checkpoint — a resumed run still
  knows it.
- A message arriving **before** the run starts is queued and announced (`message.queued`)
  right after `run.start`. `send()` returns `false` for an empty text and once the run is
  over; it never throws.
- Prompted mode (small local models) gets the message in the same turn as the tool
  results, before the "continue this step" contract; native mode adds it as a user turn
  after the tool results, which is the order Anthropic, OpenAI and Gemini all accept.
- Use one control per run. A hand-made object in its place is refused: only the ones
  `createRunControl()` makes are read.

**Stopping a subagent.** `stopSubagent(id)` aborts that child (and its worker, if it has
one). Its delegation fails with a message the parent model can route around ("stopped by
the user … carry on without its result"), `subagent.error` carries `stopped: true`, and
sibling subagents and the run are untouched. Only a child that has started is listed; one
still waiting for a `maxConcurrent` slot is not. A child's own subagents are not
individually stoppable — stopping the child stops them with it. The log of what each
child does is the `subagent.event` stream, the same events the parent emits.

## Learning: lessons that outlive the task

Switch on `learning` and the agent keeps a notebook. When it hits a problem and finds the way
around it — a tool error it resolved, a wrong assumption it corrected, a procedure it had to look
up — it writes the lesson down with `save_skill`, and the lesson **is a [skill](#skills)**: it
shows up in the planner's `SKILLS:` index right away (even for the next step of the same run) and
loads with `load_skill` like any other. Nothing new to learn on the reading side.

```ts
import { createAgent, VfsSkillStore, VirtualFileSystem } from '@dudko.dev/agent-web'

createAgent({ model, learning: true }) // this session (the agent's lifetime)

// ...or keep them as /skills/<name>/SKILL.md in the agent's file system (IndexedDB), where the
// user can see and edit them in the files panel like any file:
const vfs = new VirtualFileSystem()
createAgent({ model, learning: { store: new VfsSkillStore(vfs) } })

agent.skills              // [{ name, description, learned? }] - live
agent.listLearnedSkills() // the agent's own, with origin: when, which run, revision, where it read
await agent.forgetSkill('image-format-jpg') // one went stale
```

It is a *knowledge* feature and nothing else:

- **Knowledge, never policy.** A lesson is loaded under a header saying it is the agent's own
  hint, not an instruction from the user; the user's request and your rules win a conflict. It
  cannot grant a permission, switch a tool on or loosen `egress`.
- **A normal gated tool.** `save_skill` / `forget_skill` go through [tool consent](#tool-consent-and-autopilot)
  like any write — `ask-writes` asks the user first, `read-only` refuses, a `rules` entry can deny.
- **No secrets.** Names, descriptions, instructions and sources are scanned for API keys, tokens,
  private keys and the like; a hit is refused to the model (and never stored). Sources keep origin
  and path only.
- **Yours stay yours.** A skill you configured is never overwritten or deleted by the agent; on a
  name clash yours wins. Caps: `maxSkills` (50), `maxSkillChars` (6000), a one-line description.
- **Provenance.** Each lesson records when it was written, by which run, its revision and — recorded
  by the harness, not by the model — the pages `web_fetch` read in that run.
- **Quiet by default for the rest.** Without `learning` there are no extra tools and not a word
  more in the prompts. `learning: { nudge: false }` keeps the tools but drops the guidance that
  tells the executor to write lessons down (and to look for a fix before giving up — with
  `egress` on, `web_fetch` can read the docs). The notebook's tools stay callable under
  `plan-narrowed` and `search` tool selection.
- **Bring your own store.** `store` is any `{ list, save, remove }` (sync or async) — a database,
  a server. A tool of your own named `save_skill` replaces the built-in one.

Every save emits `skill.learned` (`name`, `description`, `update`, `chars`, `sources`); a forget
by the model emits `skill.forgotten` (`forgetSkill(name, onEvent)` passes it to you).

## Egress: what the model may fetch

Off by default: with no `egress` in the config the agent has **no way to make a request of its
own** (the provider's API, your MCP servers and the tools you pass are your configuration, not
the model's). Set it and the model gets one tool, `web_fetch({ url, maxChars? })` — a GET that
returns the page as readable text (HTML reduced, JSON and text as they are), flagged
`untrusted: true`: facts to use, never instructions.

```ts
createAgent({
  model,
  egress: { allow: ['docs.example.com', '*.github.com'] }, // or `true` for any public host over https
})
```

The policy has the same shape and names as the server's `createSafeFetch`
(`@dudko.dev/agent`): `allow` / `deny` (hosts, `*.subdomains`, IPs, CIDRs — deny wins, allow is
exclusive), `allowPrivateNetwork`, `protocols` (default https), `ports` (default 443), `methods`
(default GET), `maxResponseBytes` (2 MB), `timeoutMs` (15 s). What a page **can** enforce, it
does *before* a request is made: scheme, port, method, credentials in the URL, the host lists,
IP literals (loopback, private, link-local, metadata — also in IPv6, mapped or tunnelled, and the
URL parser's `2130706433` / `0x7f.1` / `127.1` tricks) and names that are internal by shape
(`localhost`, `*.local`, `*.internal`, a bare `intranet`). Nothing of the user's rides along (no
cookies, no credentials, no referrer), and the answer is bounded in size and time.

What a page **cannot** do, and a server can:

- **Pin DNS.** A public-looking name that resolves to a private address cannot be seen from a
  browser. CORS is the backstop (most servers will not answer a cross-origin read at all), as are
  the browser's Private Network Access rules — but prefer an `allow` list, or give `egress.fetch`
  a gateway that runs the server-side safe fetch and so gets the full protection.
- **See where a redirect goes.** So a redirect **fails the request** by default (`bad-redirect`);
  `followRedirects: true` follows it and judges only the *final* URL — after the request was made,
  withholding what it returned.

Approval: an open-internet `web_fetch` is a way to leak data through the URL, so it asks like a
**write**; with an `allow` list it is **read-only**. Each request emits `egress.request`
(`url` is origin and path only — no query string —, `allowed`, `status` or `reason`).

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

Everything the agent does is a typed `AgentEvent` (the union is in [`src/events.ts`](../src/events.ts)).
Subscribe with `onEvent` (per run) or the handler you pass to `createAgent`; render them however you like.

**The loop**

| Event | Payload |
| --- | --- |
| `run.start` | `goal, runId?, resumed?: { completedSteps, remainingSteps }` — `runId` names the run for [`persistence`](#resuming-an-interrupted-run) |
| `model.load` | `progress, text` — a local WebLLM model's weights downloading. In the union for hosts that forward WebLLM's `initProgressCallback`; the agent does not emit it by itself yet |
| `plan.thought-delta` | `delta` — the planner's thought, streamed |
| `plan.step-added` | `step, index` — a step is coherent enough to show; the plan can still change |
| `plan.created` | `plan` — the canonical plan |
| `plan.revised` | `plan, reason` — the replanner replaced the remaining steps |
| `step.start` | `step, index, total` |
| `step.text-delta` | `step, delta` |
| `step.reasoning-delta` / `final.reasoning-delta` | `step, delta` / `delta` — the executor's / synthesizer's thoughts ([thinking](#thinking)) |
| `step.tool-call` / `step.tool-result` | `step, name, input` / `step, name, output, ok` |
| `step.complete` | `step, result` |
| `replan.decision` | `mode: 'continue' \| 'revise' \| 'finish', reason, byUser?` — `byUser` when the replanner ran because the user sent a message |
| `final.text-delta` | `delta` — the answer, streamed |
| `final` | `text` — the answer, whole |
| `retry` | `phase: 'plan' \| 'execute' \| 'replan' \| 'synthesize', attempt, error` |
| `stopped` | — the run was stopped with `stop()` / an `AbortSignal` |
| `error` | `phase: 'plan' \| 'execute' \| 'replan' \| 'synthesize' \| 'run', error` |

**Budgets, context and cost**

| Event | Payload |
| --- | --- |
| `usage` | `phase: 'plan' \| 'execute' \| 'replan' \| 'synthesize' \| 'compact' \| 'subagent', usage` — per LLM call; counted live into [`agent.usage`](#usage-what-a-session-has-spent) |
| `budget.exceeded` | `kind: 'input' \| 'output' \| 'reasoning' \| 'total' \| 'tool-calls', tokens, cap` |
| `context.compacted` | `scope: 'history' \| 'trace' \| 'tool-results', beforeTokens, afterTokens` |

**Tools, skills and consent**

| Event | Payload |
| --- | --- |
| `skill.activated` | `name, by: 'plan' \| 'tool'` |
| `tools.discovered` | `step?, query, names` — `find_tools` activated more tools |
| `tool.approval-requested` | `id, name, input, readOnly, step?` |
| `tool.approval-resolved` | `id, name, approved, reason?, automatic` |
| `egress.request` | `url` (origin + path), `allowed`, `status?`, `reason?` — a `web_fetch` request, allowed or refused ([egress](#egress-what-the-model-may-fetch)) |
| `skill.learned` | `name, description, update, chars, sources` — the agent wrote a lesson down ([learning](#learning-lessons-that-outlive-the-task)) |
| `skill.forgotten` | `name` — a lesson was deleted |

**Subagents and steering**

| Event | Payload |
| --- | --- |
| `subagent.start` / `subagent.event` / `subagent.complete` / `subagent.error` | `id, name` + `task, profile?` / `event` / `text, usage` / `error, stopped?` |
| `message.queued` | `id, text` — a `RunControl.send()` is waiting for a boundary |
| `message.delivered` | `id, text, at: 'round' \| 'step' \| 'final'` — the model has seen it |
