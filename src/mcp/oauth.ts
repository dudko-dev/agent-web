import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { IndexedDBVault, type VaultOptions } from '../secrets/vault.js'

/**
 * Browser-side OAuth 2.1 for remote MCP servers: Dynamic Client Registration
 * (RFC 7591), PKCE authorization-code flow, and refresh-token rotation.
 *
 * The heavy lifting lives in the MCP SDK — `auth()` discovers the protected
 * resource (RFC 9728), registers the client if we have no client_id yet,
 * exchanges the code, and refreshes expired tokens; `StreamableHTTPClient-
 * Transport` retries any 401 through it. This module supplies the missing
 * half: WHERE the tokens, the registration, and the PKCE verifier are kept,
 * and HOW the user is sent to the authorization server.
 *
 * ── WHY NO AUTOMATIC NAVIGATION ──
 * `redirectToAuthorization` deliberately does NOT navigate by default. The SDK
 * can call it from deep inside a tool call, and throwing the user out of a
 * running agent would discard in-flight state. Instead the URL is recorded on
 * `authorizationUrl`, `connectMcpHttp` reports `needsAuthorization: true`, and
 * the app decides when to send the user there (a button, a popup, a redirect).
 * Pass `onRedirect` to opt into eager navigation.
 */

/** Where an OAuth provider keeps its tokens / registration / PKCE verifier. */
export interface McpOAuthStorage {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

/**
 * Default storage: the same encrypted IndexedDB vault that holds provider API
 * keys (AES-GCM, non-extractable key). Read the threat model in
 * `secrets/vault.ts` — this protects tokens at rest, not against active XSS.
 */
export class VaultOAuthStorage implements McpOAuthStorage {
  private readonly vault: IndexedDBVault

  constructor(opts: VaultOptions = {}) {
    this.vault = new IndexedDBVault(opts)
  }

  get(key: string): Promise<string | undefined> {
    return this.vault.getSecret(key)
  }
  set(key: string, value: string): Promise<void> {
    return this.vault.setSecret(key, value)
  }
  delete(key: string): Promise<void> {
    return this.vault.deleteSecret(key)
  }
}

/** Non-persistent storage for tests / SSR. Tokens die with the tab. */
export class MemoryOAuthStorage implements McpOAuthStorage {
  private readonly map = new Map<string, string>()

  async get(key: string): Promise<string | undefined> {
    return this.map.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
}

export interface BrowserOAuthProviderOptions {
  /** The MCP endpoint this provider authorizes against (the resource server). */
  serverUrl: string
  /**
   * Where the authorization server sends the user back. Must be a page of your
   * app that calls `readOAuthCallback()` + `finishMcpOAuth()`. Registered with
   * the AS via DCR, so it has to match byte-for-byte on the way back.
   */
  redirectUrl: string | URL
  /** `client_name` submitted during dynamic registration. */
  clientName?: string
  /** Fallback scope when the server's metadata advertises none. */
  scope?: string
  /** Merged over the defaults; use it for `software_id`, `contacts`, … */
  clientMetadata?: Partial<OAuthClientMetadata>
  /** Defaults to the encrypted IndexedDB vault. */
  storage?: McpOAuthStorage
  /** Treat an access token as expired this many seconds early. Default 30. */
  expirySkewSeconds?: number
  /** Called when the SDK wants the user at the authorization server. */
  onRedirect?: (url: URL) => void | Promise<void>
}

interface StoredTokens {
  tokens: OAuthTokens
  /** Absolute ms timestamp derived from `expires_in` at save time. */
  expiresAt?: number
}

const DEFAULT_SKEW_SECONDS = 30

// Namespacing by origin+path+query keeps two MCP servers on the same host
// (/mcp/docs vs /mcp/crm, or ?tenant=a vs ?tenant=b) from sharing a
// registration or a token — one tenant's bearer must never be sent to another.
const namespaceFor = (serverUrl: string): string => {
  const u = new URL(serverUrl)
  return `mcp-oauth:${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * OAuth over plaintext hands the bearer token to anyone on the path, so only
 * https — or a loopback host, where there is no network to sniff — is allowed.
 * Parsed rather than pattern-matched: `http://localhost.attacker.example/` is a
 * registrable host that a prefix match would wave through.
 */
export const assertSecureOAuthUrl = (url: string, label = 'MCP server'): void => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`${label}: "${url}" is not a valid URL`)
  }
  if (parsed.protocol === 'https:' || LOOPBACK_HOSTS.has(parsed.hostname)) return
  throw new Error(
    `${label}: MCP OAuth requires https (or a loopback host) - refusing to send tokens to "${url}"`,
  )
}

const randomToken = (): string => {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * An `OAuthClientProvider` (MCP SDK) that persists everything it is handed and
 * never navigates behind your back. One instance per MCP server.
 */
export class BrowserOAuthProvider implements OAuthClientProvider {
  /** Set when the SDK asks for an authorization redirect; read it in your UI. */
  authorizationUrl?: URL

  readonly serverUrl: string

  private readonly storage: McpOAuthStorage
  private readonly ns: string
  private readonly _redirectUrl: string
  private readonly _clientMetadata: OAuthClientMetadata
  private readonly skewMs: number
  private readonly onRedirect?: (url: URL) => void | Promise<void>

  constructor(opts: BrowserOAuthProviderOptions) {
    assertSecureOAuthUrl(opts.serverUrl)
    this.serverUrl = opts.serverUrl
    this.storage = opts.storage ?? new VaultOAuthStorage()
    this.ns = namespaceFor(opts.serverUrl)
    this._redirectUrl = String(opts.redirectUrl)
    this.skewMs = (opts.expirySkewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000
    this.onRedirect = opts.onRedirect
    this._clientMetadata = {
      client_name: opts.clientName ?? 'agent-web',
      redirect_uris: [this._redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // Public client: a browser cannot hold a client_secret. PKCE is what
      // actually protects the code exchange.
      token_endpoint_auth_method: 'none',
      ...(opts.scope ? { scope: opts.scope } : {}),
      ...opts.clientMetadata,
    } as OAuthClientMetadata
  }

  get redirectUrl(): string {
    return this._redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata
  }

  private key(suffix: string): string {
    return `${this.ns}:${suffix}`
  }

  private async readJSON<T>(suffix: string): Promise<T | undefined> {
    // The read itself is inside the guard on purpose: the default storage
    // decrypts, and an AES-GCM blob written under a key that no longer exists
    // (a partially cleared IndexedDB, a rotated vault key) throws. Treating
    // that as "no value" lets the flow re-authorize instead of every call
    // rejecting with an opaque OperationError forever.
    try {
      const raw = await this.storage.get(this.key(suffix))
      if (raw === undefined) return undefined
      return JSON.parse(raw) as T
    } catch {
      await this.storage.delete(this.key(suffix)).catch(() => {})
      return undefined
    }
  }

  async state(): Promise<string> {
    const value = randomToken()
    await this.storage.set(this.key('state'), value)
    return value
  }

  /**
   * CSRF check for the redirect back. Single-use: the stored value is dropped
   * whether or not it matched, so a replayed callback can't pass twice.
   */
  async verifyState(returned: string | undefined): Promise<boolean> {
    const expected = await this.storage.get(this.key('state'))
    await this.storage.delete(this.key('state'))
    return expected !== undefined && returned !== undefined && expected === returned
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    return this.readJSON<OAuthClientInformationMixed>('client')
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    await this.storage.set(this.key('client'), JSON.stringify(info))
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.readJSON<StoredTokens>('tokens'))?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const stored: StoredTokens = {
      tokens,
      expiresAt:
        typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : undefined,
    }
    await this.storage.set(this.key('tokens'), JSON.stringify(stored))
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.storage.set(this.key('verifier'), verifier)
  }

  async codeVerifier(): Promise<string> {
    const v = await this.storage.get(this.key('verifier'))
    if (!v) {
      throw new Error(
        'No PKCE code verifier stored: the authorization was started in a different browser profile, or storage was cleared mid-flow',
      )
    }
    return v
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.authorizationUrl = url
    await this.onRedirect?.(url)
  }

  /**
   * Called by the SDK when the server rejects what we hold: `'tokens'` after an
   * `invalid_grant` (dead refresh token), `'client'` / `'all'` after an
   * `invalid_client` (the AS forgot our dynamic registration). Clearing lets
   * the SDK re-register and re-authorize without the user clearing site data.
   */
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const targets = scope === 'all' ? ['tokens', 'client', 'verifier', 'state'] : [scope]
    await Promise.all(targets.map((t) => this.storage.delete(this.key(t))))
  }

  /** True when there is no access token, or it expires within the skew window. */
  async isAccessTokenExpired(): Promise<boolean> {
    const stored = await this.readJSON<StoredTokens>('tokens')
    if (!stored?.tokens?.access_token) return true
    // No expires_in means the AS didn't say; assume it is still good and let a
    // 401 drive the refresh.
    if (stored.expiresAt === undefined) return false
    return Date.now() + this.skewMs >= stored.expiresAt
  }

  /** True once an authorization has completed for this server. */
  async isAuthorized(): Promise<boolean> {
    return (await this.tokens()) !== undefined
  }

  /** Forget tokens, registration, verifier and state for this server. */
  async reset(): Promise<void> {
    this.authorizationUrl = undefined
    await this.invalidateCredentials('all')
  }
}

export interface McpOAuthRequestOptions {
  /**
   * Custom fetch for the discovery / registration / token requests. Pass the
   * same one you give the connector so a proxy or an instrumentation wrapper
   * covers the OAuth traffic too.
   */
  fetch?: FetchLike
}

export interface McpOAuthCallback {
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

/**
 * Pull the authorization-code parameters out of a redirect URL. Reads the query
 * string and, for hash-routed apps, the fragment. Returns undefined when the
 * URL carries neither a `code` nor an `error`, so it is safe to call on every
 * page load.
 */
export const readOAuthCallback = (input?: string | URL): McpOAuthCallback | undefined => {
  const href = input
    ? String(input)
    : typeof globalThis.location !== 'undefined'
      ? globalThis.location.href
      : undefined
  if (!href) return undefined
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return undefined
  }
  const params = new URLSearchParams(url.search)
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  // Hash-routed apps get "#/callback?code=…"; take whatever follows the "?".
  const q = hash.indexOf('?')
  if (q >= 0) {
    for (const [k, v] of new URLSearchParams(hash.slice(q + 1))) {
      if (!params.has(k)) params.set(k, v)
    }
  }
  const code = params.get('code') ?? undefined
  const error = params.get('error') ?? undefined
  if (!code && !error) return undefined
  return {
    code,
    state: params.get('state') ?? undefined,
    error,
    errorDescription: params.get('error_description') ?? undefined,
  }
}

/**
 * Finish the flow after the authorization server redirected back: verify the
 * `state`, exchange the code (PKCE) and persist the tokens. Throws when the AS
 * returned an error, when `state` doesn't match what we issued, or when the
 * exchange fails — never resolves on a half-finished authorization.
 */
export const finishMcpOAuth = async (
  provider: BrowserOAuthProvider,
  callback: McpOAuthCallback,
  opts: McpOAuthRequestOptions = {},
): Promise<void> => {
  if (callback.error) {
    throw new Error(
      `Authorization denied by the server: ${callback.error}${
        callback.errorDescription ? ` - ${callback.errorDescription}` : ''
      }`,
    )
  }
  if (!callback.code) {
    throw new Error('Authorization callback carried no code')
  }
  if (!(await provider.verifyState(callback.state))) {
    throw new Error('Authorization state mismatch; refusing to exchange the code (possible CSRF)')
  }
  const result = await auth(provider, {
    serverUrl: provider.serverUrl,
    authorizationCode: callback.code,
    fetchFn: opts.fetch,
  })
  if (result !== 'AUTHORIZED') {
    throw new Error(`Token exchange did not complete (SDK returned "${result}")`)
  }
}

/**
 * Kick off (or silently renew) an authorization. Returns `'AUTHORIZED'` when a
 * usable token is in hand — including the case where a refresh token was
 * silently exchanged — or `'REDIRECT'` when the user has to visit
 * `provider.authorizationUrl`.
 */
export const beginMcpOAuth = async (
  provider: BrowserOAuthProvider,
  opts: McpOAuthRequestOptions = {},
): Promise<'AUTHORIZED' | 'REDIRECT'> => {
  provider.authorizationUrl = undefined
  return auth(provider, { serverUrl: provider.serverUrl, fetchFn: opts.fetch })
}
