import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { createAgent, defineTool, MemoryStore } from '../dist/index.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

const routeReply = (
  replies: { planner: string; executor?: string; synthesizer: string },
  options: { prompt: unknown },
): string => {
  const seen = JSON.stringify(options.prompt)
  if (seen.includes('PLANNER')) return replies.planner
  if (seen.includes('EXECUTOR')) return replies.executor ?? 'ok'
  if (seen.includes('SYNTHESIZER')) return replies.synthesizer
  return 'ok'
}

// A mock that routes its reply by which phase's system prompt it sees. The
// synthesizer streams, so the mock implements doStream as well as doGenerate.
const phaseRouter = (replies: { planner: string; executor?: string; synthesizer: string }) =>
  new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => ({
      content: [{ type: 'text', text: routeReply(replies, options) }],
      finishReason: 'stop',
      usage,
      warnings: [],
    }),
    doStream: async (options: { prompt: unknown }) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: routeReply(replies, options) },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage },
        ],
      }),
    }),
  })

test('prompted loop: plan → execute a tool → synthesize', async () => {
  const added: string[] = []
  const model = phaseRouter({
    planner: JSON.stringify({ reply: 'Adding a title', plan: ['Add a title block'] }),
    executor: JSON.stringify({
      reply: 'Added a title',
      actions: [{ tool: 'add_text', args: { text: 'Title' } }],
    }),
    synthesizer: 'I added a title block for you.',
  })
  const agent = await createAgent({
    model,
    toolMode: 'prompted',
    tools: {
      add_text: defineTool({
        description: 'Add a text block',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }: { text: string }) => {
          added.push(text)
          return { ok: true }
        },
      }),
    },
  })

  const types: string[] = []
  let finalDeltas = ''
  const result = await agent.run('Add a title', {
    onEvent: (e) => {
      types.push(e.type)
      if (e.type === 'final.text-delta') finalDeltas += e.delta
    },
  })

  assert.equal(result.plan.steps.length, 1)
  assert.deepEqual(added, ['Title'])
  assert.equal(result.applied, 1)
  assert.match(result.final, /title/i)
  assert.ok(types.includes('plan.created'))
  assert.ok(types.includes('step.tool-call'))
  assert.ok(types.includes('final.text-delta'))
  assert.equal(finalDeltas, 'I added a title block for you.')
  assert.ok(types.includes('final'))
})

test('empty plan (greeting) answers directly and runs no tools', async () => {
  const ranTool = { called: false }
  const model = phaseRouter({
    planner: JSON.stringify({ reply: 'Hi! What should I build?', plan: [] }),
    synthesizer: 'unused',
  })
  const agent = await createAgent({
    model,
    toolMode: 'prompted',
    tools: {
      noop: defineTool({
        description: 'noop',
        inputSchema: z.object({}),
        execute: async () => {
          ranTool.called = true
          return null
        },
      }),
    },
  })
  const result = await agent.run('hello')
  assert.equal(result.plan.steps.length, 0)
  assert.match(result.final, /Hi/)
  assert.equal(ranTool.called, false)
})

test('excludedTools: an excluded tool is unmounted and cannot be dispatched', async () => {
  const ran = { safe: false, danger: false }
  const model = phaseRouter({
    planner: JSON.stringify({ reply: 'ok', plan: ['Do the thing'] }),
    executor: JSON.stringify({
      reply: 'done',
      actions: [
        { tool: 'safe', args: {} },
        { tool: 'danger', args: {} },
      ],
    }),
    synthesizer: 'Done.',
  })
  const mkTool = (key: 'safe' | 'danger') =>
    defineTool({
      description: key,
      inputSchema: z.object({}),
      execute: async () => {
        ran[key] = true
        return null
      },
    })
  const agent = await createAgent({
    model,
    toolMode: 'prompted',
    tools: { safe: mkTool('safe'), danger: mkTool('danger') },
    excludedTools: ['danger'],
  })
  const result = await agent.run('Do the thing')
  assert.equal(ran.safe, true)
  assert.equal(ran.danger, false)
  assert.equal(result.applied, 1)
  const calls = result.trace[0].toolCalls
  assert.equal(calls.find((c) => c.name === 'danger')?.ok, false)
})

test('memory: prior session turns are read back into the planner prompt', async () => {
  const plannerPrompts: string[] = []
  const model = new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => {
      const seen = JSON.stringify(options.prompt)
      if (seen.includes('PLANNER')) plannerPrompts.push(seen)
      return {
        content: [{ type: 'text', text: JSON.stringify({ reply: 'Hi!', plan: [] }) }],
        finishReason: 'stop',
        usage,
        warnings: [],
      }
    },
  })
  const memory = new MemoryStore()
  await memory.append('s1', { role: 'user', content: 'add a blue title' })
  await memory.append('s1', { role: 'assistant', content: 'Added a blue title.' })

  const agent = await createAgent({ model, toolMode: 'prompted', memory, sessionId: 's1' })
  await agent.run('make it bigger')

  // Two planner calls: the first returned an empty plan for a multi-word goal,
  // so the runner retried once with an explicit nudge before answering.
  assert.equal(plannerPrompts.length, 2)
  assert.match(plannerPrompts[0], /CONVERSATION SO FAR/)
  assert.match(plannerPrompts[0], /add a blue title/)
  assert.match(plannerPrompts[1], /you MUST output 1-6 concrete steps/)
  // The transcript now also holds the new turn.
  const after = await memory.load('s1')
  assert.equal(after.length, 4)
})
