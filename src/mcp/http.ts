import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StreamableHTTPClientTransport,
  type StreamableHTTPReconnectionOptions,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { dynamicTool, jsonSchema, type ToolSet } from 'ai'

/**
 * A remote MCP server reached over StreamableHTTP. Browsers can ONLY speak the
 * HTTP transport — stdio (child processes) is Node-only and intentionally
 * unsupported here. This connector lives behind the `@dudko.dev/agent-web/mcp`
 * subpath so `@modelcontextprotocol/sdk` never enters the core bundle.
 *
 * Three ways to authenticate, in ascending order of capability:
 *   1. `headers` — a static token you already hold.
 *   2. `getHeaders` — resolved once per connect, for tokens you mint yourself.
 *   3. `authProvider` — full OAuth 2.1: the SDK discovers the authorization
 *      server, dynamically registers the client (DCR), runs PKCE, and — the
 *      part 1 and 2 cannot do — transparently REFRESHES the access token when
 *      the server answers 401 mid-run. See `./oauth`.
 */
export interface McpHttpServerConfig {
  url: string
  headers?: Record<string, string>
  /** Called at connect time to provide fresh headers (e.g. a rotating Bearer). */
  getHeaders?: () => Promise<Record<string, string>> | Record<string, string>
  /**
   * OAuth client provider (see `./oauth` for a browser implementation). The
   * transport sends its access token, refreshes on 401 and retries the request.
   * Do NOT also set an `Authorization` entry in `headers`: request headers are
   * merged last and would shadow the OAuth token.
   */
  authProvider?: OAuthClientProvider
  /** Custom fetch for every request: proxying, instrumentation, retries. */
  fetch?: FetchLike
  /** Overrides for the SSE reconnect backoff. Merged over the defaults below. */
  reconnection?: Partial<StreamableHTTPReconnectionOptions>
}

export interface McpCatalogEntry {
  name: string
  description: string
  server: string
}

export interface McpServerResult {
  name: string
  connected: boolean
  error?: string
  /**
   * The server demands OAuth and we have no usable token. When the config
   * carried a `BrowserOAuthProvider`, its `authorizationUrl` now holds the page
   * to send the user to; reconnect once they are back.
   */
  needsAuthorization?: boolean
}

export interface ConnectedMcp {
  /** Discovered tools, keyed by "server__tool", ready to merge into config.tools. */
  tools: ToolSet
  catalog: McpCatalogEntry[]
  /** Per-server connect outcome. */
  results: McpServerResult[]
  /**
   * Re-list one server's tools and rewrite its entries in `tools`/`catalog`.
   * Both are mutated in place, so anything holding a reference (including a
   * live agent config) sees the new set. Throws if the server isn't connected.
   */
  refreshServer: (name: string) => Promise<void>
  close: () => Promise<void>
}

export interface ConnectMcpOptions {
  clientName?: string
  clientVersion?: string
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void
  /**
   * Fires when a server pushes `notifications/tools/list_changed`. Call
   * `refreshServer(name)` from a point where no run is reading `tools` — this
   * connector deliberately does not refresh behind a running agent's back.
   */
  onToolsChanged?: (server: string) => void
}

// Providers cap tool names at 64 chars (^[a-zA-Z0-9_-]{1,64}$). We enforce the
// same limit on the prefixed "server__tool" so one server can't poison a run.
const MAX_TOOL_NAME_LEN = 64

// Browsers drop long-lived SSE streams on tab-throttling and flaky networks far
// more often than a server does; the SDK's default (2 retries) gives up too
// early for an agent that may idle between steps.
const DEFAULT_RECONNECTION: StreamableHTTPReconnectionOptions = {
  maxReconnectionDelay: 30_000,
  initialReconnectionDelay: 1_000,
  reconnectionDelayGrowFactor: 1.5,
  maxRetries: 5,
}

// MCP names may contain characters providers reject (dots, slashes, spaces);
// map them into the allowed alphabet. callTool still uses the ORIGINAL name.
const sanitizeName = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, '_')

/**
 * Sanitizing can map two distinct MCP names onto one key ("a.b" and "a-b" both
 * become "a_b"). Suffix instead of dropping: a tool the model can't see is a
 * silent capability loss, and the disambiguated name still resolves back to the
 * original on dispatch.
 */
const uniqueKey = (base: string, taken: ToolSet): string => {
  if (!taken[base]) return base
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, MAX_TOOL_NAME_LEN - suffix.length) + suffix
    if (!taken[candidate]) return candidate
  }
  return ''
}

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

interface McpToolDescriptor {
  name: string
  description?: string
  inputSchema: unknown
}

interface ServerConnect {
  name: string
  client?: Client
  listed?: McpToolDescriptor[]
  error?: string
  needsAuthorization?: boolean
}

/**
 * An access token that is already expired produces a guaranteed 401 on the
 * first request. When the provider tells us so AND we hold a refresh token,
 * renew before connecting: one round-trip saved, and a run that starts on a
 * stale token doesn't surface a spurious auth error to the model.
 */
const refreshIfExpired = async (
  provider: OAuthClientProvider,
  serverUrl: string,
  fetchFn?: FetchLike,
): Promise<void> => {
  const check = (provider as { isAccessTokenExpired?: () => boolean | Promise<boolean> })
    .isAccessTokenExpired
  if (typeof check !== 'function') return
  if (!(await check.call(provider))) return
  const tokens = await provider.tokens()
  // Without a refresh token `auth()` would escalate to a full authorization
  // redirect. Leave that to the caller (via needsAuthorization) rather than
  // triggering it from inside connect.
  if (!tokens?.refresh_token) return
  await auth(provider, { serverUrl, fetchFn })
}

const openConnection = async (
  name: string,
  cfg: McpHttpServerConfig,
  opts: ConnectMcpOptions,
  log: NonNullable<ConnectMcpOptions['onLog']>,
): Promise<ServerConnect> => {
  let client: Client | undefined
  try {
    if (cfg.headers && cfg.getHeaders) {
      throw new Error(`MCP server "${name}": specify either headers or getHeaders, not both`)
    }
    const headers = cfg.getHeaders ? await cfg.getHeaders() : cfg.headers
    if (cfg.authProvider) {
      if (headers && 'Authorization' in headers) {
        log(
          'warn',
          `[mcp] ${name}: an explicit Authorization header shadows the OAuth token from authProvider`,
        )
      }
      await refreshIfExpired(cfg.authProvider, cfg.url, cfg.fetch)
    }
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url), {
      requestInit: headers ? { headers } : undefined,
      authProvider: cfg.authProvider,
      fetch: cfg.fetch,
      reconnectionOptions: { ...DEFAULT_RECONNECTION, ...cfg.reconnection },
    })
    // Without these, a dropped SSE stream or a transport-level protocol error
    // is swallowed and the agent just stops getting results.
    transport.onerror = (err) => log('warn', `[mcp] ${name}: transport error - ${err.message}`)
    transport.onclose = () => log('warn', `[mcp] ${name}: transport closed`)

    client = new Client({
      name: opts.clientName ?? 'agent-web',
      version: opts.clientVersion ?? '0.0.0',
    })
    await client.connect(transport)

    // Subscribe BEFORE the first list call: a server that mutates its tool set
    // during init would otherwise lose the notification in the window between
    // connect() and listTools().
    if (opts.onToolsChanged) {
      const notify = opts.onToolsChanged
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => notify(name))
    }

    const listed = (await client.listTools()).tools as McpToolDescriptor[]
    return { name, client, listed }
  } catch (err) {
    // The client may be live even though we ended up here (listTools() failing
    // after a successful connect). Close it, or the SSE stream leaks for the
    // lifetime of the tab.
    if (client) await client.close().catch(() => {})
    const needsAuthorization = err instanceof UnauthorizedError
    const message = err instanceof Error ? err.message : String(err)
    log(
      'error',
      needsAuthorization
        ? `[mcp] ${name}: authorization required - send the user to the provider's authorizationUrl`
        : `[mcp] ${name}: failed to connect - ${message}`,
    )
    return { name, error: message, needsAuthorization }
  }
}

/**
 * Connect to one or more HTTP MCP servers and return their tools + catalogue.
 * Servers connect concurrently; tools, catalogue, and results merge in the
 * caller's declaration order, so the outcome is deterministic.
 */
export const connectMcpHttp = async (
  servers: Record<string, McpHttpServerConfig>,
  opts: ConnectMcpOptions = {},
): Promise<ConnectedMcp> => {
  const log = opts.onLog ?? (() => {})
  const clients = new Map<string, Client>()
  const tools: ToolSet = {}
  const catalog: McpCatalogEntry[] = []
  const results: McpServerResult[] = []

  const mountTools = (name: string, client: Client, listed: McpToolDescriptor[]): void => {
    const prefix = `${sanitizeName(name)}__`
    // Drop this server's existing entries first, mutating in place so external
    // references (an agent's live ToolSet) stay valid.
    for (const k of Object.keys(tools)) {
      if (k.startsWith(prefix)) delete tools[k]
    }
    for (let i = catalog.length - 1; i >= 0; i--) {
      if (catalog[i].server === name) catalog.splice(i, 1)
    }

    let mounted = 0
    for (const t of listed) {
      const prefixed = prefix + sanitizeName(t.name)
      if (prefixed.length > MAX_TOOL_NAME_LEN) {
        log(
          'warn',
          `[mcp] ${name}: tool "${t.name}" exceeds the ${MAX_TOOL_NAME_LEN}-char name limit; skipping`,
        )
        continue
      }
      const key = uniqueKey(prefixed, tools)
      if (!key) {
        log('warn', `[mcp] ${name}: cannot find a free name for tool "${t.name}"; skipping`)
        continue
      }
      if (key !== prefixed) {
        log('warn', `[mcp] ${name}: tool name "${prefixed}" already taken; mounted as "${key}"`)
      }
      const description = t.description ?? ''
      tools[key] = dynamicTool({
        description,
        inputSchema: jsonSchema(t.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (args, options) => {
          const res = await client.callTool(
            { name: t.name, arguments: (args ?? {}) as Record<string, unknown> },
            undefined,
            options?.abortSignal ? { signal: options.abortSignal } : undefined,
          )
          const flat = flattenContent(res.content)
          // An MCP failure is a NORMAL response with isError set — surface it
          // as a thrown error so both tool paths record a failed call instead
          // of feeding the error text to the model as a success.
          if ((res as { isError?: boolean }).isError) {
            throw new Error(typeof flat === 'string' ? flat : JSON.stringify(flat))
          }
          return flat
        },
      })
      catalog.push({ name: key, description, server: name })
      mounted += 1
    }
    log('info', `[mcp] ${name}: ${mounted} tools mounted`)
  }

  const connects = await Promise.all(
    Object.entries(servers).map(([name, cfg]) => openConnection(name, cfg, opts, log)),
  )

  for (const server of connects) {
    if (!server.client || !server.listed) {
      results.push({
        name: server.name,
        connected: false,
        error: server.error,
        ...(server.needsAuthorization ? { needsAuthorization: true } : {}),
      })
      continue
    }
    clients.set(server.name, server.client)
    mountTools(server.name, server.client, server.listed)
    results.push({ name: server.name, connected: true })
  }

  return {
    tools,
    catalog,
    results,
    refreshServer: async (name: string) => {
      const client = clients.get(name)
      if (!client) throw new Error(`MCP server "${name}" is not connected`)
      const listed = (await client.listTools()).tools as McpToolDescriptor[]
      mountTools(name, client, listed)
    },
    close: async () => {
      await Promise.allSettled([...clients.values()].map((c) => c.close()))
    },
  }
}
