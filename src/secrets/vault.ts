import { openAgentWebDB, SECRETS_STORE } from '../storage/db.js'
import { decryptJSON, encryptJSON, getOrCreateVaultKey, type EncryptedBlob } from './crypto.js'

export interface VaultOptions {
  /** Database name, forwarded to the shared IDB owner (default 'agent-web'). */
  dbName?: string
}

/**
 * Encrypted key/value secret store backed by IndexedDB. Values are encrypted at
 * rest with the non-extractable AES-GCM vault key (see crypto.ts).
 *
 * ── THREAT MODEL (read before shipping any app-owned key to a browser) ──
 * This vault PROTECTS secrets **at rest** — an IndexedDB / disk dump yields
 * only ciphertext — and against **casual DevTools inspection** — no plaintext
 * key is stored, and the AES key cannot be exported even by in-page script.
 *
 * It does **NOT** defend against **active XSS on your origin**: any script that
 * already runs on the page can call `getSecret()`, or use the live `CryptoKey`
 * to decrypt. Browser storage is not a secrets manager.
 *
 * Therefore this vault is for the **end user's OWN key on their OWN device**
 * (bring-your-own-key). A shared, app-owned key must NEVER reach the client —
 * put it behind a server proxy (`ProviderModelSpec.baseURL`) or the Vercel AI
 * Gateway instead.
 */
export class IndexedDBVault {
  private readonly dbName?: string

  constructor(opts: VaultOptions = {}) {
    this.dbName = opts.dbName
  }

  private key(): Promise<CryptoKey> {
    return getOrCreateVaultKey(this.dbName)
  }

  /** Encrypt and store a secret string under `id`. */
  async setSecret(id: string, value: string): Promise<void> {
    const blob = await encryptJSON(await this.key(), value)
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.put(SECRETS_STORE, blob, id)
  }

  /** Fetch and decrypt a secret, or undefined if absent. */
  async getSecret(id: string): Promise<string | undefined> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    const blob = (await db.get(SECRETS_STORE, id)) as EncryptedBlob | undefined
    if (!blob) return undefined
    return decryptJSON<string>(await this.key(), blob)
  }

  async deleteSecret(id: string): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.delete(SECRETS_STORE, id)
  }

  async listSecretIds(): Promise<string[]> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    return (await db.getAllKeys(SECRETS_STORE)).map(String)
  }
}
