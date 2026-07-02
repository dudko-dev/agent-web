/** A single step of a plan. Mirrors the Node sibling's IPlanStep. */
export interface IPlanStep {
  id: string
  description: string
  expectedOutcome?: string
  /** Tools the planner thinks this step needs (drives 'plan-narrowed' selection). */
  suggestedTools?: string[]
  /** Set by the pipeline when suggestedTools were named but all were unknown. */
  requiresTools?: boolean
}

export interface IPlan {
  thought: string
  steps: IPlanStep[]
}

export interface IUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface IToolCall {
  name: string
  input: unknown
  output: unknown
  ok: boolean
}

export interface IStepResult {
  step: IPlanStep
  summary: string
  toolCalls: IToolCall[]
  /** True when the executor signalled it could not complete the step ([BLOCKER]). */
  blocked: boolean
}

export const emptyUsage = (): IUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })

export const addUsage = (a: IUsage, b: IUsage): IUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
})
