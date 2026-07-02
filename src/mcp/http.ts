import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'

/**
 * A remote MCP server reached over StreamableHTTP. Browsers can ONLY speak the
 * HTTP transport — stdio (child processes) is Node-only and intentionally
 * unsupported here. This connector lives behind the `@dudko.dev/agent-web/mcp`
 * subpath so `@modelcontextprotocol/sdk` never enters the core bundle.
 */
export interface McpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  /** Called at connect time to provide fresh headers (e.g. a rotating Bearer). */
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
}

export interface McpCatalogEntry {
  name: string
  description: string
  server: string
}

export interface ConnectedMcp {
  /** Discovered tools, keyed by "server__tool", ready to merge into config.tools. */
  tools: ToolSet
  catalog: McpCatalogEntry[]
  /** Per-server connect outcome. */
  results: { name: string; connected: boolean; error?: string }[]
  close: () => Promise<void>
}

export interface ConnectMcpOptions {
  clientName?: string
  clientVersion?: string
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
}

// Providers cap tool names at 64 chars (^[a-zA-Z0-9_-]{1,64}$). We enforce the
// same limit on the prefixed "server__tool" so one server can't poison a run.
const MAX_TOOL_NAME_LEN = 64

/**
 * Flatten an MCP tool result's content into something a model can read. Unlike
 * the Node sibling this NEVER spills to a filesystem (there isn't one in the
 * browser): all-text content is joined; mixed content passes through as an
 * array of text + raw parts for the host to handle.
 */
export const flattenContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content
  const parts = content as Array<Record<string, unknown>>
  const allText =
    parts.length > 0 && parts.every((p) => p?.type === 'text' && typeof p.text === 'string')
  if (allText) return parts.map((p) => p.text as string).join('\n')
  return parts.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : p))
}

/** Connect to one or more HTTP MCP servers and return their tools + catalogue. */
export const connectMcpHttp = async (
  servers: Record<string, McpHttpServerConfig>,
  opts: ConnectMcpOptions = {},
): Promise<ConnectedMcp> => {
  const log = opts.onLog ?? (() => {})
  const clients = new Map<string, Client>()
  const tools: ToolSet = {}
  const catalog: McpCatalogEntry[] = []
  const results: ConnectedMcp['results'] = []

  for (const [name, cfg] of Object.entries(servers)) {
    try {
      if (cfg.headers && cfg.getHeaders) {
        throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
      }
      const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
      const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
        requestInit: headers ? { headers } : undefined,
      })
      const client = new Client({
        name: opts.clientName ?? 'agent-web',
        version: opts.clientVersion ?? '0.0.0',
      })
      await client.connect(transport)
      clients.set(name, client)

      const listed = await client.listTools()
      let mounted = 0
      for (const t of listed.tools) {
        const prefixed = `${name}__${t.name}`
        if (prefixed.length > MAX_TOOL_NAME_LEN) {
          log(
            'warn',
            `[mcp] ${name}: tool "${t.name}" exceeds the ${MAX_TOOL_NAME_LEN}-char name limit; skipping`,
          )
          continue
        }
        const description = t.description ?? ''
        tools[prefixed] = dynamicTool({
          description,
          inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (args, options) => {
            const res = await client.callTool(
              { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
              undefined,
              options?.abortSignal ? { signal: options.abortSignal } : undefined,
            )
            return flattenContent(res.content)
          },
        })
        catalog.push({ name: prefixed, description, server: name })
        mounted += 1
      }
      log('info', `[mcp] ${name}: ${mounted} tools mounted`)
      results.push({ name, connected: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', `[mcp] ${name}: failed to connect - ${message}`)
      results.push({ name, connected: false, error: message })
    }
  }

  return {
    tools,
    catalog,
    results,
    close: async () => {
      await Promise.allSettled([...clients.values()].map((c) => c.close()))
    },
  }
}
