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

// A result's position in the conversation ("message:part"). The loop only
// appends, so positions are stable — unlike tool call ids, which some servers
// repeat across rounds.
const positionsOf = (messages: ModelMessage[]): string[] =>
  messages.flatMap((m, i) =>
    m.role === 'tool' && Array.isArray(m.content)
      ? (m.content as { type: string }[]).flatMap((p, j) =>
          p.type === 'tool-result' ? [`${i}:${j}`] : [],
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
      : messages.map((m, i) =>
          m.role === 'tool' && Array.isArray(m.content)
            ? {
                ...m,
                content: m.content.map((p, j) =>
                  p.type === 'tool-result' && cleared.has(`${i}:${j}`)
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
    const positions = positionsOf(messages)
    let added = 0
    for (const pos of positions.slice(0, Math.max(0, positions.length - keep))) {
      if (!cleared.has(pos)) {
        cleared.add(pos)
        added += 1
      }
    }
    if (added === 0) return edited
    edited = apply(messages)
    onCleared?.({ cleared: added, beforeTokens: before, afterTokens: estimate(edited) })
    return edited
  }
}
