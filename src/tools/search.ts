import { jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import { isReadOnlyTool } from './approval.js'

/**
 * Tool search for large catalogues. Several MCP servers easily add up to
 * hundreds of tools — sending every schema on every call wastes the context
 * window (and OpenAI rejects more than 128 tools outright). In 'search' mode
 * the executor starts each step with a handful of tools and a `find_tools`
 * meta-tool that activates more on demand.
 */
export interface ToolCatalogEntry {
  name: string
  description: string
  /** The MCP server a tool came from ("server__tool" prefix), when known. */
  server?: string
  readOnly?: boolean
}

export const FIND_TOOLS_NAME = 'find_tools'

/** Build catalogue entries from a ToolSet ("server__tool" names yield a server). */
export const toolCatalogOf = (tools: ToolSet): ToolCatalogEntry[] =>
  Object.entries(tools).map(([name, t]) => {
    const sep = name.indexOf('__')
    return {
      name,
      description: typeof t.description === 'string' ? t.description : '',
      ...(sep > 0 ? { server: name.slice(0, sep) } : {}),
      readOnly: isReadOnlyTool(t as Tool),
    }
  })

/** Lowercased word tokens; snake_case, kebab-case and camelCase are split. */
export const tokenize = (s: string): string[] =>
  (s ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const hits = (term: string, words: string[]): boolean =>
  words.some(
    (w) =>
      w === term ||
      (term.length >= 3 && (w.startsWith(term) || (term.startsWith(w) && w.length >= 3))),
  )

export interface SearchToolsOptions {
  /** Only tools from this server. */
  server?: string
  /** Max results (default 8, capped at 20). */
  limit?: number
  /** Names to leave out (e.g. already active). */
  exclude?: ReadonlySet<string>
}

/**
 * Rank catalogue entries against a keyword query: each query term scores
 * 3 for a name hit, 2 for a server hit and 1 for a description hit (prefix
 * matching for terms of 3+ chars). Ties keep catalogue order; zero scores are
 * dropped. Pure and deterministic — no embeddings, no model call.
 */
export const searchTools = (
  catalog: ToolCatalogEntry[],
  query: string,
  opts: SearchToolsOptions = {},
): ToolCatalogEntry[] => {
  const terms = [...new Set(tokenize(query))]
  const limit = Math.min(Math.max(1, opts.limit ?? 8), 20)
  const server = opts.server?.toLowerCase()
  const scored: { entry: ToolCatalogEntry; score: number; index: number }[] = []
  catalog.forEach((entry, index) => {
    if (opts.exclude?.has(entry.name)) return
    if (server && entry.server?.toLowerCase() !== server) return
    const nameWords = tokenize(
      entry.server ? entry.name.slice(entry.server.length + 2) : entry.name,
    )
    const serverWords = tokenize(entry.server ?? '')
    const descWords = tokenize(entry.description)
    let score = 0
    for (const term of terms) {
      if (hits(term, nameWords)) score += 3
      if (hits(term, serverWords)) score += 2
      if (hits(term, descWords)) score += 1
    }
    // A server filter with an empty query lists that server's tools.
    if (terms.length === 0 && server) score = 1
    if (score > 0) scored.push({ entry, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.slice(0, limit).map((s) => s.entry)
}

/**
 * The planner's view of a large catalogue: grouped by server, short
 * descriptions, within a character budget.
 */
export const renderSearchCatalog = (catalog: ToolCatalogEntry[], budget = 12_000): string => {
  if (catalog.length === 0) return '(no tools)'
  const groups = new Map<string, ToolCatalogEntry[]>()
  for (const e of catalog) {
    const key = e.server ?? '(host)'
    groups.set(key, [...(groups.get(key) ?? []), e])
  }
  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const [server, entries] of groups) {
    const head = `[${server}] ${entries.length} tool(s)`
    if (used + head.length > budget) break
    lines.push(head)
    used += head.length + 1
    for (const e of entries) {
      const desc = e.description.replace(/\s+/g, ' ').trim().slice(0, 60)
      const line = `- ${e.name}${desc ? `: ${desc}` : ''}`
      if (used + line.length > budget) break
      lines.push(line)
      used += line.length + 1
      shown += 1
    }
  }
  const rest = catalog.length - shown
  if (rest > 0)
    lines.push(`… ${rest} more tool(s) — the executor can find them with ${FIND_TOOLS_NAME}`)
  return lines.join('\n')
}

/**
 * The `find_tools` meta-tool. `onFound` receives the matched names so the
 * caller can activate them (native: prepareStep activeTools; prompted: the
 * next round's catalogue).
 */
export const createFindToolsTool = (
  catalog: () => ToolCatalogEntry[],
  onFound: (query: string, names: string[]) => void,
  hintOf?: (name: string) => string | undefined,
): Tool => {
  const t = tool({
    description:
      'Search the full tool catalogue by keywords and make the matching tools callable from the next step on. ' +
      'Use it whenever the tool you need is not in your current tool list.',
    inputSchema: jsonSchema<{ query: string; server?: string; limit?: number }>({
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords: what the tool should do' },
        server: { type: 'string', description: 'Optional: only tools of this MCP server' },
        limit: { type: 'number', description: 'Max results (default 8, max 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    }),
    execute: async ({ query, server, limit }) => {
      const found = searchTools(catalog(), query, { server, limit })
      onFound(
        query,
        found.map((f) => f.name),
      )
      return {
        tools: found.map((f) => ({
          name: f.name,
          description: f.description,
          ...(f.server ? { server: f.server } : {}),
          readOnly: Boolean(f.readOnly),
          ...(hintOf?.(f.name) ? { args: hintOf(f.name) } : {}),
        })),
        note: found.length
          ? 'These tools are now callable.'
          : 'No tool matched; try other keywords or a server name.',
      }
    },
  })
  ;(t as { readOnly?: boolean }).readOnly = true
  ;(t as { promptHint?: string }).promptHint = '{ query: string, server?: string, limit?: number }'
  return t
}
