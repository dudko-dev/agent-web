import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { MockLanguageModelV3 } from 'ai/test'
import { createAgent, defineTool } from '../dist/index.js'

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 }

// A mock that routes its reply by which phase's system prompt it sees.
const phaseRouter = (replies: { planner: string; executor?: string; synthesizer: string }) =>
  new MockLanguageModelV3({
    doGenerate: async (options: { prompt: unknown }) => {
      const seen = JSON.stringify(options.prompt)
      let text = 'ok'
      if (seen.includes('PLANNER')) text = replies.planner
      else if (seen.includes('EXECUTOR')) text = replies.executor ?? 'ok'
      else if (seen.includes('SYNTHESIZER')) text = replies.synthesizer
      return { content: [{ type: 'text', text }], finishReason: 'stop', usage, warnings: [] }
    },
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
  const result = await agent.run('Add a title', { onEvent: (e) => types.push(e.type) })

  assert.equal(result.plan.steps.length, 1)
  assert.deepEqual(added, ['Title'])
  assert.equal(result.applied, 1)
  assert.match(result.final, /title/i)
  assert.ok(types.includes('plan.created'))
  assert.ok(types.includes('step.tool-call'))
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
