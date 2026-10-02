import type { ModelMessage } from 'ai'
import { estimateTokens } from '../memory/compress.js'

/**
 * Context editing inside one tool loop — what Anthropic's
 * `clear_tool_uses` and Claude Code's micro-compaction do: once the loop's
 * conversation grows past `triggerTokens`, the OLDEST tool results are replaced
 * with a one-line stub (the calls themselves stay, so the model knows what it
 * did and can call again), keeping the `keep` most recent results verbatim.
 *
 * Clearing is sticky — a result cleared once stays cleared — so the prefix the
 * provider cached does not flip back and forth between rounds.
 */
export interface ToolResultClearing {
  /** Clear once the loop's estimated tokens exceed this. */
  triggerTokens: number
  /** Most recent tool results kept verbatim (default 3). */
  keep?: number
}

export interface ClearedInfo {
  cleared: number
  beforeTokens: number
  afterTokens: number
}

const STUB = (name: string): string =>
  `[${name} result cleared to save context — call the tool again if you still need it]`

const estimate = (messages: ModelMessage[]): number => {
  try {
    return estimateTokens(JSON.stringify(messages))
  } catch {
    return 0
  }
}

type ToolResultPart = {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: unknown
}

const resultParts = (messages: ModelMessage[]): ToolResultPart[] =>
  messages.flatMap((m) =>
    m.role === 'tool' && Array.isArray(m.content)
      ? (m.content as { type: string }[]).filter(
          (p): p is ToolResultPart => p.type === 'tool-result',
        )
      : [],
  )

/**
 * A stateful clearer for one loop: call it with each round's messages; it
 * returns the (possibly) edited copy and reports what it newly cleared.
 */
export const createToolResultClearer = (
  opts: ToolResultClearing,
  onCleared?: (info: ClearedInfo) => void,
): ((messages: ModelMessage[]) => ModelMessage[]) => {
  const keep = Math.max(0, opts.keep ?? 3)
  const cleared = new Set<string>()

  const apply = (messages: ModelMessage[]): ModelMessage[] =>
    cleared.size === 0
      ? messages
      : messages.map((m) =>
          m.role === 'tool' && Array.isArray(m.content)
            ? {
                ...m,
                content: m.content.map((p) =>
                  p.type === 'tool-result' && cleared.has(p.toolCallId)
                    ? { ...p, output: { type: 'text' as const, value: STUB(p.toolName) } }
                    : p,
                ),
              }
            : m,
        )

  return (messages) => {
    let edited = apply(messages)
    const before = estimate(edited)
    if (before <= opts.triggerTokens) return edited
    const parts = resultParts(messages)
    const candidates = parts.slice(0, Math.max(0, parts.length - keep))
    let added = 0
    for (const p of candidates) {
      if (!cleared.has(p.toolCallId)) {
        cleared.add(p.toolCallId)
        added += 1
      }
    }
    if (added === 0) return edited
    edited = apply(messages)
    onCleared?.({ cleared: added, beforeTokens: before, afterTokens: estimate(edited) })
    return edited
  }
}
