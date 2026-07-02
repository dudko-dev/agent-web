import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { defineTool, renderCatalog, dispatch, selectToolMode } from '../dist/index.js'

const tools = {
  add: defineTool({
    description: 'Add one to x',
    inputSchema: z.object({ x: z.number() }),
    promptHint: '{ x: number }',
    execute: async ({ x }: { x: number }) => x + 1,
  }),
}

test('renderCatalog lists "- name(hint): description"', () => {
  assert.match(renderCatalog(tools), /- add\(\{ x: number \}\): Add one to x/)
})

test('dispatch executes a valid call through the tool execute', async () => {
  const r = await dispatch({ tool: 'add', args: { x: 2 } }, tools)
  assert.equal(r.ok, true)
  assert.equal(r.output, 3)
})

test('dispatch rejects schema-invalid args', async () => {
  const r = await dispatch({ tool: 'add', args: { x: 'nope' } }, tools)
  assert.equal(r.ok, false)
  assert.match(String(r.output), /invalid args/)
})

test('dispatch reports an unknown tool', async () => {
  const r = await dispatch({ tool: 'missing', args: {} }, tools)
  assert.equal(r.ok, false)
  assert.match(String(r.output), /unknown tool/)
})

test('selectToolMode: cloud → native, local → prompted, explicit wins', () => {
  assert.equal(selectToolMode('openai/gpt-4o', 'auto'), 'native')
  assert.equal(selectToolMode({ provider: 'openai.responses' } as never, 'auto'), 'native')
  assert.equal(selectToolMode({ provider: 'web-llm' } as never, 'auto'), 'prompted')
  assert.equal(selectToolMode({ provider: 'browser-ai' } as never, 'auto'), 'prompted')
  assert.equal(selectToolMode({ provider: 'web-llm' } as never, 'native'), 'native')
})
