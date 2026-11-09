import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAgent,
  MemoryRunStore,
  MemoryStore,
  type IUsage,
  type RunPersistence,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// What the agent has spent, over all its runs and per session - counted call by call, so a run
// that is stopped or fails still counts what it used, and a resumed one only what THIS process
// spent. (The React layer shows a conversation's total; this is the core's own counter.)

const plan = (n = 1) =>
  JSON.stringify({
    thought: 'ok',
    steps: Array.from({ length: n }, (_, i) => ({ description: `Step ${i + 1}` })),
  })

// Every call reports 100 in / 20 out, so a run's total is 120 per call.
const usage = { input: 100, output: 20 }
const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: plan(), usage }
    case 'executor':
      return { text: 'ok', usage }
    default:
      return { text: 'Done.', usage }
  }
}
const total = (u: IUsage): number => u.totalTokens

test('usage: the agent counts every run - the sum of what each run reported', async () => {
  const m = scriptedModel(route)
  const agent = await createAgent({ model: m.model })
  assert.deepEqual(total(agent.usage), 0)
  const a = await agent.run('one')
  const b = await agent.run('two')
  assert.equal(total(a.usage), 3 * 120, 'planner + executor + synthesizer')
  assert.equal(total(agent.usage), total(a.usage) + total(b.usage))
  assert.equal(agent.usage.inputTokens, a.usage.inputTokens + b.usage.inputTokens)
  assert.equal(agent.usage.outputTokens, a.usage.outputTokens + b.usage.outputTokens)
})

test('usage: what you read is a snapshot - changing it changes nothing', async () => {
  const agent = await createAgent({ model: scriptedModel(route).model })
  await agent.run('one')
  const before = total(agent.usage)
  const snap = agent.usage
  snap.totalTokens = 0
  snap.inputTokens = 0
  assert.equal(total(agent.usage), before)
  const s = agent.sessionUsage()
  s.totalTokens = 0
  assert.equal(total(agent.sessionUsage()), before)
})

test('usage: per session - the default one, another one, and one never used', async () => {
  const agent = await createAgent({
    model: scriptedModel(route).model,
    memory: new MemoryStore(),
    sessionId: 'main',
  })
  await agent.run('a')
  await agent.run('b', { sessionId: 'side' })
  await agent.run('c', { sessionId: 'side' })
  assert.equal(total(agent.sessionUsage()), 360, 'the default session is the configured one')
  assert.equal(total(agent.sessionUsage('main')), 360)
  assert.equal(total(agent.sessionUsage('side')), 720)
  assert.equal(total(agent.sessionUsage('never')), 0)
  assert.equal(total(agent.usage), 1080, 'the agent total is all of them')
})

test('usage: resetUsage zeroes the agent and every session', async () => {
  const agent = await createAgent({ model: scriptedModel(route).model })
  await agent.run('a')
  await agent.run('b', { sessionId: 'side' })
  agent.resetUsage()
  assert.equal(total(agent.usage), 0)
  assert.equal(total(agent.sessionUsage('side')), 0)
  await agent.run('c')
  assert.equal(total(agent.usage), 360, 'and counting starts again')
})

test('usage: a run that is stopped still counts what it spent', async () => {
  const controller = new AbortController()
  const m = scriptedModel((info) => {
    // The planner has been paid for when the executor starts; the user stops it there.
    if (stageOf(info) === 'executor') controller.abort()
    return route(info)
  })
  const agent = await createAgent({ model: m.model })
  const r = await agent.run('go', { signal: controller.signal })
  assert.equal(r.stopped, true)
  assert.ok(total(agent.usage) >= 120, 'the planner call counts')
  assert.equal(total(agent.usage), total(r.usage), 'the same as the run reports')
})

test('usage: a model call that throws costs nothing; every call that answered counts, even one that had to be retried', async () => {
  const m = scriptedModel((info) => {
    if (stageOf(info) === 'executor') throw new Error('upstream exploded')
    return route(info)
  })
  const agent = await createAgent({ model: m.model })
  const r = await agent.run('go')
  const answered = m.calls.filter((c) => stageOf(c) !== 'executor').length
  assert.equal(total(agent.usage), answered * 120)
  assert.equal(total(agent.usage), total(r.usage), 'the same as the run reports')
})

// A native structured answer that cannot be parsed is retried as a prompted call; the first call
// was paid for as well.
const phasesOf = (events: { phase: string; tokens: number }[], phase: string): number =>
  events.filter((e) => e.phase === phase).reduce((n, e) => n + e.tokens, 0)

test('usage: a planner answer that could not be parsed is counted, not lost to the retry', async () => {
  let planned = 0
  const m = scriptedModel((info) => {
    if (stageOf(info) === 'planner') {
      planned += 1
      // The structured call answers prose; the prompted retry answers the plan.
      return planned === 1
        ? { text: 'not json at all', usage }
        : { text: JSON.stringify({ reply: 'ok', plan: ['Step 1'] }), usage }
    }
    return route(info)
  })
  const agent = await createAgent({ model: m.model })
  const events: { phase: string; tokens: number }[] = []
  const r = await agent.run('go', {
    onEvent: (e) => {
      if (e.type === 'usage') events.push({ phase: e.phase, tokens: e.usage.totalTokens })
    },
  })
  assert.equal(planned, 2, 'the plan was asked for twice')
  assert.equal(phasesOf(events, 'plan'), 2 * 120)
  assert.equal(total(r.usage), m.calls.length * 120, 'every call is in the run')
  assert.equal(total(agent.usage), total(r.usage))
})

test('usage: a replanner answer that could not be parsed is counted, not lost to the retry', async () => {
  const m = scriptedModel((info) => {
    if (stageOf(info) === 'executor') throw new Error('upstream exploded') // so the replanner runs
    if (stageOf(info) === 'replanner') return { text: 'prose, not a decision', usage }
    return route(info)
  })
  const agent = await createAgent({ model: m.model })
  const events: { phase: string; tokens: number }[] = []
  const r = await agent.run('go', {
    onEvent: (e) => {
      if (e.type === 'usage') events.push({ phase: e.phase, tokens: e.usage.totalTokens })
    },
  })
  const replans = m.calls.filter((c) => stageOf(c) === 'replanner').length
  assert.equal(replans, 2, 'the structured attempt and the prompted fallback')
  assert.equal(phasesOf(events, 'replan'), 2 * 120)
  const answered = m.calls.filter((c) => stageOf(c) !== 'executor').length
  assert.equal(total(r.usage), answered * 120)
  assert.equal(total(agent.usage), total(r.usage))
})

test('usage: a resumed run adds only what this process spent after the crash', async () => {
  const steps = ['Gather', 'Analyse', 'Report']
  const m = scriptedModel((info) =>
    stageOf(info) === 'planner' ? { text: plan(steps.length), usage } : route(info),
  )
  const store = new MemoryRunStore()
  const controller = new AbortController()
  const persistence: RunPersistence = {
    onRunStart: (s) => store.onRunStart?.(s),
    onStepComplete: async (s) => {
      await store.onStepComplete?.(s)
      if (s.trace.length === 1) controller.abort()
    },
    loadRun: (id) => store.loadRun?.(id) ?? null,
  }
  const first = await createAgent({ model: m.model, persistence })
  const r1 = await first.run('three things', { signal: controller.signal })
  const savedBefore = store.loadRun(r1.runId)!.usage.totalTokens
  assert.ok(savedBefore > 0)

  const second = await createAgent({ model: m.model, persistence: store })
  const r2 = await second.run('', { resumeFromRunId: r1.runId })
  // The run's own total spans both processes...
  assert.ok(total(r2.usage) > savedBefore)
  // ...but THIS agent spent only what came after the checkpoint.
  assert.equal(total(second.usage), total(r2.usage) - savedBefore)
  assert.equal(total(first.usage) + total(second.usage) >= total(r2.usage), true)
})

test('usage: a manual compaction is spend too', async () => {
  const memory = new MemoryStore()
  for (let i = 0; i < 12; i += 1) {
    await memory.append('default', { role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` })
  }
  const m = scriptedModel((info) =>
    info.system.includes('Summarize the following conversation')
      ? { text: 'summary', usage: { input: 50, output: 10 } }
      : route(info),
  )
  const agent = await createAgent({ model: m.model, memory })
  const r = await agent.compact()
  assert.equal(r.compacted, true)
  assert.equal(total(agent.usage), 60)
  assert.equal(total(agent.sessionUsage()), 60)
})
