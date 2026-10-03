import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'

/** What the scripted model answers for one call. */
export interface Reply {
  text?: string
  reasoning?: string
  toolCalls?: { name: string; args: unknown }[]
  usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number }
}

/** A readable view of one model call, for routing and assertions. */
export interface CallInfo {
  /** Concatenated system message text. */
  system: string
  /** Concatenated user message text. */
  user: string
  /** Number of tool results already in the conversation (multi-step position). */
  toolResults: number
  /** Names of the tools offered to the model on this call. */
  tools: string[]
  /** The raw call options the SDK passed to the model. */
  options: Record<string, unknown>
}

type Part = { type: string; text?: string }
type Message = { role: string; content: string | Part[]; providerOptions?: unknown }

const textOf = (content: Message['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .map((p) => (p.type === 'text' ? (p.text ?? '') : ''))
        .filter(Boolean)
        .join('\n')

export const infoOf = (options: Record<string, unknown>): CallInfo => {
  const prompt = (options.prompt ?? []) as Message[]
  return {
    system: prompt
      .filter((m) => m.role === 'system')
      .map((m) => textOf(m.content))
      .join('\n'),
    user: prompt
      .filter((m) => m.role === 'user')
      .map((m) => textOf(m.content))
      .join('\n'),
    toolResults: prompt.filter((m) => m.role === 'tool').length,
    tools: ((options.tools ?? []) as { name: string }[]).map((t) => t.name),
    options,
  }
}

const usageOf = (r: Reply) => {
  const input = r.usage?.input ?? 10
  const output = r.usage?.output ?? 5
  return {
    inputTokens: {
      total: input,
      noCache: input - (r.usage?.cacheRead ?? 0),
      cacheRead: r.usage?.cacheRead ?? 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: output,
      text: output - (r.usage?.reasoning ?? 0),
      reasoning: r.usage?.reasoning ?? 0,
    },
  }
}

let callSeq = 0

/**
 * A MockLanguageModelV4 whose every call is answered by `route(info)`. Both
 * doGenerate (structured output, prompted rounds) and doStream (native tool
 * loop, synthesizer) are implemented, including reasoning and tool calls.
 */
export const scriptedModel = (route: (info: CallInfo) => Reply) => {
  const calls: CallInfo[] = []
  const model = new MockLanguageModelV4({
    provider: 'scripted',
    modelId: 'scripted-1',
    // Accept links as-is (like Gemini / Claude), so the SDK never downloads them.
    supportedUrls: { '*/*': [/^https?:\/\//] },
    doGenerate: async (options: Record<string, unknown>) => {
      const info = infoOf(options)
      calls.push(info)
      const r = route(info)
      const content: unknown[] = []
      if (r.reasoning) content.push({ type: 'reasoning', text: r.reasoning })
      if (r.text !== undefined) content.push({ type: 'text', text: r.text })
      for (const c of r.toolCalls ?? []) {
        content.push({
          type: 'tool-call',
          toolCallId: `call-${(callSeq += 1)}`,
          toolName: c.name,
          input: JSON.stringify(c.args ?? {}),
        })
      }
      return {
        content,
        finishReason: { unified: r.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
        usage: usageOf(r),
        warnings: [],
      }
    },
    doStream: async (options: Record<string, unknown>) => {
      const info = infoOf(options)
      calls.push(info)
      const r = route(info)
      const chunks: unknown[] = [{ type: 'stream-start', warnings: [] }]
      if (r.reasoning) {
        chunks.push(
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: r.reasoning },
          { type: 'reasoning-end', id: 'r1' },
        )
      }
      if (r.text) {
        chunks.push(
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: r.text },
          { type: 'text-end', id: 't1' },
        )
      }
      for (const c of r.toolCalls ?? []) {
        chunks.push({
          type: 'tool-call',
          toolCallId: `call-${(callSeq += 1)}`,
          toolName: c.name,
          input: JSON.stringify(c.args ?? {}),
        })
      }
      chunks.push({
        type: 'finish',
        finishReason: { unified: r.toolCalls?.length ? 'tool-calls' : 'stop', raw: undefined },
        usage: usageOf(r),
      })
      return { stream: simulateReadableStream({ chunks }) }
    },
  } as never)
  return { model, calls }
}

/** Which agent stage a call belongs to (by the role marker in its system prompt). */
export const stageOf = (info: CallInfo): string => {
  if (info.system.includes('REPLANNER')) return 'replanner'
  if (info.system.includes('PLANNER')) return 'planner'
  if (info.system.includes('EXECUTOR')) return 'executor'
  if (info.system.includes('SYNTHESIZER')) return 'synthesizer'
  return 'other'
}
