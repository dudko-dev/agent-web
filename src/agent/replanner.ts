import { generate, generateStructured } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { parseReplannerResponse, type ReplanDecision } from '../parse.js'
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
  const parts = ctx.prompts.replanner({ goal, state, done, remaining, mode: ctx.plannerMode })
  const common = {
    system: systemFor(ctx, parts.system),
    prompt: parts.prompt,
    maxOutputTokens: ctx.config.budgets.replanner,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
  }

  try {
    if (ctx.plannerMode === 'native') {
      const result = await generateStructured(ctx.plannerModel, ReplanSchema, common)
      return {
        decision: result.object.decision,
        reason: result.object.reason,
        plan: result.object.plan ?? [],
        usage: normalizeUsage(result.usage),
      }
    }
    const result = await generate(ctx.plannerModel, common)
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
