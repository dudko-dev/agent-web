import { runToolLoop } from '../llm/tool-loop.js'
import type { IPlanStep, IStepResult, IUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'

const BLOCKER = '[BLOCKER]'

/**
 * Split the executor's reply into a clean summary and a structural `blocked`
 * flag. The [BLOCKER] sentinel — emitted by the executor when it can't complete
 * a step — is language-agnostic and drives the replanner; we strip every copy
 * so it never leaks into downstream prompts.
 */
export const splitBlocker = (raw: string): { summary: string; blocked: boolean } => {
  if (!raw.includes(BLOCKER)) return { summary: raw.trim(), blocked: false }
  return { summary: raw.split(BLOCKER).join('').trim(), blocked: true }
}

const activeToolNames = (ctx: AgentContext, step: IPlanStep): string[] | undefined => {
  if (ctx.config.toolSelectionStrategy !== 'plan-narrowed') return undefined
  const suggested = step.suggestedTools ?? []
  const known = suggested.filter((n) => ctx.tools[n])
  // A step that named tools but all were unknown still wants tools: fall back to
  // the full set rather than stalling with zero.
  if (known.length === 0 && suggested.length > 0) return Object.keys(ctx.tools)
  return known
}

const summaryOf = (text: string, toolCallCount: number): string => {
  if (text.length > 0) return text
  return toolCallCount > 0 ? `Executed ${toolCallCount} tool call(s).` : 'Step produced no output.'
}

/** Execute one plan step: run the tool loop (native or prompted) and emit events. */
export const executeStep = async (
  ctx: AgentContext,
  goal: string,
  step: IPlanStep,
  index: number,
  total: number,
  done: string[],
): Promise<{ result: IStepResult; usage: IUsage }> => {
  const state = await ctx.state()
  const parts = ctx.prompts.executor({
    goal,
    state,
    step: step.description,
    index,
    total,
    toolCatalog: ctx.toolCatalog,
    done,
    mode: ctx.executorMode,
  })

  const loop = await runToolLoop(ctx.executorModel, {
    mode: ctx.executorMode,
    system: systemFor(ctx, parts.system),
    prompt: parts.prompt,
    tools: ctx.tools,
    activeTools: activeToolNames(ctx, step),
    maxSteps: ctx.config.maxStepsPerTask,
    maxOutputTokens: ctx.config.budgets.executor,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
    callbacks: {
      onTextDelta: (delta) => ctx.emit({ type: 'step.text-delta', step, delta }),
      onToolCall: (name, input) => ctx.emit({ type: 'step.tool-call', step, name, input }),
      onToolResult: (name, output, ok) =>
        ctx.emit({ type: 'step.tool-result', step, name, output, ok }),
    },
  })

  const { summary, blocked } = splitBlocker(loop.text)
  return {
    result: {
      step,
      summary: summaryOf(summary, loop.toolCalls.length),
      toolCalls: loop.toolCalls,
      blocked,
    },
    usage: loop.usage,
  }
}

/** The replanner runs when a step was blocked or any of its tool calls failed. */
export const shouldReplan = (result: IStepResult): boolean =>
  result.blocked || result.toolCalls.some((c) => !c.ok)
