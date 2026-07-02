import { generate } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { parsePlainText } from '../parse.js'
import type { IUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'

/**
 * Write the final natural-language summary of what the run accomplished. Plain
 * text only (parsePlainText strips any stray JSON). Falls back to a default
 * sentence if the model returns nothing usable.
 */
export const synthesizeAnswer = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
): Promise<{ text: string; usage: IUsage }> => {
  const state = await ctx.state()
  const parts = ctx.prompts.synthesizer({ goal, state, done })
  const result = await generate(ctx.synthesizerModel, {
    system: systemFor(ctx, parts.system),
    prompt: parts.prompt,
    maxOutputTokens: ctx.config.budgets.synthesizer,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
  })
  const clean = parsePlainText(result.text)
  return {
    text: clean || 'Done — the changes have been applied.',
    usage: normalizeUsage(result.usage),
  }
}
