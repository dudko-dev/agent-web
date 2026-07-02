import { tool } from 'ai'
import type { AgentTool } from './types.js'

type ToolConfig = Parameters<typeof tool>[0]

/**
 * Define a host tool. Thin wrapper over the AI SDK `tool()`: pass a
 * `description`, an `inputSchema` (a Zod schema or the result of `jsonSchema()`),
 * and an `execute` function. The returned tool works unchanged on the native
 * tool-calling path.
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
export const defineTool = (config: ToolConfig & { promptHint?: string }): AgentTool => {
  const { promptHint, ...rest } = config as ToolConfig & { promptHint?: string }
  const t = tool(rest) as AgentTool
  if (promptHint) t.promptHint = promptHint
  return t
}
