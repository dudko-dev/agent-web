import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeSteps,
  parseExecutorResponse,
  parsePlainText,
  parsePlannerResponse,
  parseReplannerResponse,
} from '../dist/index.js'

test('planner: parses reply + plan', () => {
  const r = parsePlannerResponse('{ "reply": "ok", "plan": ["Add title", "Add total"] }')
  assert.equal(r.reply, 'ok')
  assert.deepEqual(r.plan, ['Add title', 'Add total'])
})

test('planner: greeting yields an empty plan (intent gate)', () => {
  const r = parsePlannerResponse('{ "reply": "Hi! What should I build?", "plan": [] }')
  assert.deepEqual(r.plan, [])
  assert.match(r.reply, /Hi/)
})

test('planner: de-duplicates repeated steps (case-insensitive)', () => {
  const r = parsePlannerResponse('{ "plan": ["Add title", "add title", "Add total"] }')
  assert.deepEqual(r.plan, ['Add title', 'Add total'])
})

test('planner: salvages a truncated / looping plan', () => {
  const truncated =
    '{ "reply": "I will build it.", "plan": ["Add a customer line", "Add a customer line", "Add a customer'
  const r = parsePlannerResponse(truncated)
  assert.equal(r.reply, 'I will build it.')
  assert.deepEqual(r.plan, ['Add a customer line'])
})

test('planner salvage: never sweeps fields that follow the plan array', () => {
  // Valid array, truncated LATER in the object — "reply" must not become a step.
  const r = parsePlannerResponse('{ "plan": ["Add title", "Add total"], "reply": "Sure, I')
  assert.deepEqual(r.plan, ['Add title', 'Add total'])
})

test('planner salvage: decodes JSON escapes in salvaged strings', () => {
  const r = parsePlannerResponse('{ "reply": "OK", "plan": ["Say \\"hi\\"", "Add a second')
  assert.deepEqual(r.plan, ['Say "hi"'])
  assert.equal(r.reply, 'OK')
})

test('planner: never surfaces raw JSON as the reply', () => {
  const r = parsePlannerResponse('{ "reply": "Ok", "plan": ["Set background", "Add title')
  assert.equal(r.reply, 'Ok')
  assert.ok(!r.reply.includes('{'))
})

test('executor: parses tool-call actions', () => {
  const r = parseExecutorResponse(
    '{ "reply": "done", "actions": [ { "tool": "add_text", "args": { "text": "Hi" } } ] }',
  )
  assert.equal(r.reply, 'done')
  assert.equal(r.actions.length, 1)
  assert.deepEqual(r.actions[0], { tool: 'add_text', args: { text: 'Hi' } })
})

test('executor: drops malformed actions, keeps valid ones', () => {
  const r = parseExecutorResponse(
    '{ "actions": [ { "tool": "a", "args": {} }, { "no": 1 }, { "tool": 5 } ] }',
  )
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].tool, 'a')
})

test('executor: recovers actions from a code-fenced object', () => {
  const raw = 'Sure:\n```json\n{ "actions": [ { "tool": "x" } ] }\n```'
  const r = parseExecutorResponse(raw)
  assert.equal(r.actions.length, 1)
  assert.deepEqual(r.actions[0], { tool: 'x', args: {} })
})

test('replanner: parses decisions and defaults to continue', () => {
  assert.equal(parseReplannerResponse('{ "decision": "finish" }').decision, 'finish')
  assert.equal(parseReplannerResponse('{ "decision": "revise", "plan": ["redo"] }').plan.length, 1)
  assert.equal(parseReplannerResponse('garbage').decision, 'continue')
})

test('plainText: returns prose, strips JSON', () => {
  assert.equal(parsePlainText('All done!'), 'All done!')
  assert.equal(parsePlainText('{ "reply": "Nice" }'), 'Nice')
  assert.equal(parsePlainText('{ "ops": [] }'), '')
})

test('normalizeSteps: trims, de-dupes, caps', () => {
  assert.deepEqual(normalizeSteps(['a', ' a ', 'b', 5, null, ''], 2), ['a', 'b'])
})

test('parsers never throw on garbage', () => {
  assert.doesNotThrow(() => parsePlannerResponse('{ broken ]['))
  assert.doesNotThrow(() => parseExecutorResponse(''))
  assert.doesNotThrow(() => parseReplannerResponse('...'))
})
