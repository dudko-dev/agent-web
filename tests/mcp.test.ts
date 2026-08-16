import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  beginMcpOAuth,
  BrowserOAuthProvider,
  connectMcpHttp,
  finishMcpOAuth,
  flattenContent,
  MemoryOAuthStorage,
  readOAuthCallback,
  VaultOAuthStorage,
} from '../dist/mcp.js'

// ── A fake remote MCP server + authorization server, spoken over a mock fetch.
// Everything the OAuth story needs (RFC 9728 resource metadata, AS metadata,
// RFC 7591 dynamic registration, PKCE code exchange, refresh-token rotation,
// 401 on a stale token) happens here, so the tests exercise the real SDK
// state machine without a network.

const MCP_ORIGIN = 'https://mcp.example.test'
const MCP_URL = `${MCP_ORIGIN}/mcp`
const AS_URL = 'https://as.example.test'
const REDIRECT_URL = 'https://app.example.test/callback'

interface RpcMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: Record<string, unknown>
}

interface MockOptions {
  requireAuth?: boolean
  tools?: { name: string; description?: string; inputSchema?: unknown }[]
  failListTools?: boolean
}

const DEFAULT_TOOLS = [
  {
    name: 'echo',
    description: 'Echo the input back',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
]

const jsonResponse = (
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })

const createMockServer = (opts: MockOptions = {}) => {
  const tools = opts.tools ?? DEFAULT_TOOLS
  const requests: { method: string; url: string; auth?: string; body?: string }[] = []
  const state = {
    validTokens: new Set<string>(['access-1']),
    registrations: 0,
    grants: [] as string[],
    issued: 1,
    lastCodeVerifier: undefined as string | undefined,
    toolCalls: 0,
    lastRegistration: undefined as Record<string, unknown> | undefined,
    /** Set to answer the next token request with invalid_client. */
    rejectClient: false,
    /** Set to answer dynamic registration with invalid_client_metadata. */
    failRegistration: false,
    /** Set to answer refresh_token grants with a transient 503. */
    failRefresh: false,
  }

  const handleRpc = (msg: RpcMessage): unknown => {
    if (msg.method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: (msg.params as { protocolVersion: string }).protocolVersion,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'mock-mcp', version: '1.0.0' },
        },
      }
    }
    // Notifications carry no id and expect no response.
    if (msg.id === undefined) return undefined
    if (msg.method === 'tools/list') {
      if (opts.failListTools) {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'tools/list exploded' },
        }
      }
      return { jsonrpc: '2.0', id: msg.id, result: { tools } }
    }
    if (msg.method === 'tools/call') {
      state.toolCalls += 1
      const params = (msg.params ?? {}) as { name?: string; arguments?: unknown }
      if (params.name === 'boom') {
        return {
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: 'kaboom' }], isError: true },
        }
      }
      return {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          // Echo the name the SERVER received, so a test asserting that a
          // sanitized key still dispatches to the original name is real.
          content: [
            { type: 'text', text: `${params.name}:${JSON.stringify(params.arguments ?? {})}` },
          ],
        },
      }
    }
    return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }
  }

  const fetchFn = async (url: string | URL, init: RequestInit = {}): Promise<Response> => {
    const href = String(url)
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers as HeadersInit | undefined)
    requests.push({
      method,
      url: href,
      auth: headers.get('authorization') ?? undefined,
      body: typeof init.body === 'string' ? init.body : undefined,
    })

    if (href.includes('/.well-known/oauth-protected-resource')) {
      return jsonResponse({
        resource: MCP_URL,
        authorization_servers: [AS_URL],
        scopes_supported: ['mcp:tools'],
      })
    }

    if (
      href.includes('/.well-known/oauth-authorization-server') ||
      href.includes('/.well-known/openid-configuration')
    ) {
      if (!href.startsWith(AS_URL)) return new Response('not found', { status: 404 })
      return jsonResponse({
        issuer: AS_URL,
        authorization_endpoint: `${AS_URL}/authorize`,
        token_endpoint: `${AS_URL}/token`,
        registration_endpoint: `${AS_URL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }

    if (href === `${AS_URL}/register`) {
      state.registrations += 1
      const metadata = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      state.lastRegistration = metadata
      if (state.failRegistration) {
        return jsonResponse(
          { error: 'invalid_client_metadata', error_description: 'redirect_uri not allowed' },
          400,
        )
      }
      return jsonResponse(
        { ...metadata, client_id: `dcr-client-${state.registrations}`, client_id_issued_at: 1 },
        201,
      )
    }

    if (href === `${AS_URL}/token`) {
      const params = new URLSearchParams(String(init.body ?? ''))
      const grant = params.get('grant_type') ?? ''
      state.grants.push(grant)
      // "The client you claim to be is not registered here" — what an AS says
      // after it has forgotten (or rotated away) a dynamic registration.
      if (state.rejectClient) {
        return jsonResponse({ error: 'invalid_client' }, 401)
      }
      if (grant === 'authorization_code') {
        // PKCE is mandatory for a public client — fail loudly if the SDK ever
        // stops sending the verifier.
        state.lastCodeVerifier = params.get('code_verifier') ?? undefined
        if (!state.lastCodeVerifier) {
          return jsonResponse({ error: 'invalid_request' }, 400)
        }
        if (params.get('code') !== 'auth-code-1') {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
      } else if (grant === 'refresh_token') {
        if (state.failRefresh) {
          // A transient authorization-server outage, NOT a dead token.
          return jsonResponse({ error: 'server_error' }, 503)
        }
        if (!params.get('refresh_token')?.startsWith('refresh-')) {
          return jsonResponse({ error: 'invalid_grant' }, 400)
        }
      }
      state.issued += 1
      const access = `access-${state.issued}`
      // Rotation: the previous access token stops working, exactly like a real
      // AS that issues short-lived tokens.
      state.validTokens = new Set([access])
      return jsonResponse({
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `refresh-${state.issued}`,
        scope: 'mcp:tools',
      })
    }

    if (href.startsWith(MCP_URL)) {
      if (method === 'GET') return new Response(null, { status: 405 })
      if (method === 'DELETE') return new Response(null, { status: 200 })
      if (opts.requireAuth) {
        const token = (headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
        if (!state.validTokens.has(token)) {
          return jsonResponse({ error: 'unauthorized' }, 401, {
            'www-authenticate': `Bearer resource_metadata="${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
          })
        }
      }
      const parsed = JSON.parse(String(init.body ?? 'null')) as RpcMessage | RpcMessage[]
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const replies = messages.map(handleRpc).filter((r) => r !== undefined)
      if (replies.length === 0) return new Response(null, { status: 202 })
      return jsonResponse(replies.length === 1 ? replies[0] : replies)
    }

    return new Response('not found', { status: 404 })
  }

  return { fetchFn, state, requests }
}

const makeProvider = (onRedirect?: (url: URL) => void) =>
  new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    clientName: 'agent-web-test',
    onRedirect,
  })

// dynamicTool's execute takes AI-SDK call options we don't need here.
const callTool = (
  tools: Record<string, unknown>,
  name: string,
  args: unknown,
): Promise<unknown> => {
  const tool = tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }
  return tool.execute(args, {})
}

// ── flattenContent ──────────────────────────────────────────────────────────

test('flattenContent: joins all-text parts and passes other shapes through', () => {
  assert.equal(
    flattenContent([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]),
    'a\nb',
  )
  assert.equal(flattenContent('raw'), 'raw')
  assert.deepEqual(flattenContent([]), [])
  const mixed = flattenContent([
    { type: 'text', text: 'a' },
    { type: 'image', data: 'zzz', mimeType: 'image/png' },
  ]) as unknown[]
  assert.equal(mixed[0], 'a')
  assert.deepEqual(mixed[1], { type: 'image', data: 'zzz', mimeType: 'image/png' })
})

// ── connect / mount / dispatch ──────────────────────────────────────────────

test('connectMcpHttp: mounts prefixed tools and dispatches through the transport', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })

  assert.deepEqual(
    mcp.results.map((r) => ({ name: r.name, connected: r.connected })),
    [{ name: 'docs', connected: true }],
  )
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  assert.equal(mcp.catalog[0].description, 'Echo the input back')

  const out = await callTool(mcp.tools, 'docs__echo', { text: 'hi' })
  assert.equal(out, 'echo:{"text":"hi"}')
  await mcp.close()
})

test('connectMcpHttp: static headers reach the server', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, headers: { Authorization: 'Bearer static-token' }, fetch: mock.fetchFn },
  })
  await mcp.close()
  const posted = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(posted.length > 0)
  assert.ok(posted.every((r) => r.auth === 'Bearer static-token'))
})

test('connectMcpHttp: an MCP result with isError becomes a thrown tool error', async () => {
  const mock = createMockServer({ tools: [{ name: 'boom', inputSchema: { type: 'object' } }] })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  await assert.rejects(() => callTool(mcp.tools, 'docs__boom', {}), /kaboom/)
  await mcp.close()
})

test('connectMcpHttp: sanitized name collisions are suffixed, not dropped', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'a.b', inputSchema: { type: 'object' } },
      { name: 'a/b', inputSchema: { type: 'object' } },
    ],
  })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  assert.deepEqual(Object.keys(mcp.tools), ['docs__a_b', 'docs__a_b_2'])
  // Both keys still dispatch to their ORIGINAL server-side names.
  assert.equal(await callTool(mcp.tools, 'docs__a_b', { x: 1 }), 'a.b:{"x":1}')
  assert.equal(await callTool(mcp.tools, 'docs__a_b_2', { x: 1 }), 'a/b:{"x":1}')
  await mcp.close()
})

test('connectMcpHttp: tools whose prefixed name exceeds 64 chars are skipped', async () => {
  const mock = createMockServer({
    tools: [
      { name: 'x'.repeat(70), inputSchema: { type: 'object' } },
      { name: 'ok', inputSchema: { type: 'object' } },
    ],
  })
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    {
      docs: { url: MCP_URL, fetch: mock.fetchFn },
    },
    { onLog: (_l, m) => logs.push(m) },
  )
  assert.deepEqual(Object.keys(mcp.tools), ['docs__ok'])
  assert.ok(logs.some((m) => m.includes('64-char name limit')))
  await mcp.close()
})

test('connectMcpHttp: a failing server is reported, never thrown, and others still mount', async () => {
  const mock = createMockServer()
  const mcp = await connectMcpHttp({
    dead: {
      url: 'https://nope.example.test/mcp',
      fetch: async () => new Response('no', { status: 500 }),
    },
    docs: { url: MCP_URL, fetch: mock.fetchFn },
  })
  const dead = mcp.results.find((r) => r.name === 'dead')
  assert.equal(dead?.connected, false)
  assert.ok(dead?.error)
  assert.equal(mcp.results.find((r) => r.name === 'docs')?.connected, true)
  assert.deepEqual(Object.keys(mcp.tools), ['docs__echo'])
  await mcp.close()
})

test('connectMcpHttp: rejects headers + getHeaders on the same server', async () => {
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, headers: { a: 'b' }, getHeaders: () => ({ c: 'd' }) },
  })
  assert.match(mcp.results[0].error ?? '', /either headers or getHeaders/)
})

test('connectMcpHttp: closes the client when listTools fails after connect', async () => {
  const mock = createMockServer({ failListTools: true })
  const logs: string[] = []
  const mcp = await connectMcpHttp(
    { docs: { url: MCP_URL, fetch: mock.fetchFn } },
    { onLog: (_l, m) => logs.push(m) },
  )
  assert.equal(mcp.results[0].connected, false)
  // The transport must have been torn down — otherwise the SSE stream leaks
  // for the lifetime of the tab.
  assert.ok(logs.some((m) => m.includes('transport closed')))
})

test('two server names that sanitize to the same prefix keep both tool sets', async () => {
  // "docs.v1" and "docs/v1" both sanitize to "docs_v1__": a connector that
  // purged by prefix would unmount the first server while still listing it in
  // the catalogue, and route its name to the OTHER server's client.
  const a = createMockServer()
  const b = createMockServer()
  const mcp = await connectMcpHttp({
    'docs.v1': { url: MCP_URL, fetch: a.fetchFn },
    'docs/v1': { url: MCP_URL, fetch: b.fetchFn },
  })

  assert.deepEqual(Object.keys(mcp.tools), ['docs_v1__echo', 'docs_v1__echo_2'])
  assert.deepEqual(
    mcp.catalog.map((c) => `${c.server}:${c.name}`),
    ['docs.v1:docs_v1__echo', 'docs/v1:docs_v1__echo_2'],
  )

  await callTool(mcp.tools, 'docs_v1__echo', {})
  assert.equal(a.state.toolCalls, 1, 'the first key reaches the first server')
  assert.equal(b.state.toolCalls, 0)
  await callTool(mcp.tools, 'docs_v1__echo_2', {})
  assert.equal(b.state.toolCalls, 1, 'the suffixed key reaches the second server')
  await mcp.close()
})

test('refreshServer: a nested server prefix is not swept away', async () => {
  // "a__b" starts with "a__", so a prefix-based purge during a refresh of "a"
  // would silently unmount every tool of the OTHER server.
  const outer = createMockServer({ tools: [{ name: 'x', inputSchema: { type: 'object' } }] })
  const inner = createMockServer({ tools: [{ name: 'y', inputSchema: { type: 'object' } }] })
  const mcp = await connectMcpHttp({
    a: { url: MCP_URL, fetch: outer.fetchFn },
    a__b: { url: MCP_URL, fetch: inner.fetchFn },
  })
  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])

  await mcp.refreshServer('a')

  assert.deepEqual(Object.keys(mcp.tools).sort(), ['a__b__y', 'a__x'])
  assert.equal(mcp.catalog.length, 2)
  await mcp.close()
})

test('refreshServer: re-lists a server and rewrites its entries in place', async () => {
  const tools = [{ name: 'echo', inputSchema: { type: 'object' } }]
  const mock = createMockServer({ tools })
  const mcp = await connectMcpHttp({ docs: { url: MCP_URL, fetch: mock.fetchFn } })
  const liveTools = mcp.tools
  assert.deepEqual(Object.keys(liveTools), ['docs__echo'])

  tools.push({ name: 'added-later', inputSchema: { type: 'object' } })
  await mcp.refreshServer('docs')

  // Same object reference — a live agent config sees the new tool.
  assert.equal(mcp.tools, liveTools)
  assert.deepEqual(Object.keys(liveTools).sort(), ['docs__added-later', 'docs__echo'])
  assert.equal(mcp.catalog.filter((c) => c.server === 'docs').length, 2)
  await assert.rejects(() => mcp.refreshServer('nope'), /is not connected/)
  await mcp.close()
})

// ── OAuth: storage, callback parsing, CSRF ──────────────────────────────────

test('BrowserOAuthProvider: persists tokens and reports expiry with a skew', async () => {
  const provider = makeProvider()
  assert.equal(await provider.isAccessTokenExpired(), true, 'no token yet')
  assert.equal(await provider.isAuthorized(), false)

  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 })
  assert.equal((await provider.tokens())?.access_token, 'a')
  assert.equal(await provider.isAccessTokenExpired(), false)
  assert.equal(await provider.isAuthorized(), true)

  // Inside the 30s skew window: treated as already expired.
  await provider.saveTokens({ access_token: 'b', token_type: 'Bearer', expires_in: 10 })
  assert.equal(await provider.isAccessTokenExpired(), true)

  // No expires_in: the AS didn't say, so we wait for a 401 instead of guessing.
  await provider.saveTokens({ access_token: 'c', token_type: 'Bearer' })
  assert.equal(await provider.isAccessTokenExpired(), false)
})

test('BrowserOAuthProvider: invalidateCredentials drops the right scopes', async () => {
  const provider = makeProvider()
  await provider.saveTokens({ access_token: 'a', token_type: 'Bearer' })
  await provider.saveClientInformation({ client_id: 'c1' })
  await provider.saveCodeVerifier('verifier')

  await provider.invalidateCredentials('tokens')
  assert.equal(await provider.tokens(), undefined)
  assert.deepEqual(await provider.clientInformation(), { client_id: 'c1' })

  await provider.invalidateCredentials('all')
  assert.equal(await provider.clientInformation(), undefined)
  await assert.rejects(() => provider.codeVerifier(), /No PKCE code verifier/)
})

test('BrowserOAuthProvider: state is single-use and mismatches fail', async () => {
  const provider = makeProvider()
  const issued = await provider.state()
  assert.equal(issued.length, 64)
  assert.equal(await provider.verifyState('something-else'), false)

  const second = await provider.state()
  assert.equal(await provider.verifyState(second), true)
  // Replay of the same value must not pass twice.
  assert.equal(await provider.verifyState(second), false)
})

test('BrowserOAuthProvider: refuses to carry tokens over plaintext http', () => {
  const opts = { redirectUrl: REDIRECT_URL, storage: new MemoryOAuthStorage() }
  assert.throws(
    () => new BrowserOAuthProvider({ ...opts, serverUrl: 'http://mcp.example.test/mcp' }),
    /requires https/,
  )
  // A registrable host that merely starts with "localhost" is not loopback.
  assert.throws(
    () => new BrowserOAuthProvider({ ...opts, serverUrl: 'http://localhost.attacker.test/mcp' }),
    /requires https/,
  )
  assert.ok(new BrowserOAuthProvider({ ...opts, serverUrl: 'http://localhost:8080/mcp' }))
  assert.ok(new BrowserOAuthProvider({ ...opts, serverUrl: 'http://127.0.0.1:8080/mcp' }))
})

test('BrowserOAuthProvider: two tenants on one URL path do not share credentials', async () => {
  // Same origin and path, different query — a namespace that ignored the query
  // would hand tenant B the bearer token minted for tenant A.
  const storage = new MemoryOAuthStorage()
  const a = new BrowserOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=a`,
    redirectUrl: REDIRECT_URL,
    storage,
  })
  const b = new BrowserOAuthProvider({
    serverUrl: `${MCP_URL}?tenant=b`,
    redirectUrl: REDIRECT_URL,
    storage,
  })

  await a.saveTokens({ access_token: 'tenant-a', token_type: 'Bearer' })
  assert.equal((await a.tokens())?.access_token, 'tenant-a')
  assert.equal(await b.tokens(), undefined)
})

test('VaultOAuthStorage: round-trips through the encrypted IndexedDB vault', async () => {
  const storage = new VaultOAuthStorage({ dbName: `oauth-test-${Date.now()}` })
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage,
  })

  await provider.saveTokens({ access_token: 'stored', token_type: 'Bearer', expires_in: 3600 })
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })

  assert.equal((await provider.tokens())?.access_token, 'stored')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  assert.equal(await provider.isAccessTokenExpired(), false)

  await provider.reset()
  assert.equal(await provider.tokens(), undefined)
})

test('readOAuthCallback: reads query params, hash routes, and errors', () => {
  assert.deepEqual(readOAuthCallback('https://app.test/cb?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    error: undefined,
    errorDescription: undefined,
  })
  assert.deepEqual(readOAuthCallback('https://app.test/#/cb?code=abc&state=xyz'), {
    code: 'abc',
    state: 'xyz',
    error: undefined,
    errorDescription: undefined,
  })
  assert.equal(readOAuthCallback('https://app.test/'), undefined)
  const denied = readOAuthCallback('https://app.test/cb?error=access_denied&error_description=nope')
  assert.equal(denied?.error, 'access_denied')
  assert.equal(denied?.errorDescription, 'nope')
})

test('finishMcpOAuth: refuses a callback whose state does not match', async () => {
  const provider = makeProvider()
  await provider.state()
  await assert.rejects(
    () => finishMcpOAuth(provider, { code: 'auth-code-1', state: 'forged' }),
    /state mismatch/,
  )
})

test('finishMcpOAuth: surfaces an authorization-server error verbatim', async () => {
  const provider = makeProvider()
  await assert.rejects(
    () => finishMcpOAuth(provider, { error: 'access_denied', errorDescription: 'user said no' }),
    /access_denied - user said no/,
  )
})

// ── OAuth end-to-end: DCR → PKCE → tokens → refresh ─────────────────────────

test('OAuth: unauthenticated connect registers dynamically and asks for authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true, 'the UI needs a way to tell auth apart')
  assert.equal(mock.state.registrations, 1, 'dynamic client registration ran')

  const url = provider.authorizationUrl
  assert.ok(url, 'the authorization URL is recorded for the app to use')
  assert.equal(url.origin + url.pathname, `${AS_URL}/authorize`)
  assert.equal(url.searchParams.get('client_id'), 'dcr-client-1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('code_challenge'), 'PKCE challenge present')
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URL)
  // The registration is persisted, so a page reload does not re-register.
  assert.deepEqual((await provider.clientInformation())?.client_id, 'dcr-client-1')
})

test('DCR: the registration request describes a public PKCE client', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    clientName: 'agent-web-test',
  })
  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  const sent = mock.state.lastRegistration
  assert.ok(sent, 'a registration body was posted')
  assert.equal(sent.client_name, 'agent-web-test')
  assert.deepEqual(sent.redirect_uris, [REDIRECT_URL])
  assert.deepEqual(sent.response_types, ['code'])
  // Without refresh_token in grant_types the AS may never issue one, and every
  // expiry would become an interactive re-authorization.
  assert.deepEqual(sent.grant_types, ['authorization_code', 'refresh_token'])
  // A browser cannot hold a client_secret; PKCE is what protects the exchange.
  assert.equal(sent.token_endpoint_auth_method, 'none')
  // Scope comes from the resource metadata when the caller didn't pin one.
  assert.equal(sent.scope, 'mcp:tools')
})

test('DCR: a stored registration is reused instead of registering again', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })
  await connectMcpHttp({ docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn } })

  assert.equal(mock.state.registrations, 1, 'a reload must not mint a second client')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
})

test('DCR: an invalid_client response re-registers and restarts authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  // A registration the AS has since forgotten (redeployed, pruned, rotated).
  await provider.saveClientInformation({ client_id: 'forgotten-client' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()
  mock.state.rejectClient = true

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(mock.state.registrations, 1, 'the dead client_id was replaced by a new registration')
  assert.equal((await provider.clientInformation())?.client_id, 'dcr-client-1')
  // Credentials tied to the dead client must go, or every later attempt
  // retries the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
  assert.ok(provider.authorizationUrl)
  assert.equal(provider.authorizationUrl.searchParams.get('client_id'), 'dcr-client-1')
})

test('DCR: a rejected registration surfaces the reason instead of a bare 401', async () => {
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRegistration = true
  const provider = makeProvider()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.match(mcp.results[0].error ?? '', /redirect_uri not allowed/)
  assert.equal(await provider.clientInformation(), undefined, 'nothing half-registered was stored')
})

test('OAuth: full flow — authorize, exchange the code, connect, call a tool', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()

  const first = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(first.results[0].needsAuthorization, true)

  // The user comes back from the AS with ?code=…&state=…
  const state = provider.authorizationUrl?.searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok(mock.state.lastCodeVerifier, 'the code was exchanged with a PKCE verifier')
  assert.equal((await provider.tokens())?.access_token, 'access-2')

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)
  assert.equal(await callTool(mcp.tools, 'docs__echo', { text: 'hi' }), 'echo:{"text":"hi"}')

  const mcpPosts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(mcpPosts.at(-1)?.auth === 'Bearer access-2', 'the bearer token is attached')
  await mcp.close()
})

test('OAuth: an access token that expires mid-session is refreshed and the call retried', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-1',
  })

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  // The server now rejects the token we hold — exactly what an expiry looks
  // like from the client's side.
  mock.state.validTokens.clear()
  const out = await callTool(mcp.tools, 'docs__echo', { text: 'after-expiry' })

  assert.equal(out, 'echo:{"text":"after-expiry"}', 'the tool call survived the 401')
  assert.ok(mock.state.grants.includes('refresh_token'), 'the refresh grant was used')
  assert.equal((await provider.tokens())?.access_token, 'access-2', 'the new token was persisted')
  assert.equal(mock.state.registrations, 0, 're-registration is not needed to refresh')
  await mcp.close()
})

test('OAuth: an already-expired token is refreshed BEFORE the first request', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  // expires_in inside the skew window: known-dead before we even connect.
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5,
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].connected, true)

  // No MCP request was ever made with the dead token: the refresh came first.
  const mcpPosts = mock.requests.filter((r) => r.method === 'POST' && r.url.startsWith(MCP_URL))
  assert.ok(mcpPosts.length > 0)
  assert.ok(
    mcpPosts.every((r) => r.auth === 'Bearer access-2'),
    'every MCP request used the refreshed token',
  )
  assert.equal(mock.state.grants.filter((g) => g === 'refresh_token').length, 1)
  await mcp.close()
})

test('OAuth: a transient refresh failure still leads to ONE usable authorization', async () => {
  // The proactive refresh must never start an authorization of its own: the
  // SDK's auth() silently escalates a failed refresh into a full redirect,
  // issuing a state + PKCE verifier that the transport's own 401 handling
  // would then overwrite — leaving the user holding a code the stored pair
  // cannot verify ("state mismatch") on every attempt.
  const mock = createMockServer({ requireAuth: true })
  mock.state.failRefresh = true
  const redirects: URL[] = []
  const provider = new BrowserOAuthProvider({
    serverUrl: MCP_URL,
    redirectUrl: REDIRECT_URL,
    storage: new MemoryOAuthStorage(),
    onRedirect: (url) => {
      redirects.push(url)
    },
  })
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 5, // inside the skew window: the proactive refresh will fire
    refresh_token: 'refresh-1',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.equal(redirects.length, 1, 'exactly one authorization was started')

  // The state that reached the user is the state we can verify.
  mock.state.failRefresh = false
  const state = redirects[0].searchParams.get('state') ?? undefined
  await finishMcpOAuth(provider, { code: 'auth-code-1', state }, { fetch: mock.fetchFn })
  assert.ok((await provider.tokens())?.access_token)
})

test('OAuth: beginMcpOAuth reports REDIRECT and records where to send the user', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  const outcome = await beginMcpOAuth(provider, { fetch: mock.fetchFn })
  assert.equal(outcome, 'REDIRECT')
  assert.equal(provider.authorizationUrl?.searchParams.get('client_id'), 'dcr-client-1')

  await finishMcpOAuth(
    provider,
    {
      code: 'auth-code-1',
      state: provider.authorizationUrl?.searchParams.get('state') ?? undefined,
    },
    { fetch: mock.fetchFn },
  )
  assert.equal(await provider.isAuthorized(), true)
})

test('OAuth: a dead refresh token falls back to a fresh authorization', async () => {
  const mock = createMockServer({ requireAuth: true })
  const provider = makeProvider()
  await provider.saveClientInformation({ client_id: 'dcr-client-1' })
  await provider.saveTokens({
    access_token: 'access-1',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'bogus',
  })
  mock.state.validTokens.clear()

  const mcp = await connectMcpHttp({
    docs: { url: MCP_URL, authProvider: provider, fetch: mock.fetchFn },
  })

  assert.equal(mcp.results[0].connected, false)
  assert.equal(mcp.results[0].needsAuthorization, true)
  assert.ok(provider.authorizationUrl, 'the user is sent back through the authorization flow')
  // invalid_grant must clear the dead tokens, or every later attempt retries
  // the same doomed refresh.
  assert.equal(await provider.tokens(), undefined)
})
