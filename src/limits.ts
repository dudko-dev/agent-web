import type { IUsage } from './agent/loop-types.js'

/**
 * Run-level token budgets. Every cap is cumulative over one `run()` and soft:
 * it is checked between steps and at every tool-calling round inside a step,
 * so a run stops at the next boundary after crossing it and then writes its
 * final answer (synthesis still runs, bounded by `perCall.synthesizer`).
 */
export interface TokenLimits {
  /** Cumulative input (prompt) tokens per run. */
  maxInputTokens?: number
  /** Cumulative output tokens per run, thinking included. */
  maxOutputTokens?: number
  /** Cumulative thinking tokens per run. */
  maxReasoningTokens?: number
  /** Cumulative input + output tokens per run. */
  maxTotalTokens?: number
  /** Max output tokens of ONE model call, per phase (wins over the legacy `budgets`). */
  perCall?: {
    planner?: number
    executor?: number
    replanner?: number
    synthesizer?: number
    compaction?: number
  }
}

export type LimitKind = 'input' | 'output' | 'reasoning' | 'total' | 'tool-calls'

export interface LimitBreach {
  kind: LimitKind
  tokens: number
  cap: number
}

const over = (value: number | undefined, cap: number | undefined): boolean =>
  typeof cap === 'number' && cap > 0 && (value ?? 0) >= cap

/**
 * The first cap the usage has reached, or undefined. Order: total, input,
 * output, reasoning — the broadest budget is reported first. Pure.
 */
export const checkLimits = (
  usage: IUsage,
  limits: TokenLimits | undefined,
): LimitBreach | undefined => {
  if (!limits) return undefined
  if (over(usage.totalTokens, limits.maxTotalTokens)) {
    return { kind: 'total', tokens: usage.totalTokens, cap: limits.maxTotalTokens as number }
  }
  if (over(usage.inputTokens, limits.maxInputTokens)) {
    return { kind: 'input', tokens: usage.inputTokens, cap: limits.maxInputTokens as number }
  }
  if (over(usage.outputTokens, limits.maxOutputTokens)) {
    return { kind: 'output', tokens: usage.outputTokens, cap: limits.maxOutputTokens as number }
  }
  if (over(usage.reasoningTokens, limits.maxReasoningTokens)) {
    return {
      kind: 'reasoning',
      tokens: usage.reasoningTokens ?? 0,
      cap: limits.maxReasoningTokens as number,
    }
  }
  return undefined
}

/** Raised by a tool call that would exceed `maxToolCalls`. */
export class ToolBudgetError extends Error {
  constructor(cap: number) {
    super(
      `Tool-call budget exhausted (${cap} per run). Do not call more tools; report what you have.`,
    )
    this.name = 'ToolBudgetError'
  }

  toJSON(): string {
    return this.message
  }
}
