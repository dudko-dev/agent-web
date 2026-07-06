import type { ReplanTrigger } from '../config.js'
import { runToolLoop } from '../llm/tool-loop.js'
import { timeoutSignal } from '../llm/util.js'
import { renderCatalog } from '../tools/prompted.js'
import { BLOCKER, type IPlanStep, type IStepResult, type IUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'

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
  // Under plan-narrowed selection the prompted path must also see the narrowed
  // catalogue — the prompt is its only tool surface (native mode gets the SDK's
  // activeTools instead and never renders the catalogue).
  const active = activeToolNames(ctx, step)
  const toolCatalog =
    active === undefined
      ? ctx.toolCatalog
      : renderCatalog(Object.fromEntries(active.map((name) => [name, ctx.tools[name]])))
  const parts = ctx.prompts.executor({
    goal,
    state,
    step: step.description,
    index,
    total,
    toolCatalog,
    done,
    mode: ctx.executorMode,
  })

  const loop = await runToolLoop(ctx.executorModel, {
    mode: ctx.executorMode,
    system: systemFor(ctx, parts.system),
    prompt: parts.prompt,
    tools: ctx.tools,
    activeTools: active,
    maxSteps: ctx.config.maxStepsPerTask,
    maxOutputTokens: ctx.config.budgets.executor,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
    callbacks: {
      onTextDelta: (delta) => ctx.emit({ type: 'step.text-delta', step, delta }),
      onToolCall: (name, input) => {
        ctx.log.info(`tool call: ${name}`, input)
        ctx.emit({ type: 'step.tool-call', step, name, input })
      },
      onToolResult: (name, output, ok) => {
        ctx.log.debug(`tool result: ${name} ${ok ? 'ok' : 'FAILED'}`, output)
        ctx.emit({ type: 'step.tool-result', step, name, output, ok })
      },
    },
  })
  ctx.log.debug('executor text:', loop.text)

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

/**
 * The replanner runs when a step was blocked or a tool call failed and stayed
 * failed. A failure that a LATER call to the same tool retried successfully is
 * resolved — the prompted feedback loop (and native multi-step) let the model
 * self-correct within the step, so it must not force a replan.
 */
export const shouldReplan = (result: IStepResult): boolean => {
  if (result.blocked) return true
  const { toolCalls } = result
  return toolCalls.some(
    (c, i) => !c.ok && !toolCalls.slice(i + 1).some((later) => later.ok && later.name === c.name),
  )
}

/** Bound a host `replanAfter` predicate by the same watchdog/abort as a model call. */
export interface ReplanWantedOptions {
  signal?: AbortSignal
  timeoutMs?: number
  /** Called with whatever a host predicate threw before falling back to 'failure'. */
  onError?: (err: unknown) => void
}

/**
 * Resolve the configured `replanAfter` trigger for one step result. 'failure'
 * is the classic `shouldReplan`; 'always' consults the replanner after every
 * step; a host predicate decides per result. A predicate that throws, rejects,
 * or outlives the watchdog/abort falls back to 'failure' behaviour so a buggy
 * or hung predicate can never stall the run (its throw is surfaced via onError).
 */
export const replanWanted = async (
  trigger: ReplanTrigger,
  result: IStepResult,
  opts: ReplanWantedOptions = {},
): Promise<boolean> => {
  if (trigger === 'always') return true
  if (typeof trigger !== 'function') return shouldReplan(result)

  const fallback = (): boolean => shouldReplan(result)
  // Never rejects: a sync throw or async rejection resolves to the fallback.
  const decided = (async () => {
    try {
      return Boolean(await trigger(result))
    } catch (err) {
      opts.onError?.(err)
      return fallback()
    }
  })()

  const guard = timeoutSignal(opts.signal, opts.timeoutMs)
  if (!guard) return decided
  return Promise.race([
    decided,
    new Promise<boolean>((resolve) => {
      if (guard.aborted) resolve(fallback())
      else guard.addEventListener('abort', () => resolve(fallback()), { once: true })
    }),
  ])
}
