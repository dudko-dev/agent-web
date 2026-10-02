import { stream } from '../llm/generate.js'
import { normalizeUsage } from '../llm/util.js'
import { looksLikeJson, parsePlainText } from '../parse.js'
import { renderActiveSkills } from '../skills.js'
import type { IUsage } from './loop-types.js'
import { stageCall, type AgentContext } from './internal.js'

/**
 * Write the final natural-language answer of the run, streaming it as
 * `final.text-delta` events (and thoughts as `final.reasoning-delta`). Plain
 * text only (parsePlainText strips any stray JSON; deltas are suppressed
 * entirely when the model drifts into JSON, so raw structure never reaches a
 * UI). Falls back to a default sentence if the model returns nothing usable.
 */
export const synthesizeAnswer = async (
  ctx: AgentContext,
  goal: string,
  done: string[],
  /** Excerpts of what the tools returned — the data the answer is made of. */
  findings: string[] = [],
): Promise<{ text: string; usage: IUsage }> => {
  const state = await ctx.state()
  const active = ctx.activeSkills?.() ?? []
  const parts = ctx.prompts.synthesizer({
    goal,
    state,
    done,
    findings,
    activeSkills: active.length ? renderActiveSkills(active) : undefined,
  })
  const result = stream(ctx.synthesizerModel, {
    ...stageCall(ctx, 'synthesizer', parts.system),
    prompt: parts.prompt,
    maxOutputTokens: ctx.config.budgets.synthesizer,
    temperature: ctx.config.temperature,
    abortSignal: ctx.signal,
    timeoutMs: ctx.config.chatTimeoutMs,
  })

  let text = ''
  let verdict: 'unknown' | 'emit' | 'suppress' = 'unknown'
  for await (const part of result.fullStream) {
    if (part.type === 'reasoning-delta') {
      if (part.text) ctx.emit({ type: 'final.reasoning-delta', delta: part.text })
      continue
    }
    if (part.type === 'error') {
      throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
    if (part.type !== 'text-delta') continue
    const delta = part.text
    text += delta
    if (verdict === 'unknown') {
      const lead = text.trimStart()
      if (!lead) continue
      // Inline <think> blocks (local reasoning models) are not part of the answer.
      if (lead.startsWith('<think>') && !text.includes('</think>')) continue
      verdict = looksLikeJson(lead) ? 'suppress' : 'emit'
      if (verdict === 'emit') {
        const visible = text.includes('</think>')
          ? text.slice(text.lastIndexOf('</think>') + '</think>'.length).trimStart()
          : text
        if (visible) ctx.emit({ type: 'final.text-delta', delta: visible })
      }
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
