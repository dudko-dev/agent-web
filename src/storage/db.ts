import { openDB, type IDBPDatabase } from 'idb'

export interface AgentWebDBOptions {
  /** Database name (default 'agent-web'). Use a distinct name to isolate apps. */
  dbName?: string
}

export const KEYS_STORE = 'keys'
export const SECRETS_STORE = 'secrets'
export const SESSIONS_STORE = 'sessions'

let cache = new Map<string, Promise<IDBPDatabase>>()

/**
 * The single owner of the IndexedDB database. Every persistent store — the
 * non-extractable crypto key, encrypted secrets, and session transcripts —
 * lives under ONE database name + version. Centralising `openDB` here prevents
 * the classic bug where two modules open the same DB name with different store
 * sets and the second call throws a VersionError.
 */
export const openAgentWebDB = (opts: AgentWebDBOptions = {}): Promise<IDBPDatabase> => {
  const name = opts.dbName ?? 'agent-web'
  let p = cache.get(name)
  if (!p) {
    p = openDB(name, 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(KEYS_STORE)) db.createObjectStore(KEYS_STORE)
        if (!db.objectStoreNames.contains(SECRETS_STORE)) db.createObjectStore(SECRETS_STORE)
        if (!db.objectStoreNames.contains(SESSIONS_STORE)) db.createObjectStore(SESSIONS_STORE)
      },
    })
    cache.set(name, p)
    // A failed open (private mode, storage denied) must not stay cached, or
    // every later call would replay the same rejection forever.
    p.catch(() => {
      if (cache.get(name) === p) cache.delete(name)
    })
  }
  return p
}

/** Test hook: drop cached connections so a fresh (e.g. fake-indexeddb) DB is opened. */
export const _resetDBCache = (): void => {
  cache = new Map()
}
