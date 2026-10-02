import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  createAgent,
  createToolResultClearer,
  defineTool,
  sortTools,
  withRollingBreakpoint,
  type AgentEvent,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

type RawMessage = { role: string; content: unknown; providerOptions?: unknown }
type RawPart = { type: string; toolName?: string; output?: { type: string; value: unknown } }

const plan = (steps: string[]) =>
  JSON.stringify({ thought: 'plan', steps: steps.map((description) => ({ description })) })

const BREAKPOINT = { anthropic: { cacheControl: { type: 'ephemeral' } } }

test('withRollingBreakpoint marks only the last message and keeps its own options', () => {
  const msgs = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b', providerOptions: { openai: { x: 1 } } },
  ]
  const out = withRollingBreakpoint(msgs, { enabled: true, ttl: '1h' })
  assert.equal(out[0].providerOptions, undefined)
  assert.deepEqual(out[1].providerOptions, {
    openai: { x: 1 },
    anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
  })
  assert.equal(msgs[1].providerOptions.openai.x, 1) // input untouched
  assert.equal(withRollingBreakpoint(msgs, { enabled: false }), msgs)
  // A breakpoint on an earlier message moves to the newest one.
  const again = withRollingBreakpoint([...out, { role: 'user', content: 'c' }], { enabled: true })
  assert.deepEqual(again[1].providerOptions, { openai: { x: 1 } })
  assert.deepEqual(again[2].providerOptions, BREAKPOINT)
})

test('createToolResultClearer: clears the oldest results past the trigger, sticky, keeps the last N', () => {
  const infos: unknown[] = []
  const clear = createToolResultClearer({ triggerTokens: 30, keep: 1 }, (i) => infos.push(i))
  const result = (id: string, value: string) =>
    ({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: id, toolName: 'read', output: { type: 'text', value } },
      ],
    }) as never
  const big = 'x'.repeat(200)
  const round1 = [{ role: 'user', content: 'go' } as never, result('a', 'small')]
  assert.equal(clear(round1), round1) // under the trigger: untouched
  const round2 = [...round1, result('b', big), result('c', big)]
  const edited = clear(round2) as unknown as { content: RawPart[] }[]
  const value = (i: number) => edited[i].content[0].output?.value as string
  assert.match(value(1), /read result cleared/)
  assert.match(value(2), /read result cleared/)
  assert.equal(value(3), big) // the newest result stays
  assert.equal(infos.length, 1)
  // Sticky: the same ids stay cleared even once the context is small again.
  const shrunk = clear([round1[0], result('a', 'small')]) as unknown as { content: RawPart[] }[]
  assert.match(shrunk[1].content[0].output?.value as string, /cleared/)
})

test('sortTools orders a tool set by name', () => {
  assert.deepEqual(Object.keys(sortTools({ zeta: 1, alpha: 2, mid: 3 })), ['alpha', 'mid', 'zeta'])
})

test('tool loop: the cache breakpoint rolls to the newest message every round; tools go in name order', async () => {
  const route = (info: CallInfo): Reply => {
    if (stageOf(info) === 'planner') return { text: plan(['Look it up']) }
    if (stageOf(info) === 'executor') {
      return info.toolResults === 0
        ? { toolCalls: [{ name: 'lookup', args: { q: 'x' } }] }
        : { text: 'found it' }
    }
    return { text: 'answer' }
  }
  const { model, calls } = scriptedModel(route)
  const agent = await createAgent({
    model,
    tools: {
      zeta: defineTool({ description: 'z', inputSchema: z.object({}), execute: async () => 'z' }),
      lookup: defineTool({
        description: 'look up',
        inputSchema: z.object({ q: z.string() }),
        execute: async () => 'value',
      }),
    },
  })
  await agent.run('find x')
  const exec = calls.filter((c) => stageOf(c) === 'executor')
  assert.equal(exec.length, 2)
  assert.deepEqual(exec[0].tools, ['lookup', 'zeta'])
  for (const call of exec) {
    const prompt = call.options.prompt as RawMessage[]
    const marked = prompt.filter((m) =>
      JSON.stringify(m.providerOptions ?? {}).includes('cacheControl'),
    )
    // The system message and the newest message — nothing in between.
    assert.equal(prompt[0].role, 'system')
    assert.deepEqual(prompt.at(-1)?.providerOptions, BREAKPOINT)
    assert.equal(marked.length, 2)
  }
  assert.equal((exec[1].options.prompt as RawMessage[]).at(-1)?.role, 'tool')
})

test('tool loop: stale tool results are cleared past the threshold and the clearing is reported', async () => {
  const big = 'y'.repeat(4000)
  let round = 0
  const route = (info: CallInfo): Reply => {
    if (stageOf(info) === 'planner') return { text: plan(['Read three pages']) }
    if (stageOf(info) === 'executor') {
      round = info.toolResults
      return round < 3
        ? { toolCalls: [{ name: 'page', args: { n: round } }] }
        : { text: 'read all' }
    }
    return { text: 'answer' }
  }
  const { model, calls } = scriptedModel(route)
  const events: AgentEvent[] = []
  const agent = await createAgent({
    model,
    maxStepsPerTask: 6,
    compaction: { clearToolResultsAfterTokens: 1200, keepToolResults: 1 },
    tools: {
      page: defineTool({
        description: 'read a page',
        inputSchema: z.object({ n: z.number() }),
        execute: async () => big,
      }),
    },
  })
  await agent.run('read', { onEvent: (e) => events.push(e) })
  assert.equal(events.filter((e) => e.type === 'step.tool-result').length, 3)
  const last = calls.filter((c) => stageOf(c) === 'executor').at(-1)!
  const outputs = (last.options.prompt as RawMessage[])
    .filter((m) => m.role === 'tool')
    .flatMap((m) => m.content as RawPart[])
    .map((p) => String(p.output?.value))
  assert.equal(outputs.length, 3)
  assert.match(outputs[0], /page result cleared to save context/)
  assert.match(outputs[1], /page result cleared to save context/)
  assert.equal(outputs[2], big)
  const compacted = events.filter(
    (e) => e.type === 'context.compacted' && e.scope === 'tool-results',
  )
  assert.ok(compacted.length >= 1)
})

test('promptCaching: false → no rolling breakpoint in the tool loop', async () => {
  const route = (info: CallInfo): Reply => {
    if (stageOf(info) === 'planner') return { text: plan(['Do it']) }
    return { text: 'ok' }
  }
  const { model, calls } = scriptedModel(route)
  await (await createAgent({ model, promptCaching: false })).run('do it now please')
  for (const call of calls) {
    assert.ok(!JSON.stringify(call.options.prompt).includes('cacheControl'))
  }
})
