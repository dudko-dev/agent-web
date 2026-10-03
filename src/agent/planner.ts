import { generate, generateStructured } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { parsePlannerResponse } from '../parse.js'
import type { ToolCallMode } from '../prompts.js'
import { renderSkillIndex } from '../skills.js'
import type { IPlan, IUsage } from './loop-types.js'
import { imageRefusal, promptFor, stageCall, type AgentContext } from './internal.js'
import { PlanSchema } from './schemas.js'

const toSteps = (
  raw: { description: string; expectedOutcome?: string; suggestedTools?: string[] }[],
  cap: number,
): IPlan['steps'] =>
  raw
    .filter((s) => s.description && s.description.trim())
    .slice(0, Math.max(1, cap))
    .map((s, i) => ({
      id: `s${i + 1}`,
      description: s.description.trim(),
      expectedOutcome: s.expectedOutcome,
      suggestedTools: s.suggestedTools,
    }))

export interface PlanOutcome {
  plan: IPlan
  usage: IUsage
  /** Names of configured skills the planner picked (validated). */
  skills: string[]
}

/**
 * Build the initial plan. Native mode uses generateObject(PlanSchema); prompted
 * mode salvages `{ reply, plan }` from plain text. Native failures (a weak model
 * that can't satisfy the schema) fall back to the prompted parse rather than
 * throwing, so the run degrades gracefully. An empty `steps` list signals the
 * runner to answer directly (greeting / small talk).
 */
export const createPlan = async (
  ctx: AgentContext,
  goal: string,
  /** Extra instruction appended to the goal (used by the empty-plan retry). */
  nudge?: string,
): Promise<PlanOutcome> => {
  const state = await ctx.state()
  const effectiveGoal = nudge ? `${goal}\n\n${nudge}` : goal
  const skillIndex = ctx.skills?.length ? renderSkillIndex(ctx.skills) : undefined
  const cap = ctx.config.maxPlanSteps
  const commonFor = (mode: ToolCallMode) => {
    const parts = ctx.prompts.planner({
      goal: effectiveGoal,
      state,
      toolCatalog: ctx.toolCatalog,
      mode,
      history: ctx.history,
      skills: skillIndex,
      searchMode: ctx.strategy === 'search',
    })
    return {
      ...stageCall(ctx, 'planner', parts.system),
      ...promptFor(ctx, parts.prompt),
      maxOutputTokens: ctx.config.budgets.planner,
      temperature: ctx.config.temperature,
      abortSignal: ctx.signal,
      timeoutMs: ctx.config.chatTimeoutMs,
    }
  }
  const validSkills = (names: string[] | undefined): string[] => {
    const known = new Set((ctx.skills ?? []).map((s) => s.name))
    const picked = [...new Set(names ?? [])]
    const kept = picked.filter((n) => known.has(n))
    if (kept.length < picked.length) {
      ctx.log.warn(
        'planner picked unknown skills, dropped:',
        picked.filter((n) => !known.has(n)),
      )
    }
    return kept
  }

  if (ctx.plannerMode === 'native') {
    try {
      const result = await generateStructured(ctx.plannerModel, PlanSchema, commonFor('native'))
      ctx.log.debug('planner (native):', result.object)
      return {
        plan: { thought: result.object.thought, steps: toSteps(result.object.steps, cap) },
        usage: normalizeUsage(result.usage),
        skills: validSkills(result.object.skills),
      }
    } catch (err) {
      // An abort is a stop, not a schema failure — don't spend a fallback call.
      if (ctx.signal?.aborted) throw err
      // A refused image is not a schema problem either: say so clearly.
      const refused = imageRefusal(ctx, err, ctx.plannerModel)
      if (refused) throw refused
      // Graceful degradation: fall back to the salvage parser instead of failing.
      ctx.log.warn('planner: native structured output failed, salvaging:', asMessage(err))
      ctx.emit({ type: 'retry', phase: 'plan', attempt: 1, error: asMessage(err) })
    }
  }

  // The prompted path — also the fallback after a native failure. Rendered with
  // mode 'prompted' so the model gets explicit JSON-shape instructions even
  // when the schema-constrained call just failed.
  const result = await generate(ctx.plannerModel, commonFor('prompted')).catch((err: unknown) => {
    throw imageRefusal(ctx, err, ctx.plannerModel) ?? err
  })
  const parsed = parsePlannerResponse(result.text)
  ctx.log.debug('planner (prompted) raw:', result.text)
  ctx.log.debug('planner (prompted) parsed:', parsed)
  return {
    plan: {
      thought: parsed.reply,
      steps: toSteps(
        parsed.plan.map((description) => ({ description })),
        cap,
      ),
    },
    usage: normalizeUsage(result.usage),
    skills: validSkills(parsed.skills),
  }
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
