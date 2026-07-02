import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitBlocker, shouldReplan, defaultPrompts } from '../dist/index.js'

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
