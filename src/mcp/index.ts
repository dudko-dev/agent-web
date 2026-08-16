export { connectMcpHttp, diagnoseMcpCors, flattenContent } from './http.js'
// Re-exported so a host can identify an authorization failure by identity.
// The SDK's class does not set `name`, so `err.name === 'UnauthorizedError'`
// is always false — string sniffing is not an option, and a host that only
// depends on this package has no other handle on the class.
export { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
export type {
  McpHttpServerConfig,
  McpCatalogEntry,
  McpServerResult,
  ConnectedMcp,
  ConnectMcpOptions,
} from './http.js'
export {
  BrowserOAuthProvider,
  MemoryOAuthStorage,
  VaultOAuthStorage,
  beginMcpOAuth,
  finishMcpOAuth,
  readOAuthCallback,
} from './oauth.js'
export type {
  BrowserOAuthProviderOptions,
  McpOAuthCallback,
  McpOAuthRequestOptions,
  McpOAuthStorage,
} from './oauth.js'
