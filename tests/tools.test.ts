import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { MockLanguageModelV3 } from 'ai/test'
import { defineTool, renderCatalog, dispatch, selectToolMode, runToolLoop } from '../dist/index.js'

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

test('selectToolMode: gateway ids stay native even when the MODEL name matches LOCAL_RE', () => {
  assert.equal(selectToolMode('openai/gpt-5-nano', 'auto'), 'native')
  assert.equal(selectToolMode('google/gemini-2.5-flash', 'auto'), 'native')
})

const promptedModel = (text: string) =>
  new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
  })

test('runToolLoop prompted: activeTools bounds dispatch (plan-narrowed parity)', async () => {
  const model = promptedModel(
    JSON.stringify({ reply: 'ok', actions: [{ tool: 'add', args: { x: 1 } }] }),
  )
  const narrowed = await runToolLoop(model, {
    mode: 'prompted',
    prompt: 'go',
    tools,
    activeTools: [],
  })
  assert.equal(narrowed.toolCalls.length, 1)
  assert.equal(narrowed.toolCalls[0].ok, false)
  assert.match(String(narrowed.toolCalls[0].output), /unknown tool/)

  const allowed = await runToolLoop(model, {
    mode: 'prompted',
    prompt: 'go',
    tools,
    activeTools: ['add'],
  })
  assert.equal(allowed.toolCalls[0].ok, true)
  assert.equal(allowed.toolCalls[0].output, 2)
})

test('runToolLoop prompted: the text delta is the parsed reply, never raw JSON', async () => {
  const model = promptedModel(JSON.stringify({ reply: 'Did it.', actions: [] }))
  const deltas: string[] = []
  const r = await runToolLoop(model, {
    mode: 'prompted',
    prompt: 'go',
    tools,
    callbacks: { onTextDelta: (d: string) => deltas.push(d) },
  })
  assert.equal(r.text, 'Did it.')
  assert.deepEqual(deltas, ['Did it.'])
})
