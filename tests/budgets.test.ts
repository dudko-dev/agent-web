import assert from 'node:assert/strict'
import test from 'node:test'
import { createAgent, resolveConfig, type BrowserAgentConfig } from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// The per-call output caps are what the model is told, so they are checked on the wire: what
// each stage's call carried as `maxOutputTokens`, not what the config object says.

const route = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return { text: JSON.stringify({ thought: 'ok', steps: [{ description: 'Say hi' }] }) }
    case 'executor':
      return { text: 'Hi.' }
    default:
      return { text: 'Done.' }
  }
}

const capsOf = async (
  extra: Partial<BrowserAgentConfig> = {},
): Promise<Record<string, unknown>> => {
  const m = scriptedModel(route)
  const agent = await createAgent({ model: m.model, ...extra })
  await agent.run('hello')
  const caps: Record<string, unknown> = {}
  for (const c of m.calls) caps[stageOf(c)] ??= c.options.maxOutputTokens
  return caps
}

test('defaults: the final answer gets room (3000); the other stages keep their caps', () => {
  assert.deepEqual(resolveConfig({ model: undefined } as never).budgets, {
    planner: 800,
    executor: 1200,
    replanner: 400,
    synthesizer: 3000,
    compaction: 1024,
  })
})

test('the synthesizer call is sent with the default cap - not a few hundred tokens', async () => {
  const caps = await capsOf()
  assert.equal(caps.synthesizer, 3000)
  assert.equal(caps.planner, 800)
  assert.equal(caps.executor, 1200)
})

test('limits.perCall wins over the legacy budgets, and both over the default', async () => {
  assert.equal((await capsOf({ budgets: { synthesizer: 700 } })).synthesizer, 700)
  assert.equal(
    (await capsOf({ budgets: { synthesizer: 700 }, limits: { perCall: { synthesizer: 5000 } } }))
      .synthesizer,
    5000,
  )
  // Other stages are not touched by raising one.
  const caps = await capsOf({ limits: { perCall: { synthesizer: 5000 } } })
  assert.equal(caps.executor, 1200)
})
