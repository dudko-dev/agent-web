import type { IPlan, IPlanStep, IStepResult, IUsage } from './loop-types.js'

/**
 * Run persistence: checkpoints a run so that a page reload, a crashed tab or a
 * killed worker does not lose the work already done. Same hook names as the Node
 * sibling (`@dudko.dev/agent`), where this contract originated.
 *
 * WHAT A CHECKPOINT IS. One is written when the plan is in hand (`onRunStart`)
 * and again at the end of every iteration of the step loop (`onStepComplete`),
 * so it always names a boundary: the steps finished so far, the steps still to
 * run, and the counters. Resuming picks up exactly there — the planner does not
 * run again and a finished step is not repeated.
 *
 * WHAT IT IS NOT. A step that was in flight when the page died is NOT
 * checkpointed — it runs again from its start. For a read that is free; for a
 * write it may apply twice, so a tool with side effects should be idempotent (or
 * the host should keep the consent gate on). Attachments (images, files) are not
 * stored — pass them again to `run()` when resuming.
 *
 * Persistence is observability, not a correctness boundary: a hook that throws is
 * logged and the run carries on.
 */

export type RunStatus = 'executing' | 'complete' | 'failed' | 'cancelled'

/** Everything needed to continue a run from the end of an iteration. */
export interface RunSnapshot {
  runId: string
  startedAt: number
  /**
   * `executing` is the only non-terminal status the runtime writes. The others are
   * written once, when the run resolves; `failed` and `cancelled` can still be
   * resumed (a stopped run is not a lost one), `complete` cannot.
   */
  status: RunStatus
  /** The goal as first given: a resumed run uses THIS one, whatever `run()` is passed. */
  goal: string
  /** The session the run belongs to; a resumed run keeps it. */
  sessionId: string
  /** The plan as first created (a `revise` later changes `remaining`, not this). */
  plan: IPlan
  /** Steps still to run, after any `revise`. */
  remaining: IPlanStep[]
  /** Finished steps, as the run's trace. */
  trace: IStepResult[]
  /** The step log later steps and the answer are written from. */
  done: string[]
  /** Tool findings the synthesizer is given. */
  findings: string[]
  usage: IUsage
  /** Steps executed so far (the cap `maxIterations` counts these — across a crash). */
  iterations: number
  /** Replanner `revise` decisions so far (`maxRevisions`). */
  revisions: number
  /** Successful tool calls so far (`maxToolCalls`). */
  toolCalls: number
  /** Tool calls that went through: `RunResult.applied`. */
  applied: number
  /** Skills whose instructions are active. */
  skills: string[]
  /** Tools activated through `find_tools`, in order. */
  discovered: string[]
  /** How many images/files the run was given (their bytes are not kept). */
  attachments: number
  /**
   * What the user said while the run was going (`RunControl.send`), in order, and whether the
   * replanner has already weighed each. A resumed run keeps them: otherwise it would forget a
   * correction the user had already made.
   */
  userUpdates?: { text: string; reconciled: boolean }[]
  /** Final answer (status `complete`). */
  text?: string
  /** What ended the run (status `failed`). */
  error?: string
  completedAt?: number
}

export interface RunPersistence {
  /** The plan is in hand and the loop is about to start. Not called again on resume. */
  onRunStart?: (snapshot: RunSnapshot) => void | Promise<void>
  /** An iteration finished: a checkpoint to resume from. */
  onStepComplete?: (snapshot: RunSnapshot) => void | Promise<void>
  /** The run resolved: `complete`, `failed` (it threw) or `cancelled` (it was stopped). */
  onRunComplete?: (snapshot: RunSnapshot) => void | Promise<void>
  /**
   * What `run(goal, { resumeFromRunId })` reads. Return `null` when there is none.
   * An implementation that does not want to support resume can leave it out.
   */
  loadRun?: (runId: string) => RunSnapshot | null | Promise<RunSnapshot | null>
}

// A run id is a key in someone's store and may end up in a URL or a file name by
// way of a custom persistence layer: keep it boring.
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/

export const assertSafeRunId = (runId: unknown, label = 'runId'): string => {
  if (typeof runId !== 'string' || !SAFE_RUN_ID.test(runId)) {
    throw new Error(`${label} must be 1-128 characters of letters, digits, "_" or "-"`)
  }
  return runId
}

/**
 * Load and validate the snapshot a `resumeFromRunId` names. Throws a message the
 * caller can act on for: no `loadRun`, no such run, a store that answers with a
 * different run, a run that already completed, a snapshot with nothing left to do.
 * Persistence is host-controlled, so what `loadRun` returns is not trusted.
 */
export const resolveResume = async (
  persistence: RunPersistence | undefined,
  resumeFromRunId: string | undefined,
): Promise<RunSnapshot | undefined> => {
  if (resumeFromRunId === undefined) return undefined
  assertSafeRunId(resumeFromRunId, 'resumeFromRunId')
  if (!persistence?.loadRun) {
    throw new Error('resumeFromRunId requires `persistence.loadRun` to be implemented')
  }
  const snapshot = await persistence.loadRun(resumeFromRunId)
  if (!snapshot) throw new Error(`No persisted run found for runId "${resumeFromRunId}"`)
  assertSafeRunId(snapshot.runId, 'snapshot.runId')
  if (snapshot.runId !== resumeFromRunId) {
    throw new Error(
      `Persistence returned runId "${snapshot.runId}" for resumeFromRunId "${resumeFromRunId}"; refusing to resume on mismatch`,
    )
  }
  if (snapshot.status === 'complete') {
    throw new Error(`Run "${resumeFromRunId}" is already complete; nothing to resume`)
  }
  if (!snapshot.plan || !Array.isArray(snapshot.remaining) || !Array.isArray(snapshot.trace)) {
    throw new Error(
      `Run "${resumeFromRunId}" has no usable checkpoint (status="${snapshot.status}"); cannot resume`,
    )
  }
  if (snapshot.remaining.length === 0) {
    throw new Error(
      `Run "${resumeFromRunId}" has no steps left to run (status="${snapshot.status}"); nothing to resume`,
    )
  }
  return snapshot
}
