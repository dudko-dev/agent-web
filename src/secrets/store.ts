import { IndexedDBVault, type VaultOptions } from './vault.js'

/**
 * The seam the provider registry uses to fetch API keys at model-build time.
 * Swap in any backend: the encrypted vault (default), an in-memory map (tests /
 * SSR), or a `fetch` to your own short-lived-token endpoint.
 */
export interface CredentialStore {
  getApiKey(ref: string): Promise<string | undefined>
  setApiKey(ref: string, key: string): Promise<void>
  deleteApiKey(ref: string): Promise<void>
}

/** Default CredentialStore: encrypted, IndexedDB-backed (see IndexedDBVault). */
export class VaultCredentialStore implements CredentialStore {
  private readonly vault: IndexedDBVault

  constructor(opts: VaultOptions = {}) {
    this.vault = new IndexedDBVault(opts)
  }

  getApiKey(ref: string): Promise<string | undefined> {
    return this.vault.getSecret(ref)
  }
  setApiKey(ref: string, key: string): Promise<void> {
    return this.vault.setSecret(ref, key)
  }
  deleteApiKey(ref: string): Promise<void> {
    return this.vault.deleteSecret(ref)
  }
}

/** Non-persistent CredentialStore for tests / SSR / ephemeral sessions. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly map = new Map<string, string>()

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [k, v] of Object.entries(initial)) this.map.set(k, v)
  }

  async getApiKey(ref: string): Promise<string | undefined> {
    return this.map.get(ref)
  }
  async setApiKey(ref: string, key: string): Promise<void> {
    this.map.set(ref, key)
  }
  async deleteApiKey(ref: string): Promise<void> {
    this.map.delete(ref)
  }
}
