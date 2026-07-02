export interface StoredMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  ts?: number
}

/** Persists an agent session's transcript. Swap in any backend. */
export interface ContextStore {
  load(sessionId: string): Promise<StoredMessage[]>
  append(sessionId: string, message: StoredMessage): Promise<void>
  replace(sessionId: string, messages: StoredMessage[]): Promise<void>
  clear(sessionId: string): Promise<void>
}

/** Non-persistent fallback (tests, SSR, private mode). */
export class MemoryStore implements ContextStore {
  private readonly data = new Map<string, StoredMessage[]>()

  async load(sessionId: string): Promise<StoredMessage[]> {
    return (this.data.get(sessionId) ?? []).slice()
  }
  async append(sessionId: string, message: StoredMessage): Promise<void> {
    const arr = this.data.get(sessionId) ?? []
    arr.push(message)
    this.data.set(sessionId, arr)
  }
  async replace(sessionId: string, messages: StoredMessage[]): Promise<void> {
    this.data.set(sessionId, messages.slice())
  }
  async clear(sessionId: string): Promise<void> {
    this.data.delete(sessionId)
  }
}
