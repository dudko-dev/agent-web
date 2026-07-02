import { z } from 'zod'

/**
 * Structured-output schemas for the native path (generateObject). Kept free of
 * `.max()`/`.min()` constraints — some providers reject or mis-handle them in
 * JSON-schema mode; we cap/clean in code instead (see parse.ts normalizeSteps).
 */
export const PlanStepSchema = z.object({
  description: z.string(),
  expectedOutcome: z.string().optional(),
  suggestedTools: z.array(z.string()).optional(),
})

export const PlanSchema = z.object({
  /** One short sentence. For a greeting/question/unclear request, holds the answer and steps is empty. */
  thought: z.string(),
  steps: z.array(PlanStepSchema),
})

export const ReplanSchema = z.object({
  decision: z.enum(['continue', 'revise', 'finish']),
  reason: z.string(),
  /** Replacement for the REMAINING steps when decision is 'revise'. */
  plan: z.array(z.string()).optional(),
})

export type PlanShape = z.infer<typeof PlanSchema>
export type ReplanShape = z.infer<typeof ReplanSchema>
