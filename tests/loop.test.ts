import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitBlocker, shouldReplan, replanWanted, defaultPrompts } from '../dist/index.js'

test('splitBlocker: strips the sentinel and flags blocked', () => {
  assert.deepEqual(splitBlocker('did it'), { summary: 'did it', blocked: false })
  const r = splitBlocker('cannot do it [BLOCKER]')
  assert.equal(r.blocked, true)
  assert.equal(r.summary, 'cannot do it')
})

test('shouldReplan: true on blocked or a failed tool call', () => {
  const step = { id: 's1', description: 'd' }
  assert.equal(shouldReplan({ step, summary: '', blocked: true, toolCalls: [] }), true)
  assert.equal(
    shouldReplan({
      step,
      summary: '',
      blocked: false,
      toolCalls: [{ name: 't', input: {}, output: 1, ok: true }],
    }),
    false,
  )
  assert.equal(
    shouldReplan({
      step,
      summary: '',
      blocked: false,
      toolCalls: [{ name: 't', input: {}, output: 'e', ok: false }],
    }),
    true,
  )
})

test('shouldReplan: a failure a later same-tool call resolved does NOT trigger', () => {
  const step = { id: 's1', description: 'd' }
  // save failed then a retry of save succeeded — the step self-corrected.
  assert.equal(
    shouldReplan({
      step,
      summary: '',
      blocked: false,
      toolCalls: [
        { name: 'save', input: {}, output: 'err', ok: false },
        { name: 'save', input: {}, output: 'ok', ok: true },
      ],
    }),
    false,
  )
  // A later success of a DIFFERENT tool does not resolve save's failure.
  assert.equal(
    shouldReplan({
      step,
      summary: '',
      blocked: false,
      toolCalls: [
        { name: 'save', input: {}, output: 'err', ok: false },
        { name: 'read', input: {}, output: 'ok', ok: true },
      ],
    }),
    true,
  )
})

test('replanWanted: an aborted signal makes a hung predicate fall back to the failure rule', async () => {
  const step = { id: 's1', description: 'd' }
  const failedStep = {
    step,
    summary: '',
    blocked: false,
    toolCalls: [{ name: 't', input: {}, output: 'e', ok: false }],
  }
  const controller = new AbortController()
  controller.abort()
  const hung = () => new Promise<boolean>(() => {}) // never resolves
  assert.equal(await replanWanted(hung, failedStep, { signal: controller.signal }), true)
})

test('replanWanted: a throwing predicate is surfaced via onError before the fallback', async () => {
  const step = { id: 's1', description: 'd' }
  const okStep = { step, summary: '', blocked: false, toolCalls: [] }
  let captured: unknown
  const boom = () => {
    throw new Error('nope')
  }
  const r = await replanWanted(boom, okStep, { onError: (e) => (captured = e) })
  assert.equal(r, false)
  assert.match(String(captured), /nope/)
})

test("replanWanted: resolves 'failure' | 'always' | predicate (with throw fallback)", async () => {
  const step = { id: 's1', description: 'd' }
  const okStep = {
    step,
    summary: '',
    blocked: false,
    toolCalls: [{ name: 't', input: {}, output: 1, ok: true }],
  }
  const failedStep = {
    step,
    summary: '',
    blocked: false,
    toolCalls: [{ name: 't', input: {}, output: 'e', ok: false }],
  }
  assert.equal(await replanWanted('failure', okStep), false)
  assert.equal(await replanWanted('failure', failedStep), true)
  assert.equal(await replanWanted('always', okStep), true)
  assert.equal(await replanWanted(async (r) => r.toolCalls.length > 0, okStep), true)
  assert.equal(await replanWanted(() => false, failedStep), false)
  // A throwing predicate falls back to the 'failure' rule.
  const boom = () => {
    throw new Error('boom')
  }
  assert.equal(await replanWanted(boom, okStep), false)
  assert.equal(await replanWanted(boom, failedStep), true)
})

test('default prompts switch system text by mode', () => {
  const native = defaultPrompts.planner({ goal: 'g', toolCatalog: '(none)', mode: 'native' })
  const prompted = defaultPrompts.planner({ goal: 'g', toolCatalog: '(none)', mode: 'prompted' })
  assert.match(native.system, /PLANNER/)
  assert.match(prompted.system, /JSON/)
  // Executor includes the tool catalogue only in prompted mode.
  const ex = defaultPrompts.executor({
    goal: 'g',
    step: 'do',
    index: 1,
    total: 1,
    toolCatalog: 'CATALOG_MARKER',
    done: [],
    mode: 'prompted',
  })
  assert.match(ex.prompt, /CATALOG_MARKER/)
})
