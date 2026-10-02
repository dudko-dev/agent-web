import type { IStepResult } from './agent/loop-types.js'
import type { PromptCachingSetting } from './caching.js'
import type { TokenLimits } from './limits.js'
import {
  resolveCompaction,
  type CompactionConfig,
  type ResolvedCompaction,
} from './memory/compress.js'
import type { ContextStore } from './memory/store.js'
import type { AgentLoggerSink, LogLevel } from './logger.js'
import type { ModelInput, StageInput } from './providers/types.js'
import type { Prompts } from './prompts.js'
import type { CredentialStore } from './secrets/store.js'
import type { Skill } from './skills.js'
import type { ThinkingSetting, ThinkingStage } from './thinking.js'
import type { ToolApprovalConfig } from './tools/approval.js'
import type { AgentToolSet } from './tools/types.js'

/** Force a tool-calling strategy, or let the agent pick per model ('auto'). */
export type ToolMode = 'auto' | 'native' | 'prompted'

/**
 * When to consult the replanner after an executed step (given `replan` is on):
 * 'failure' — after a blocked step or a failed tool call (default);
 * 'always'  — after every step, so the replanner can react to problems the host
 *             surfaces via `describeState` (one extra model call per step);
 * predicate — decides per step result; closes over host state if needed, and
 *             falls back to 'failure' behaviour if it throws.
 */
export type ReplanTrigger =
  'failure' | 'always' | ((result: IStepResult) => boolean | Promise<boolean>)

/**
 * 'all'           — the executor sees the full ToolSet on every step.
 * 'plan-narrowed' — the executor sees only a step's suggestedTools (the planner
 *                   must populate them). Empty means a reasoning-only step.
 * 'search'        — for large catalogues: the executor starts with the step's
 *                   suggestedTools plus a `find_tools` meta-tool that activates
 *                   more on demand; the planner sees a condensed catalogue.
 * 'auto'          — 'all' up to `toolSearchThreshold` tools, 'search' above (default).
 */
export type ToolSelectionStrategy = 'all' | 'plan-narrowed' | 'search' | 'auto'

/** Per-phase generation budgets (max output tokens). */
export interface PhaseBudgets {
  planner?: number
  executor?: number
  replanner?: number
  synthesizer?: number
}

export interface BrowserAgentConfig {
  /** The default (executor) model: a ready AI SDK model, or a ProviderModelSpec to resolve. */
  model: ModelInput
  /** Optional per-stage model overrides. A partial override inherits base provider/creds. */
  planner?: StageInput
  synthesizer?: StageInput
  /** Fetches API keys for ProviderModelSpec models. Default: none (inline keys only). */
  credentials?: CredentialStore
  /** Propagated to the openai-compatible provider name and the MCP client. */
  clientName?: string

  /** Host tools the executor may call (an AI SDK ToolSet; use defineTool). */
  tools?: AgentToolSet
  /** Whitelist: only these tool names from `tools` are mounted (default: all). */
  availableTools?: string[]
  /** Blacklist: these tool names are removed after the whitelist is applied. */
  excludedTools?: string[]
  /** Force native/prompted tool-calling; 'auto' picks per model (default 'auto'). */
  toolMode?: ToolMode
  /** How the executor sees the tool catalogue (default 'auto'). */
  toolSelectionStrategy?: ToolSelectionStrategy
  /** Catalogue size above which 'auto' switches to 'search' (default 40). */
  toolSearchThreshold?: number
  /** Consent policy for tool calls: autopilot, ask before writes, ask always, read-only. */
  toolApproval?: ToolApprovalConfig

  /** Reusable instruction bundles (SKILL.md) the planner/executor can pull in. */
  skills?: Skill[]

  /** Prepended to every phase's system prompt. */
  systemPrompt?: string
  /** Override any phase prompt builder. */
  prompts?: Partial<Prompts>
  /** Serialize the host's current world state into prompt context (grounding). */
  describeState?: () => string | Promise<string>

  /**
   * Persist the transcript (e.g. new IndexedDBStore()). The last few messages
   * are also read back into the planner prompt, so follow-up goals can refer
   * to earlier turns.
   */
  memory?: ContextStore
  sessionId?: string

  /** Hard cap on executed steps incl. replans (default 8). */
  maxIterations?: number
  /** Cap on tool-calling rounds inside one executor call, both modes (default 4). */
  maxStepsPerTask?: number
  /** Cap on replanner "revise" decisions per run (default 2). */
  maxRevisions?: number
  /** Cap on tool calls per run (default: unlimited). */
  maxToolCalls?: number
  /** Cap on the steps of one plan (default 8). */
  maxPlanSteps?: number
  /** Per-call timeout so a hang can't freeze a run (default 120000). */
  chatTimeoutMs?: number
  /** Legacy per-phase output caps; `limits.perCall` wins when both are set. */
  budgets?: PhaseBudgets
  /** Run-level token budgets (input / output / thinking / total) + per-call output caps. */
  limits?: TokenLimits
  temperature?: number

  /** Thinking for every stage: true, a level ('low'…'xhigh'), or { level, budgetTokens }. */
  thinking?: ThinkingSetting
  /** Per-stage thinking; a stage entry wins over `thinking`. */
  stageThinking?: Partial<Record<ThinkingStage, ThinkingSetting>>
  /** Provider prompt caching (default true): stable system prefixes + Anthropic breakpoints. */
  promptCaching?: PromptCachingSetting
  /** Context compaction (auto + manual `agent.compact()`); see CompactionConfig. */
  compaction?: CompactionConfig

  /** Master switch for the replan phase (default true). */
  replan?: boolean
  /** What triggers the replanner when it is on (default 'failure'). */
  replanAfter?: ReplanTrigger
  /** Write a final natural-language summary (default true). */
  synthesize?: boolean
  /**
   * Legacy: compress stored history past this many chars after each run
   * (0 = off). Used only when `compaction` is not set.
   */
  compressAfterChars?: number

  /** Verbosity: 'silent' | 'error' | 'warn' (default) | 'info' | 'debug'. */
  logLevel?: LogLevel
  /** Console-like sink the logs go to (default: the global console). */
  logger?: AgentLoggerSink
}

export interface ResolvedConfig {
  clientName: string
  sessionId: string
  toolMode: ToolMode
  toolSelectionStrategy: ToolSelectionStrategy
  toolSearchThreshold: number
  maxIterations: number
  maxStepsPerTask: number
  maxRevisions: number
  maxToolCalls: number
  maxPlanSteps: number
  chatTimeoutMs: number
  /** Effective per-call output caps (limits.perCall over budgets). */
  budgets: Required<PhaseBudgets> & { compaction: number }
  limits: TokenLimits
  temperature: number | undefined
  replan: boolean
  replanAfter: ReplanTrigger
  synthesize: boolean
  compressAfterChars: number
  compaction: ResolvedCompaction
  logLevel: LogLevel
}

export const resolveConfig = (c: BrowserAgentConfig): ResolvedConfig => ({
  clientName: c.clientName ?? 'agent-web',
  sessionId: c.sessionId ?? 'default',
  toolMode: c.toolMode ?? 'auto',
  toolSelectionStrategy: c.toolSelectionStrategy ?? 'auto',
  toolSearchThreshold: c.toolSearchThreshold ?? 40,
  maxIterations: c.maxIterations ?? 8,
  maxStepsPerTask: c.maxStepsPerTask ?? 4,
  maxRevisions: c.maxRevisions ?? 2,
  maxToolCalls: c.maxToolCalls ?? 0,
  maxPlanSteps: c.maxPlanSteps ?? 8,
  chatTimeoutMs: c.chatTimeoutMs ?? 120_000,
  budgets: {
    planner: c.limits?.perCall?.planner ?? c.budgets?.planner ?? 800,
    executor: c.limits?.perCall?.executor ?? c.budgets?.executor ?? 1200,
    replanner: c.limits?.perCall?.replanner ?? c.budgets?.replanner ?? 400,
    synthesizer: c.limits?.perCall?.synthesizer ?? c.budgets?.synthesizer ?? 400,
    compaction: c.limits?.perCall?.compaction ?? c.compaction?.summaryMaxTokens ?? 1024,
  },
  limits: c.limits ?? {},
  temperature: c.temperature,
  replan: c.replan ?? true,
  replanAfter: c.replanAfter ?? 'failure',
  synthesize: c.synthesize ?? true,
  compressAfterChars: c.compressAfterChars ?? 12_000,
  compaction: resolveCompaction(c.compaction),
  logLevel: c.logLevel ?? 'warn',
})
