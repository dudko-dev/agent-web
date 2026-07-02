import { generate, generateStructured } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { parsePlannerResponse } from '../parse.js'
import type { ToolCallMode } from '../prompts.js'
import type { IPlan, IUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'
import { PlanSchema } from './schemas.js'

const toSteps = (
  raw: { description: string; expectedOutcome?: string; suggestedTools?: string[] }[],
): IPlan['steps'] =>
  raw
    .filter((s) => s.description && s.description.trim())
    .map((s, i) => ({
      id: `s${i + 1}`,
      description: s.description.trim(),
      expectedOutcome: s.expectedOutcome,
      suggestedTools: s.suggestedTools,
    }))

/**
 * Build the initial plan. Native mode uses generateObject(PlanSchema); prompted
 * mode salvages `{ reply, plan }` from plain text. Native failures (a weak model
 * that can't satisfy the schema) fall back to the prompted parse rather than
 * throwing, so the run degrades gracefully. An empty `steps` list signals the
 * runner to answer directly (greeting / question / unclear).
 */
export const createPlan = async (
  ctx: AgentContext,
  goal: string,
): Promise<{ plan: IPlan; usage: IUsage }> => {
  const state = await ctx.state()
  const commonFor = (mode: ToolCallMode) => {
    const parts = ctx.prompts.planner({
      goal,
      state,
      toolCatalog: ctx.toolCatalog,
      mode,
      history: ctx.history,
    })
    return {
      system: systemFor(ctx, parts.system),
      prompt: parts.prompt,
      maxOutputTokens: ctx.config.budgets.planner,
      temperature: ctx.config.temperature,
      abortSignal: ctx.signal,
      timeoutMs: ctx.config.chatTimeoutMs,
    }
  }

  if (ctx.plannerMode === 'native') {
    try {
      const result = await generateStructured(ctx.plannerModel, PlanSchema, commonFor('native'))
      return {
        plan: { thought: result.object.thought, steps: toSteps(result.object.steps) },
        usage: normalizeUsage(result.usage),
      }
    } catch (err) {
      // Graceful degradation: fall back to the salvage parser instead of failing.
      ctx.emit({ type: 'retry', phase: 'plan', attempt: 1, error: asMessage(err) })
    }
  }

  // The prompted path — also the fallback after a native failure. Rendered with
  // mode 'prompted' so the model gets explicit JSON-shape instructions even
  // when the schema-constrained call just failed.
  const result = await generate(ctx.plannerModel, commonFor('prompted'))
  const parsed = parsePlannerResponse(result.text)
  return {
    plan: {
      thought: parsed.reply,
      steps: toSteps(parsed.plan.map((description) => ({ description }))),
    },
    usage: normalizeUsage(result.usage),
  }
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))
