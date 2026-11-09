import type { RunPersistence, RunSnapshot } from '../agent/persistence.js'
import { openAgentWebDB, RUNS_STORE } from '../storage/db.js'

export interface RunStoreOptions {
  /**
   * Keep the snapshot of a run that completed (default false). A completed run has
   * nothing to resume, and its transcript lives in the session store, so keeping it
   * only grows the database — but a host that wants an audit trail can.
   */
  keepCompleted?: boolean
}

/** Newest first; `sessionId` narrows to one conversation. Terminal `complete` runs are not resumable. */
const resumableOf = (all: RunSnapshot[], sessionId?: string): RunSnapshot[] =>
  all
    .filter(
      (s) => s.status !== 'complete' && (sessionId === undefined || s.sessionId === sessionId),
    )
    .sort((a, b) => b.startedAt - a.startedAt)

/**
 * Checkpoints in memory: enough to resume within one page's life (a stopped run, a
 * failed step) and for tests, but a reload loses them — use `IndexedDBRunStore` for that.
 */
export class MemoryRunStore implements RunPersistence {
  private readonly runs = new Map<string, RunSnapshot>()
  private readonly keepCompleted: boolean

  constructor(opts: RunStoreOptions = {}) {
    this.keepCompleted = opts.keepCompleted ?? false
  }

  onRunStart(snapshot: RunSnapshot): void {
    this.runs.set(snapshot.runId, snapshot)
  }

  onStepComplete(snapshot: RunSnapshot): void {
    this.runs.set(snapshot.runId, snapshot)
  }

  onRunComplete(snapshot: RunSnapshot): void {
    if (snapshot.status === 'complete' && !this.keepCompleted) this.runs.delete(snapshot.runId)
    else this.runs.set(snapshot.runId, snapshot)
  }

  loadRun(runId: string): RunSnapshot | null {
    return this.runs.get(runId) ?? null
  }

  /** Runs that can still be resumed (executing, stopped or failed), newest first. */
  resumable(sessionId?: string): RunSnapshot[] {
    return resumableOf([...this.runs.values()], sessionId)
  }

  /** The most recent run that can be resumed — what to offer after a reload. */
  latestResumable(sessionId?: string): RunSnapshot | undefined {
    return this.resumable(sessionId)[0]
  }

  delete(runId: string): void {
    this.runs.delete(runId)
  }

  clear(): void {
    this.runs.clear()
  }
}

export interface IndexedDBRunStoreOptions extends RunStoreOptions {
  /** Database name, forwarded to the shared IDB owner (default 'agent-web'). */
  dbName?: string
}

/** A JSON round trip: what is left when a tool's output is not structured-cloneable. */
const jsonSafe = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_k, v: unknown) =>
      v instanceof Error ? v.message : typeof v === 'bigint' ? v.toString() : v,
    ),
  ) as T

/**
 * Checkpoints in IndexedDB — one record per run, in the shared `runs` object store
 * (see storage/db.ts) — so a reload or a crashed tab can resume where it stopped:
 *
 * ```ts
 * const runs = new IndexedDBRunStore()
 * const agent = await createAgent({ model, persistence: runs })
 * // after a reload:
 * const unfinished = await runs.latestResumable(sessionId)
 * if (unfinished) await agent.run('', { resumeFromRunId: unfinished.runId })
 * ```
 */
export class IndexedDBRunStore implements RunPersistence {
  private readonly dbName?: string
  private readonly keepCompleted: boolean

  constructor(opts: IndexedDBRunStoreOptions = {}) {
    this.dbName = opts.dbName
    this.keepCompleted = opts.keepCompleted ?? false
  }

  private async put(snapshot: RunSnapshot): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    try {
      await db.put(RUNS_STORE, snapshot, snapshot.runId)
    } catch (err) {
      // A tool output holding a function or a DOM node cannot be cloned into the
      // store; its JSON form can. Losing a checkpoint over it would lose the run.
      if ((err as { name?: string })?.name !== 'DataCloneError') throw err
      await db.put(RUNS_STORE, jsonSafe(snapshot), snapshot.runId)
    }
  }

  onRunStart(snapshot: RunSnapshot): Promise<void> {
    return this.put(snapshot)
  }

  onStepComplete(snapshot: RunSnapshot): Promise<void> {
    return this.put(snapshot)
  }

  async onRunComplete(snapshot: RunSnapshot): Promise<void> {
    if (snapshot.status === 'complete' && !this.keepCompleted) {
      await this.delete(snapshot.runId)
      return
    }
    await this.put(snapshot)
  }

  async loadRun(runId: string): Promise<RunSnapshot | null> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    return ((await db.get(RUNS_STORE, runId)) as RunSnapshot | undefined) ?? null
  }

  /** Runs that can still be resumed (executing, stopped or failed), newest first. */
  async resumable(sessionId?: string): Promise<RunSnapshot[]> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    return resumableOf((await db.getAll(RUNS_STORE)) as RunSnapshot[], sessionId)
  }

  /** The most recent run that can be resumed — what to offer after a reload. */
  async latestResumable(sessionId?: string): Promise<RunSnapshot | undefined> {
    return (await this.resumable(sessionId))[0]
  }

  async delete(runId: string): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.delete(RUNS_STORE, runId)
  }

  async clear(): Promise<void> {
    const db = await openAgentWebDB({ dbName: this.dbName })
    await db.clear(RUNS_STORE)
  }
}
