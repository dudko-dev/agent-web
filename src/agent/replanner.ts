import { generate, generateStructured } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { parseReplannerResponse, type ReplanDecision } from '../parse.js'
import type { ToolCallMode } from '../prompts.js'
import type { IUsage } from './loop-types.js'
import { emptyUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'
import { ReplanSchema } from './schemas.js'

export interface ReplanOutcome {
  decision: ReplanDecision
  reason: string
  /** Replacement remaining steps (descriptions) when decision is 'revise'. */
  plan: string[]
  usage: IUsage
}

/**
 * Decide whether to continue, revise the remaining plan, or finish, after a
 * blocked/failed step. Native mode uses generateObject(ReplanSchema); prompted
 * mode salvages the decision from text. Any failure degrades to 'continue' so a
 * flaky replanner never aborts the run.
 */
export const decideReplan = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
  remaining: string[],
): Promise<ReplanOutcome> => {
  const state = await ctx.state()
  const commonFor = (mode: ToolCallMode) => {
    const parts = ctx.prompts.replanner({ goal, state, done, remaining, mode })
    return {
      system: systemFor(ctx, parts.system),
      prompt: parts.prompt,
      maxOutputTokens: ctx.config.budgets.replanner,
      temperature: ctx.config.temperature,
      abortSignal: ctx.signal,
      timeoutMs: ctx.config.chatTimeoutMs,
    }
  }

  if (ctx.plannerMode === 'native') {
    try {
      const result = await generateStructured(ctx.plannerModel, ReplanSchema, commonFor('native'))
      return {
        decision: result.object.decision,
        reason: result.object.reason,
        plan: result.object.plan ?? [],
        usage: normalizeUsage(result.usage),
      }
    } catch {
      /* fall through to the prompted salvage below */
    }
  }

  try {
    // The prompted path — also the fallback after a native failure, re-rendered
    // with explicit JSON-shape instructions.
    const result = await generate(ctx.plannerModel, commonFor('prompted'))
    const parsed = parseReplannerResponse(result.text)
    return {
      decision: parsed.decision,
      reason: parsed.reason,
      plan: parsed.plan,
      usage: normalizeUsage(result.usage),
    }
  } catch {
    return { decision: 'continue', reason: 'replanner unavailable', plan: [], usage: emptyUsage() }
  }
}
