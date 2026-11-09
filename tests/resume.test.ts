import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import test from 'node:test'
import { openDB } from 'idb'
import {
  createAgent,
  defineSkill,
  defineTool,
  IndexedDBRunStore,
  MemoryRunStore,
  MemoryStore,
  openAgentWebDB,
  resolveResume,
  RUNS_STORE,
  KEYS_STORE,
  type AgentEvent,
  type RunPersistence,
  type RunSnapshot,
} from '../dist/index.js'
import { z } from 'zod'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// A run that is checkpointed and resumed. `resolveResume` is unit-tested for what it
// REFUSES; what matters to someone whose tab died mid-run is that the run really
// CONTINUES — from the saved plan and trace, without planning again and without
// repeating a finished step. The proof is the model's call log, not the final text:
// a resumed run that quietly redid everything would still end with the same answer.

const STEPS = ['Gather the data', 'Analyse the data', 'Write the report']
const plan = (steps: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    thought: 'plan',
    steps: steps.map((description) => ({ description })),
    ...extra,
  })

/** The step an executor call is for. `STEP n/m: …` heads its user prompt. */
const stepOf = (info: CallInfo): string => /STEP \d+\/\d+: ([^\n]+)/.exec(info.user)?.[1] ?? '?'
const executed = (calls: CallInfo[]): string[] =>
  calls.filter((c) => stageOf(c) === 'executor').map(stepOf)

const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: plan(STEPS) }
    case 'executor':
      return { text: `did: ${stepOf(info)}` }
    default:
      return { text: 'All three steps done.' }
  }
}

/**
 * A store behaving like a real one after a crash: it holds the last checkpoint and
 * nothing else, because a dead tab never writes `onRunComplete`. The run is stopped
 * right after `dieAfter` steps have been checkpointed.
 */
const crashing = (inner: RunPersistence, dieAfter: number) => {
  const controller = new AbortController()
  const persistence: RunPersistence = {
    onRunStart: (s) => inner.onRunStart?.(s),
    onStepComplete: async (s) => {
      await inner.onStepComplete?.(s)
      if (s.trace.length === dieAfter) controller.abort()
    },
    loadRun: (id) => inner.loadRun?.(id) ?? null,
  }
  return { persistence, controller }
}

const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}

// ── resolveResume: what it refuses ───────────────────────────────────────────

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  runId: 'run-1',
  startedAt: 1,
  status: 'executing',
  goal: 'g',
  sessionId: 'default',
  plan: { thought: 't', steps: [{ id: 's1', description: 'a' }] } as RunSnapshot['plan'],
  remaining: [{ id: 's1', description: 'a' }] as RunSnapshot['remaining'],
  trace: [],
  done: [],
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } as RunSnapshot['usage'],
  iterations: 0,
  revisions: 0,
  toolCalls: 0,
  applied: 0,
  skills: [],
  discovered: [],
  attachments: 0,
  ...over,
})

test('resolveResume: nothing asked, nothing loaded', async () => {
  assert.equal(await resolveResume(undefined, undefined), undefined)
  assert.equal(await resolveResume({ loadRun: () => snapshot() }, undefined), undefined)
})

test('resolveResume: refuses what it cannot trust, with a message to act on', async () => {
  const ok = { loadRun: () => snapshot() }
  await assert.rejects(resolveResume(undefined, 'run-1'), /loadRun/)
  await assert.rejects(resolveResume({}, 'run-1'), /loadRun/)
  for (const bad of ['', '../etc', 'a b', 'x'.repeat(129), 'run/1']) {
    await assert.rejects(
      resolveResume(ok, bad),
      /resumeFromRunId must be 1-128/,
      `rejects "${bad}"`,
    )
  }
  await assert.rejects(resolveResume({ loadRun: () => null }, 'run-1'), /No persisted run/)
  await assert.rejects(
    resolveResume({ loadRun: () => snapshot({ runId: 'someone-else' }) }, 'run-1'),
    /refusing to resume on mismatch/,
    'a store answering with a different run is not believed',
  )
  await assert.rejects(
    resolveResume({ loadRun: () => snapshot({ status: 'complete' }) }, 'run-1'),
    /already complete/,
  )
  await assert.rejects(
    resolveResume({ loadRun: () => snapshot({ remaining: [] }) }, 'run-1'),
    /no steps left/,
  )
  await assert.rejects(
    resolveResume({ loadRun: () => ({ ...snapshot(), plan: undefined }) as never }, 'run-1'),
    /no usable checkpoint/,
  )
  // Stopped and failed runs are not lost ones; a completed run is.
  for (const status of ['executing', 'cancelled', 'failed'] as const) {
    assert.equal(
      (await resolveResume({ loadRun: () => snapshot({ status }) }, 'run-1'))?.status,
      status,
    )
  }
  // An async store is awaited.
  assert.equal((await resolveResume({ loadRun: async () => snapshot() }, 'run-1'))?.runId, 'run-1')
})

// ── the run itself ───────────────────────────────────────────────────────────

test('resume: a run stopped after a step continues from its checkpoint and finishes', async () => {
  const model = scriptedModel(route)
  const store = new MemoryRunStore()
  const memory = new MemoryStore()
  const { persistence, controller } = crashing(store, 1)

  const first = await createAgent({ model: model.model, persistence, memory })
  const r1 = await first.run('do three things', { signal: controller.signal })
  assert.equal(r1.stopped, true, 'the first process dies mid-run')
  assert.equal(r1.trace.length, 1)
  const saved = store.loadRun(r1.runId)
  assert.equal(saved?.status, 'executing', 'the last checkpoint is all that is left')
  assert.equal(saved?.trace.length, 1)
  assert.equal(saved?.remaining.length, 2)
  assert.equal(saved?.iterations, 1)

  // A NEW agent, as after a reload, resumes by id. The goal passed here is deliberately
  // wrong: the saved one must win, or it is not the same run.
  const second = await createAgent({ model: model.model, persistence: store, memory })
  const { events, onEvent } = collect()
  const r2 = await second.run('IGNORED', { resumeFromRunId: r1.runId, onEvent })

  assert.equal(r2.final, 'All three steps done.')
  assert.equal(r2.runId, r1.runId, 'the same run')
  assert.equal(r2.goal, 'do three things')
  assert.deepEqual(
    r2.trace.map((t) => t.step.description),
    STEPS,
  )
  assert.equal(r2.trace[0].summary, `did: ${STEPS[0]}`, 'step one is carried over, not redone')
  assert.equal(r2.steps, 3)

  // The call log is the proof.
  const stages = model.calls.map(stageOf)
  assert.equal(stages.filter((s) => s === 'planner').length, 1, 'never planned again')
  assert.deepEqual(executed(model.calls), STEPS, 'every step ran exactly once across both lives')
  assert.ok(!model.calls.some((c) => c.user.includes('IGNORED')))

  const start = events.find((e) => e.type === 'run.start')
  assert.ok(start?.type === 'run.start')
  assert.deepEqual(start.resumed, { completedSteps: 1, remainingSteps: 2 })
  const announced = events.find((e) => e.type === 'plan.created')
  assert.ok(announced?.type === 'plan.created')
  assert.deepEqual(
    announced.plan.steps.map((s) => s.description),
    STEPS,
    'a consumer attaching mid-resume sees the plan as it stands',
  )

  // The transcript has the goal once and the answer once, in order.
  assert.deepEqual(
    (await memory.load('default')).map((m) => m.role),
    ['user', 'assistant'],
  )
  assert.equal(store.loadRun(r1.runId), null, 'a completed run leaves nothing to resume')
})

test('resume: the per-run caps still apply across the crash', async () => {
  const model = scriptedModel(route)
  const store = new MemoryRunStore()
  const { persistence, controller } = crashing(store, 1)
  const first = await createAgent({ model: model.model, persistence, maxIterations: 2 })
  const r1 = await first.run('do three things', { signal: controller.signal })

  const second = await createAgent({ model: model.model, persistence: store, maxIterations: 2 })
  const r2 = await second.run('', { resumeFromRunId: r1.runId })
  assert.deepEqual(
    executed(model.calls),
    STEPS.slice(0, 2),
    'one more step only: the iteration spent before the crash still counts',
  )
  assert.equal(r2.trace.length, 2)
})

test('resume: the tool-call budget is per RUN, not per process', async () => {
  const log: string[] = []
  const add = defineTool({
    description: 'Add a note',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }) => {
      log.push(text)
      return { ok: true }
    },
  })
  const model = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(STEPS) }
    if (stage === 'executor') {
      return info.toolResults === 0
        ? { toolCalls: [{ name: 'add_note', args: { text: stepOf(info) } }] }
        : { text: `did: ${stepOf(info)}` }
    }
    return { text: 'done' }
  })
  const store = new MemoryRunStore()
  const { persistence, controller } = crashing(store, 1)
  const first = await createAgent({
    model: model.model,
    tools: { add_note: add },
    persistence,
    maxToolCalls: 2,
  })
  const r1 = await first.run('notes', { signal: controller.signal })
  assert.equal(store.loadRun(r1.runId)?.toolCalls, 1, 'the checkpoint carries the count')

  const second = await createAgent({
    model: model.model,
    tools: { add_note: add },
    persistence: store,
    maxToolCalls: 2,
  })
  const r2 = await second.run('', { resumeFromRunId: r1.runId })
  // Cap 2: one call before the crash, one after. A counter that restarted at zero
  // would let the third step call as well.
  assert.deepEqual(log, [STEPS[0], STEPS[1]])
  assert.equal(r2.budgetExceeded?.kind, 'tool-calls')
})

test('resume: active skills are restored, silently, and still shape the steps', async () => {
  const model = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(STEPS, { skills: ['house-style'] }) }
    if (stage === 'executor') return { text: `did: ${stepOf(info)}` }
    return { text: 'done' }
  })
  const skills = [
    defineSkill({
      name: 'house-style',
      description: 'How we write',
      content: 'SKILL-BODY-MARKER: write plainly.',
    }),
  ]
  const store = new MemoryRunStore()
  const { persistence, controller } = crashing(store, 1)
  const first = await createAgent({ model: model.model, skills, persistence })
  const r1 = await first.run('write it', { signal: controller.signal })
  assert.deepEqual(store.loadRun(r1.runId)?.skills, ['house-style'])

  const second = await createAgent({ model: model.model, skills, persistence: store })
  const { events, onEvent } = collect()
  const r2 = await second.run('', { resumeFromRunId: r1.runId, onEvent })
  assert.deepEqual(r2.skills, ['house-style'])
  assert.ok(
    !events.some((e) => e.type === 'skill.activated'),
    'the activation already happened, and was reported, in the first life',
  )
  const afterResume = model.calls.filter((c) => stageOf(c) === 'executor').slice(1)
  assert.ok(afterResume.length > 0)
  assert.ok(
    afterResume.every((c) => c.system.includes('SKILL-BODY-MARKER')),
    'the restored skill still reaches the executor',
  )
})

test('resume: a run the user stopped can be resumed; a completed one cannot', async () => {
  const model = scriptedModel(route)
  const store = new MemoryRunStore()
  const controller = new AbortController()
  const agent = await createAgent({
    model: model.model,
    persistence: {
      onRunStart: (s) => store.onRunStart(s),
      onStepComplete: (s) => {
        store.onStepComplete(s)
        if (s.trace.length === 1) controller.abort()
      },
      // Unlike a crash, a stop DOES reach onRunComplete — with 'cancelled'.
      onRunComplete: (s) => store.onRunComplete(s),
      loadRun: (id) => store.loadRun(id),
    },
  })
  const stopped = await agent.run('do three things', { signal: controller.signal })
  assert.equal(store.loadRun(stopped.runId)?.status, 'cancelled')
  assert.equal(store.latestResumable()?.runId, stopped.runId)

  const done = await agent.run('', { resumeFromRunId: stopped.runId })
  assert.equal(done.final, 'All three steps done.')
  assert.equal(store.loadRun(stopped.runId), null)
  await assert.rejects(
    agent.run('', { resumeFromRunId: stopped.runId }),
    /No persisted run/,
    'once complete there is nothing left to resume',
  )
})

test('persistence: a store that throws never ends the run', async () => {
  const model = scriptedModel(route)
  const agent = await createAgent({
    model: model.model,
    logLevel: 'silent',
    persistence: {
      onRunStart: () => {
        throw new Error('disk full')
      },
      onStepComplete: async () => {
        throw new Error('quota exceeded')
      },
      onRunComplete: () => {
        throw new Error('gone')
      },
    },
  })
  const result = await agent.run('do three things')
  assert.equal(result.final, 'All three steps done.')
  assert.equal(result.stopped, false)
  assert.equal(result.trace.length, 3)
})

test('persistence: a snapshot is a copy — the loop cannot mutate what a store holds', async () => {
  const model = scriptedModel(route)
  const seen: RunSnapshot[] = []
  const agent = await createAgent({
    model: model.model,
    persistence: { onStepComplete: (s) => void seen.push(s) },
  })
  await agent.run('do three things')
  assert.deepEqual(
    seen.map((s) => [s.trace.length, s.remaining.length]),
    [
      [1, 2],
      [2, 1],
      [3, 0],
    ],
    'each checkpoint still shows the state at ITS boundary, after the run moved on',
  )
})

// ── IndexedDB: surviving a reload ────────────────────────────────────────────

test('IndexedDBRunStore: a stopped run is found and resumed by a NEW store, as after a reload', async () => {
  const dbName = 'resume-reload'
  const model = scriptedModel(route)
  const { persistence, controller } = crashing(new IndexedDBRunStore({ dbName }), 1)
  const first = await createAgent({ model: model.model, persistence, sessionId: 'chat-1' })
  const r1 = await first.run('do three things', { signal: controller.signal })

  // The page "reloads": nothing survives but the database.
  const afterReload = new IndexedDBRunStore({ dbName })
  const found = await afterReload.latestResumable('chat-1')
  assert.equal(found?.runId, r1.runId)
  assert.equal(
    await afterReload.latestResumable('some-other-chat'),
    undefined,
    'scoped to the session',
  )

  const second = await createAgent({ model: model.model, persistence: afterReload })
  const r2 = await second.run('', { resumeFromRunId: found!.runId })
  assert.equal(r2.final, 'All three steps done.')
  assert.deepEqual(executed(model.calls), STEPS)
  assert.equal(await afterReload.loadRun(r1.runId), null, 'completed: removed from the database')
})

test('IndexedDBRunStore: resumable() is newest first and leaves out completed runs', async () => {
  const store = new IndexedDBRunStore({ dbName: 'resume-list', keepCompleted: true })
  await store.onRunStart(snapshot({ runId: 'old', startedAt: 1, sessionId: 'a' }))
  await store.onRunStart(snapshot({ runId: 'new', startedAt: 9, sessionId: 'a' }))
  await store.onRunStart(snapshot({ runId: 'other', startedAt: 5, sessionId: 'b' }))
  await store.onRunComplete(
    snapshot({ runId: 'done', startedAt: 7, sessionId: 'a', status: 'complete' }),
  )
  await store.onRunComplete(
    snapshot({ runId: 'stopped', startedAt: 3, sessionId: 'a', status: 'cancelled' }),
  )
  assert.deepEqual(
    (await store.resumable('a')).map((s) => s.runId),
    ['new', 'stopped', 'old'],
  )
  assert.equal(
    (await store.loadRun('done'))?.status,
    'complete',
    'keepCompleted keeps the audit trail',
  )
  await store.delete('new')
  assert.equal(await store.loadRun('new'), null)
  await store.clear()
  assert.deepEqual(await store.resumable(), [])
})

test('IndexedDBRunStore: a tool output that cannot be cloned does not cost the run its checkpoint', async () => {
  const store = new IndexedDBRunStore({ dbName: 'resume-clone' })
  const awkward = snapshot({
    runId: 'awkward',
    trace: [
      {
        step: { id: 's1', description: 'a' },
        summary: 's',
        toolCalls: [{ name: 't', input: {}, output: { fn: () => 1, ok: 'yes' }, ok: true }],
      },
    ] as unknown as RunSnapshot['trace'],
  })
  await store.onStepComplete(awkward)
  const back = await store.loadRun('awkward')
  assert.ok(back, 'the checkpoint was written')
  assert.equal(
    (back.trace[0].toolCalls[0].output as { ok: string }).ok,
    'yes',
    'what could be kept, was',
  )
})

test('IndexedDBRunStore: complete runs are not kept by default', async () => {
  const store = new IndexedDBRunStore({ dbName: 'resume-default' })
  await store.onRunStart(snapshot({ runId: 'r' }))
  await store.onRunComplete(snapshot({ runId: 'r', status: 'complete' }))
  assert.equal(await store.loadRun('r'), null)
})

test('the database upgrades from v2: the new runs store appears and nothing else is touched', async () => {
  const dbName = 'resume-upgrade'
  // A database exactly as v2 created it, with data in it.
  const old = await openDB(dbName, 2, {
    upgrade(db) {
      for (const name of ['keys', 'secrets', 'sessions', 'files']) db.createObjectStore(name)
    },
  })
  await old.put('keys', 'precious', 'vault-key')
  assert.equal(old.objectStoreNames.contains('runs'), false)
  old.close()

  const db = await openAgentWebDB({ dbName })
  assert.equal(db.objectStoreNames.contains(RUNS_STORE), true, 'v3 adds the runs store')
  assert.equal(await db.get(KEYS_STORE, 'vault-key'), 'precious', 'existing data is intact')
  assert.equal(db.version, 3)
})
