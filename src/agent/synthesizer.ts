import { stream } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { looksLikeJson, parsePlainText } from '../parse.js'
import type { IUsage } from './loop-types.js'
import { systemFor, type AgentContext } from './internal.js'

/**
 * Write the final natural-language summary of what the run accomplished,
 * streaming it as `final.text-delta` events. Plain text only (parsePlainText
 * strips any stray JSON; deltas are suppressed entirely when the model drifts
 * into JSON, so raw structure never reaches a UI). Falls back to a default
 * sentence if the model returns nothing usable.
 */
export const synthesizeAnswer = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
): Promise<{ text: string; usage: IUsage }> => {
  const state = await ctx.state()
  const parts = ctx.prompts.synthesizer({ goal, state, done })
  const result = stream(ctx.synthesizerModel, {
    system: systemFor(ctx, parts.system),
    prompt: parts.prompt,
    maxOutputTokens: ctx.config.budgets.synthesizer,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
  })

  let text = ''
  let verdict: 'unknown' | 'emit' | 'suppress' = 'unknown'
  for await (const delta of result.textStream) {
    text += delta
    if (verdict === 'unknown') {
      const lead = text.trimStart()
      if (!lead) continue
      verdict = looksLikeJson(lead) ? 'suppress' : 'emit'
      if (verdict === 'emit') ctx.emit({ type: 'final.text-delta', delta: text })
    } else if (verdict === 'emit') {
      ctx.emit({ type: 'final.text-delta', delta })
    }
  }

  const clean = parsePlainText(text)
  return {
    text: clean || 'Done — the changes have been applied.',
    usage: normalizeUsage(await result.usage),
  }
}
