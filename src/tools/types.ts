import type { Tool, ToolSet } from 'ai'

/**
 * The canonical tool shape is the AI SDK `Tool` — the same object the native
 * tool-calling path passes straight to `streamText({ tools })`, and the same
 * shape MCP tools take. We add one optional field, `promptHint`, a short
 * human-readable parameter hint (e.g. "{ text: string, x?: number }") used only
 * by the prompted/salvage path when it renders the tool catalogue into a text
 * prompt for weak local models.
 */
export type AgentTool = Tool & { promptHint?: string }

/** A named collection of tools — a plain AI SDK ToolSet, usable directly. */
export type AgentToolSet = ToolSet

/** Read the optional promptHint attached by defineTool, if any. */
export const promptHintOf = (tool: Tool): string | undefined =>
  typeof (tool as { promptHint?: unknown }).promptHint === 'string'
    ? (tool as { promptHint?: string }).promptHint
    : undefined
