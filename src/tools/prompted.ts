import type { ModelMessage, ToolSet } from 'ai'
import type { RawAction } from '../parse.js'
import type { IToolCall } from '../agent/loop-types.js'
import { promptHintOf, type AgentToolSet } from './types.js'

/**
 * Render a ToolSet into a plain-text catalogue for the prompted/salvage path:
 * `- name(hint): description`. The hint comes from `defineTool({ promptHint })`
 * when present; weak local models lean on it to fill args correctly.
 */
export const renderCatalog = (tools: AgentToolSet): string => {
  const names = Object.keys(tools)
  if (names.length === 0) return '(no tools)'
  return names
    .map((name) => {
      const t = tools[name]
      const hint = promptHintOf(t) ?? ''
      const desc = typeof t.description === 'string' ? t.description : ''
      return `- ${name}(${hint}): ${desc}`
    })
    .join('\n')
}

interface DispatchContext {
  abortSignal?: AbortSignal
  messages?: ModelMessage[]
  toolCallId?: string
}

/**
 * Validate and execute a single salvaged tool call against the ToolSet, using
 * the tool's OWN `execute` and `inputSchema` — the identical implementation the
 * native path calls. Unknown tools, schema-invalid args, and thrown errors all
 * become a failed IToolCall rather than throwing.
 */
export const dispatch = async (
  action: RawAction,
  tools: ToolSet,
  ctx: DispatchContext = {},
): Promise<IToolCall> => {
  const t = tools[action.tool]
  if (!t) {
    return {
      name: action.tool,
      input: action.args,
      output: `unknown tool "${action.tool}"`,
      ok: false,
    }
  }
  let input: unknown = action.args
  const schema = (t as { inputSchema?: unknown }).inputSchema
  // Best-effort Zod validation (a jsonSchema() input has no safeParse — the
  // tool's execute is expected to guard those itself).
  if (schema && typeof (schema as { safeParse?: unknown }).safeParse === 'function') {
    const parsed = (
      schema as {
        safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { message: string } }
      }
    ).safeParse(input)
    if (!parsed.success) {
      return {
        name: action.tool,
        input,
        output: `invalid args for "${action.tool}": ${parsed.error?.message ?? 'schema validation failed'}`,
        ok: false,
      }
    }
    input = parsed.data
  }
  const execute = (t as { execute?: (i: unknown, o: unknown) => unknown }).execute
  if (typeof execute !== 'function') {
    return { name: action.tool, input, output: `tool "${action.tool}" has no execute`, ok: false }
  }
  try {
    const output = await execute(input, {
      toolCallId: ctx.toolCallId ?? `prompted-${action.tool}`,
      messages: ctx.messages ?? [],
      abortSignal: ctx.abortSignal,
    })
    return { name: action.tool, input, output, ok: true }
  } catch (err) {
    return {
      name: action.tool,
      input,
      output: err instanceof Error ? err.message : 'tool error',
      ok: false,
    }
  }
}
