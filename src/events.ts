import type { IPlan, IPlanStep, IStepResult, IUsage } from './agent/loop-types.js'

export type ReplanMode = 'continue' | 'revise' | 'finish'
export type Phase = 'plan' | 'execute' | 'replan' | 'synthesize'

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
  | { type: 'step.tool-call'; step: IPlanStep; name: string; input: unknown }
  | { type: 'step.tool-result'; step: IPlanStep; name: string; output: unknown; ok: boolean }
  | { type: 'step.complete'; step: IPlanStep; result: IStepResult }
  | { type: 'replan.decision'; mode: ReplanMode; reason: string }
  | { type: 'final.text-delta'; delta: string }
  | { type: 'final'; text: string }
  | { type: 'usage'; phase: Phase; usage: IUsage }
  | { type: 'retry'; phase: Phase; attempt: number; error: string }
  | { type: 'stopped' }
  | { type: 'error'; phase: Phase | 'run'; error: string }

export type AgentEventHandler = (event: AgentEvent) => void
