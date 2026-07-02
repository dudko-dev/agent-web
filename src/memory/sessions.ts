import { openAgentWebDB, SESSIONS_STORE } from '../storage/db.js'
import type { ContextStore, StoredMessage } from './store.js'

export interface IndexedDBStoreOptions {
  /** Database name, forwarded to the shared IDB owner (default 'agent-web'). */
  dbName?: string
}

/**
 * IndexedDB-backed transcript store — one record (message array) per session,
 * in the shared `sessions` object store (see storage/db.ts). Also exposes
 * session utilities: list and delete.
 */
export class IndexedDBStore implements ContextStore {
  private readonly dbName?: string

  constructor(opts: IndexedDBStoreOptions = {}) {
    this.dbName = opts.dbName
  }

  async load(sessionId: string): Promise<StoredMessage[]> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    const value = (await db.get(SESSIONS_STORE, sessionId)) as StoredMessage[] | undefined
    return Array.isArray(value) ? value : []
  }

  async replace(sessionId: string, messages: StoredMessage[]): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.put(SESSIONS_STORE, messages, sessionId)
  }

  async append(sessionId: string, message: StoredMessage): Promise<void> {
    const current = await this.load(sessionId)
    current.push(message)
    await this.replace(sessionId, current)
  }

  async clear(sessionId: string): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.delete(SESSIONS_STORE, sessionId)
  }

  /** List all stored session ids. */
  async listSessions(): Promise<string[]> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    return (await db.getAllKeys(SESSIONS_STORE)).map(String)
  }
}
