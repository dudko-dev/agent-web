import type { LanguageModel } from 'ai'
import type { BrowserAgentConfig, ResolvedConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import type { Prompts, ToolCallMode } from '../prompts.js'
import { withSystem } from '../prompts.js'
import type { AgentToolSet } from '../tools/types.js'

/** Everything the phase functions (planner/executor/replanner/synthesizer) share. */
export interface AgentContext {
  config: ResolvedConfig
  raw: BrowserAgentConfig
  plannerModel: LanguageModel
  executorModel: LanguageModel
  synthesizerModel: LanguageModel
  /** Tool-mode for the planner/replanner (from the planner model). */
  plannerMode: ToolCallMode
  /** Tool-mode for the executor (from the executor model). */
  executorMode: ToolCallMode
  tools: AgentToolSet
  toolCatalog: string
  prompts: Prompts
  emit: (event: AgentEvent) => void
  signal?: AbortSignal
  /** Current world state for grounding, or undefined when no describeState is configured. */
  state: () => Promise<string | undefined>
}

/** Prepend the host's systemPrompt to a phase system prompt. */
export const systemFor = (ctx: AgentContext, base: string): string =>
  withSystem(base, ctx.raw.systemPrompt)

export const aborted = (ctx: AgentContext): boolean => ctx.signal?.aborted === true
