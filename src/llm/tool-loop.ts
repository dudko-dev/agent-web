import {
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type { IToolCall, IUsage } from '../agent/loop-types.js'
import { parseExecutorResponse } from '../parse.js'
import { dispatch } from '../tools/prompted.js'
import { normalizeUsage, promptOf, timeoutSignal } from './util.js'

export interface ToolLoopCallbacks {
  onTextDelta?: (delta: string) => void
  onToolCall?: (name: string, input: unknown) => void
  onToolResult?: (name: string, output: unknown, ok: boolean) => void
}

export interface ToolLoopOptions {
  /** 'native' = SDK function-calling; 'prompted' = parse JSON out of plain text. */
  mode: 'native' | 'prompted'
  system?: string
  prompt?: string
  messages?: ModelMessage[]
  /** In native mode: the callable tools. In prompted mode: used to dispatch salvaged calls. */
  tools: ToolSet
  /**
   * Restrict callable tools to these names (plan-narrowed). Native mode passes
   * them to the SDK's `activeTools`; prompted mode bounds `dispatch` to them.
   */
  activeTools?: string[]
  /** Native mode: cap on internal tool-calling steps (default 4). */
  maxSteps?: number
  maxOutputTokens?: number
  temperature?: number
  abortSignal?: AbortSignal
  timeoutMs?: number
  callbacks?: ToolLoopCallbacks
}

export interface ToolLoopResult {
  text: string
  toolCalls: IToolCall[]
  usage: IUsage
}

/**
 * Run one round of tool-calling in whichever mode the model needs, returning a
 * normalised result. Native mode streams the SDK's multi-step function-calling;
 * prompted mode does a single generation, salvages a `{ reply, actions }` JSON
 * from the text, and dispatches each action through the tool's own execute.
 * Both call the exact same tool implementations.
 */
export const runToolLoop = (
  model: LanguageModel,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> =>
  opts.mode === 'prompted' ? runPrompted(model, opts) : runNative(model, opts)

const runNative = async (model: LanguageModel, opts: ToolLoopOptions): Promise<ToolLoopResult> => {
  const toolCalls: IToolCall[] = []
  const pending = new Map<string, { name: string; input: unknown }>()

  const result = streamText({
    model,
    tools: opts.tools,
    ...(opts.activeTools ? { activeTools: opts.activeTools } : {}),
    stopWhen: stepCountIs(opts.maxSteps ?? 4),
    system: opts.system,
    ...promptOf(opts),
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
  })

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'text-delta':
        if (part.text) opts.callbacks?.onTextDelta?.(part.text)
        break
      case 'tool-call':
        pending.set(part.toolCallId, { name: part.toolName, input: part.input })
        opts.callbacks?.onToolCall?.(part.toolName, part.input)
        break
      case 'tool-result': {
        const known = pending.get(part.toolCallId)
        toolCalls.push({
          name: part.toolName,
          input: known?.input ?? part.input,
          output: part.output,
          ok: true,
        })
        opts.callbacks?.onToolResult?.(part.toolName, part.output, true)
        pending.delete(part.toolCallId)
        break
      }
      case 'tool-error': {
        const known = pending.get(part.toolCallId)
        toolCalls.push({
          name: part.toolName,
          input: known?.input ?? part.input,
          output: part.error,
          ok: false,
        })
        opts.callbacks?.onToolResult?.(part.toolName, part.error, false)
        pending.delete(part.toolCallId)
        break
      }
      case 'error':
        throw part.error instanceof Error ? part.error : new Error(String(part.error))
    }
  }

  const [text, usage] = await Promise.all([result.text, result.usage])
  return { text: text.trim(), toolCalls, usage: normalizeUsage(usage) }
}

const runPrompted = async (
  model: LanguageModel,
  opts: ToolLoopOptions,
): Promise<ToolLoopResult> => {
  // Prompted mode does NOT pass tools to the SDK — the tool catalogue is
  // already rendered into the prompt (see tools/prompted.ts renderCatalog); the
  // model replies with JSON, which we salvage and dispatch ourselves.
  const result = await generateText({
    model,
    system: opts.system,
    ...promptOf(opts),
    maxOutputTokens: opts.maxOutputTokens,
    temperature: opts.temperature,
    abortSignal: timeoutSignal(opts.abortSignal, opts.timeoutMs),
  })

  const parsed = parseExecutorResponse(result.text)
  // Surface the parsed human reply, never the raw JSON envelope.
  if (parsed.reply) opts.callbacks?.onTextDelta?.(parsed.reply)

  const active = opts.activeTools
  const tools = active
    ? Object.fromEntries(Object.entries(opts.tools).filter(([name]) => active.includes(name)))
    : opts.tools
  const toolCalls: IToolCall[] = []
  for (const action of parsed.actions) {
    opts.callbacks?.onToolCall?.(action.tool, action.args)
    const rec = await dispatch(action, tools, { abortSignal: opts.abortSignal })
    toolCalls.push(rec)
    opts.callbacks?.onToolResult?.(rec.name, rec.output, rec.ok)
  }
  return { text: parsed.reply, toolCalls, usage: normalizeUsage(result.usage) }
}
