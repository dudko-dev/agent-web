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

test('runToolLoop prompted: tool results are fed back so the model can finish the step', async () => {
  const prompts: string[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => {
      const seen = JSON.stringify(options.prompt)
      prompts.push(seen)
      const text = seen.includes('TOOL RESULTS')
        ? JSON.stringify({ reply: 'x is now 2.', actions: [] })
        : JSON.stringify({ reply: 'adding', actions: [{ tool: 'add', args: { x: 1 } }] })
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        // The V3 nested usage shape — so the summed-usage assertion is real.
        usage: {
          inputTokens: {
            total: 1,
            noCache: undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: undefined, reasoning: undefined },
        },
        warnings: [],
      }
    },
  })
  const r = await runToolLoop(model, { mode: 'prompted', prompt: 'go', tools })
  assert.equal(prompts.length, 2)
  // The follow-up round sees the dispatched result and the re-stated contract.
  assert.match(prompts[1], /TOOL RESULTS/)
  assert.match(prompts[1], /ok: 2/)
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].output, 2)
  // The last non-empty reply wins; usage is summed across rounds.
  assert.equal(r.text, 'x is now 2.')
  assert.equal(r.usage.totalTokens, 4)
})

test('runToolLoop prompted: an identical re-emitted batch stops the loop (no double apply)', async () => {
  let generations = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generations += 1
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ reply: 'adding', actions: [{ tool: 'add', args: { x: 5 } }] }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  const r = await runToolLoop(model, { mode: 'prompted', prompt: 'go', tools })
  // Round 2 re-emitted the exact same batch — dispatched once, then stopped.
  assert.equal(generations, 2)
  assert.equal(r.toolCalls.length, 1)
})

test('runToolLoop prompted: maxSteps 1 restores the single-round behaviour', async () => {
  let generations = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generations += 1
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ reply: 'adding', actions: [{ tool: 'add', args: { x: 1 } }] }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  const r = await runToolLoop(model, { mode: 'prompted', prompt: 'go', tools, maxSteps: 1 })
  assert.equal(generations, 1)
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].ok, true)
})

test('runToolLoop prompted: a [BLOCKER] reply is preserved and stops before dispatching', async () => {
  let generations = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      generations += 1
      // The model contradicts itself — BLOCKER *and* a speculative action. The
      // BLOCKER is authoritative: stop, keep the reply, run nothing.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              reply: '[BLOCKER] cannot find the file',
              actions: [{ tool: 'add', args: { x: 1 } }],
            }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  const r = await runToolLoop(model, { mode: 'prompted', prompt: 'go', tools })
  assert.equal(generations, 1)
  assert.equal(r.toolCalls.length, 0)
  assert.match(r.text, /\[BLOCKER\]/)
})

test('runToolLoop prompted: A→B→A oscillation is caught (A is not dispatched twice)', async () => {
  let round = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      round += 1
      const x = round % 2 === 1 ? 1 : 2 // batches A, B, A, B, …
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ reply: 'go', actions: [{ tool: 'add', args: { x } }] }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  const r = await runToolLoop(model, { mode: 'prompted', prompt: 'go', tools })
  // round 1 = A(x:1), round 2 = B(x:2), round 3 = A again → already seen, stop.
  assert.equal(round, 3)
  assert.equal(r.toolCalls.length, 2)
  assert.equal(r.toolCalls.filter((c) => c.output === 2).length, 1) // add(1)→2 ran exactly once
})

test('runToolLoop prompted: onTextDelta fires once with the final reply, not per round', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => {
      const seen = JSON.stringify(options.prompt)
      const text = seen.includes('TOOL RESULTS')
        ? JSON.stringify({ reply: 'done', actions: [] })
        : JSON.stringify({ reply: 'working', actions: [{ tool: 'add', args: { x: 1 } }] })
      return {
        content: [{ type: 'text', text }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }
    },
  })
  const deltas: string[] = []
  const r = await runToolLoop(model, {
    mode: 'prompted',
    prompt: 'go',
    tools,
    callbacks: { onTextDelta: (d: string) => deltas.push(d) },
  })
  // A delta-accumulating consumer must not see 'working' + 'done' concatenated.
  assert.deepEqual(deltas, ['done'])
  assert.equal(r.text, 'done')
})

test('defineTool: toModelOutput passes through for multi-modal native tool results', () => {
  const toModelOutput = () => ({
    type: 'content' as const,
    value: [{ type: 'text' as const, text: 'rendered' }],
  })
  const t = defineTool({
    description: 'render',
    inputSchema: z.object({}),
    execute: async () => 'raw',
    toModelOutput,
  })
  assert.equal((t as { toModelOutput?: unknown }).toModelOutput, toModelOutput)
})
