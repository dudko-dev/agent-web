import type { IStepResult } from './agent/loop-types.js'
import type { ContextStore } from './memory/store.js'
import type { AgentLoggerSink, LogLevel } from './logger.js'
import type { ModelInput, StageInput } from './providers/types.js'
import type { Prompts } from './prompts.js'
import type { CredentialStore } from './secrets/store.js'
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
 */
export type ToolSelectionStrategy = 'all' | 'plan-narrowed'

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
  toolSelectionStrategy?: ToolSelectionStrategy

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
  /** Per-call timeout so a hang can't freeze a run (default 120000). */
  chatTimeoutMs?: number
  budgets?: PhaseBudgets
  temperature?: number

  /** Master switch for the replan phase (default true). */
  replan?: boolean
  /** What triggers the replanner when it is on (default 'failure'). */
  replanAfter?: ReplanTrigger
  /** Write a final natural-language summary (default true). */
  synthesize?: boolean
  /** Compress stored history past this many chars (0 = off, default 12000). */
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
  maxIterations: number
  maxStepsPerTask: number
  maxRevisions: number
  chatTimeoutMs: number
  budgets: Required<PhaseBudgets>
  temperature: number | undefined
  replan: boolean
  replanAfter: ReplanTrigger
  synthesize: boolean
  compressAfterChars: number
  logLevel: LogLevel
}

export const resolveConfig = (c: BrowserAgentConfig): ResolvedConfig => ({
  clientName: c.clientName ?? 'agent-web',
  sessionId: c.sessionId ?? 'default',
  toolMode: c.toolMode ?? 'auto',
  toolSelectionStrategy: c.toolSelectionStrategy ?? 'all',
  maxIterations: c.maxIterations ?? 8,
  maxStepsPerTask: c.maxStepsPerTask ?? 4,
  maxRevisions: c.maxRevisions ?? 2,
  chatTimeoutMs: c.chatTimeoutMs ?? 120_000,
  budgets: {
    planner: c.budgets?.planner ?? 800,
    executor: c.budgets?.executor ?? 1200,
    replanner: c.budgets?.replanner ?? 400,
    synthesizer: c.budgets?.synthesizer ?? 400,
  },
  temperature: c.temperature,
  replan: c.replan ?? true,
  replanAfter: c.replanAfter ?? 'failure',
  synthesize: c.synthesize ?? true,
  compressAfterChars: c.compressAfterChars ?? 12_000,
  logLevel: c.logLevel ?? 'warn',
})
