import type { IPlan, IPlanStep, IStepResult, IUsage } from './agent/loop-types.js'
import type { LimitKind } from './limits.js'

export type ReplanMode = 'continue' | 'revise' | 'finish'
export type Phase = 'plan' | 'execute' | 'replan' | 'synthesize'
/** Phases a `usage` event can be charged to: the four stages plus compaction and subagents. */
export type UsagePhase = Phase | 'compact' | 'subagent'

/**
 * Everything the agent does is streamed as a typed event so any UI (or none)
 * can render progress. The final answer arrives as a `final` event; there is no
 * built-in rendering. This is a browser-focused subset of the Node sibling's
 * event taxonomy (no persistence/otel events), plus `model.load` for WebLLM
 * weight-download progress.
 */
export type AgentEvent =
  | { type: 'run.start'; goal: string }
  | { type: 'model.load'; progress: number; text: string }
  | { type: 'plan.thought-delta'; delta: string }
  | { type: 'plan.step-added'; step: IPlanStep; index: number }
  | { type: 'plan.created'; plan: IPlan }
  | { type: 'plan.revised'; plan: IPlan; reason: string }
  | { type: 'step.start'; step: IPlanStep; index: number; total: number }
  | { type: 'step.text-delta'; step: IPlanStep; delta: string }
  /** The executor model's streamed thoughts (thinking enabled + provider support). */
  | { type: 'step.reasoning-delta'; step: IPlanStep; delta: string }
  | { type: 'step.tool-call'; step: IPlanStep; name: string; input: unknown }
  | { type: 'step.tool-result'; step: IPlanStep; name: string; output: unknown; ok: boolean }
  | { type: 'step.complete'; step: IPlanStep; result: IStepResult }
  | { type: 'replan.decision'; mode: ReplanMode; reason: string }
  | { type: 'final.text-delta'; delta: string }
  /** The synthesizer's streamed thoughts. */
  | { type: 'final.reasoning-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'usage'; phase: UsagePhase; usage: IUsage }
  | { type: 'retry'; phase: Phase; attempt: number; error: string }
  /** A run-level limit was reached; the run stops executing and writes its answer. */
  | { type: 'budget.exceeded'; kind: LimitKind; tokens: number; cap: number }
  /** Older context was summarised to fit the window. */
  | {
      type: 'context.compacted'
      /** history = stored transcript; trace = the run's done steps; tool-results = stale results inside a step's tool loop. */
      scope: 'history' | 'trace' | 'tool-results'
      beforeTokens: number
      afterTokens: number
    }
  /** A skill's instructions entered the context (picked by the planner, or loaded by a tool call). */
  | { type: 'skill.activated'; name: string; by: 'plan' | 'tool' }
  /** find_tools activated more tools (large-catalogue search mode). */
  | { type: 'tools.discovered'; step?: IPlanStep; query: string; names: string[] }
  /** A tool call is waiting for the user's consent (see `toolApproval`). */
  | {
      type: 'tool.approval-requested'
      id: string
      name: string
      input: unknown
      readOnly: boolean
      step?: IPlanStep
    }
  /** A consent decision: from the user, or `automatic` (policy denial). */
  | {
      type: 'tool.approval-resolved'
      id: string
      name: string
      approved: boolean
      reason?: string
      automatic: boolean
    }
  | { type: 'subagent.start'; id: string; name: string; task: string }
  /** An event of a running subagent, forwarded verbatim. */
  | { type: 'subagent.event'; id: string; name: string; event: AgentEvent }
  | { type: 'subagent.complete'; id: string; name: string; text: string; usage: IUsage }
  | { type: 'subagent.error'; id: string; name: string; error: string }
  | { type: 'stopped' }
  | { type: 'error'; phase: Phase | 'run'; error: string }

export type AgentEventHandler = (event: AgentEvent) => void
