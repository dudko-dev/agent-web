import { tool, type Tool } from 'ai'
import type { AgentTool } from './types.js'

/**
 * Define a host tool. Thin wrapper over the AI SDK `tool()`: pass a
 * `description`, an `inputSchema` (a Zod schema or the result of `jsonSchema()`),
 * and an `execute` function. The returned tool works unchanged on the native
 * tool-calling path.
 *
 * Generic over INPUT/OUTPUT so the schema's inferred type flows into
 * `execute(input)` — `Parameters<typeof tool>[0]` must NOT be used here: with
 * an overloaded `tool()` it resolves to the last overload (`Tool<never, never>`),
 * which rejects every real schema and types `execute` as `undefined`.
 *
 * Optionally add `promptHint` — a short parameter hint like
 * "{ text: string, x?: number }" — which the prompted/salvage path shows to
 * weak local models that can't do native function-calling.
 *
 * @example
 *   const tools = {
 *     add_text: defineTool({
 *       description: 'Add a text block to the page.',
 *       inputSchema: z.object({ text: z.string(), x: z.number().optional() }),
 *       promptHint: '{ text: string, x?: number }',
 *       execute: async ({ text, x }) => addTextBlock(text, x),
 *     }),
 *   }
 */
export const defineTool = <INPUT = unknown, OUTPUT = unknown>(
  config: Tool<INPUT, OUTPUT> & { promptHint?: string },
): AgentTool => {
  const { promptHint, ...rest } = config
  const t = tool(rest as Tool<INPUT, OUTPUT>) as AgentTool
  if (promptHint) t.promptHint = promptHint
  return t
}
