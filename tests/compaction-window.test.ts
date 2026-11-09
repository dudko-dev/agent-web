import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import {
  compressHistory,
  createAgent,
  defineTool,
  estimateMessagesTokens,
  estimateTokens,
  fitCompactionToWindow,
  MemoryStore,
  resolveBudgets,
  resolveCompaction,
  type AgentEvent,
  type BrowserAgentConfig,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Compaction is judged on the whole context - the fixed prompt (system, tools, skills), the
// transcript and the step log together - against a share of the window, not on each part alone.

// ── the estimate ─────────────────────────────────────────────────────────────

test('estimateTokens: by kind of text - code, JSON and numbers cost more per character than prose', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined as never), 0)
  const n = 1_000
  const prose = estimateTokens('The committee reviews the budget. '.repeat(n / 34))
  const code = estimateTokens('const x = foo(bar, [1, 2, 3]);\n'.repeat(n / 31))
  const json = estimateTokens('{"id":12,"name":"a","tags":["b"]}'.repeat(n / 33))
  const digits = estimateTokens('1234567890'.repeat(n / 10))
  assert.ok(
    prose < code && code < json && json <= digits * 1.2,
    `${prose} ${code} ${json} ${digits}`,
  )
  // 1.1 x (letters / 2.5), digits 1, punctuation 1.1, a space a quarter, a newline 1, other
  // scripts 1/2, CJK and emoji 1.
  assert.equal(estimateTokens('a'.repeat(250)), 110)
  assert.equal(estimateTokens('7'.repeat(100)), 110)
  assert.equal(estimateTokens('{'.repeat(100)), 121)
  assert.equal(estimateTokens(' '.repeat(40)), 11)
  assert.equal(estimateTokens('\n'.repeat(10)), 11)
  assert.equal(estimateTokens('ж'.repeat(100)), 55)
  assert.equal(estimateTokens('漢'.repeat(100)), 110)
  assert.equal(estimateTokens('😀'), 3, 'a surrogate pair is two units')
})

test('estimateTokens: never below the old flat "4 characters a token" for ASCII - it leans high on purpose', () => {
  // Calibrated against Claude's tokenizer (see memory/compress.ts): the flat figure was 0.4-0.7x
  // of the real count for everything but Russian, which would let an 85% threshold overflow.
  let seed = 7
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJ 0123456789 {}[]()",.:;=<>/\\-_\n\t'
  for (let i = 0; i < 200; i += 1) {
    const len = 1 + Math.floor(rand() * 500)
    const text = Array.from(
      { length: len },
      () => alphabet[Math.floor(rand() * alphabet.length)],
    ).join('')
    assert.ok(estimateTokens(text) >= Math.ceil(len / 4), JSON.stringify(text))
  }
})

// ── the threshold ────────────────────────────────────────────────────────────

test('threshold: 85% of the window by default; thresholdRatio and thresholdTokens override it', () => {
  assert.equal(resolveCompaction({}).thresholdTokens, 108_800)
  assert.equal(resolveCompaction({ contextWindowTokens: 10_000 }).thresholdTokens, 8_500)
  assert.equal(
    resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: 0.9 }).thresholdTokens,
    9_000,
  )
  // The absolute number wins over the ratio.
  assert.equal(
    resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: 0.9, thresholdTokens: 5_000 })
      .thresholdTokens,
    5_000,
  )
  // A ratio that makes no sense is the default, not a threshold of zero or a negative one.
  for (const bad of [0, -0.5, 1.5, Number.NaN]) {
    assert.equal(
      resolveCompaction({ contextWindowTokens: 10_000, thresholdRatio: bad }).thresholdTokens,
      8_500,
      String(bad),
    )
  }
})

test('the ratio follows the window of the model that is really loaded', () => {
  const cfg = { thresholdRatio: 0.9 }
  const fitted = fitCompactionToWindow(resolveCompaction(cfg), cfg, 4096)
  assert.equal(fitted.thresholdTokens, 3686)
})

// ── per-call output caps from the window ─────────────────────────────────────

test('resolveBudgets: the long-standing numbers at 128k, scaled with the window, floored and capped', () => {
  assert.deepEqual(resolveBudgets({}, 128_000), {
    planner: 800,
    executor: 1200,
    replanner: 400,
    synthesizer: 3000,
    compaction: 1024,
  })
  // A local model with a 4k window cannot hold a 3000-token answer next to its prompt.
  assert.deepEqual(resolveBudgets({}, 4096), {
    planner: 256,
    executor: 384,
    replanner: 192,
    synthesizer: 512,
    compaction: 256,
  })
  assert.equal(resolveBudgets({}, 32_768).synthesizer, 768)
  // A huge window gets room, up to a ceiling.
  assert.deepEqual(resolveBudgets({}, 2_000_000), {
    planner: 2000,
    executor: 8192,
    replanner: 1500,
    synthesizer: 8192,
    compaction: 4096,
  })
  // What the host set wins, per phase; the rest still follows the window.
  const b = resolveBudgets(
    { limits: { perCall: { synthesizer: 5000 } }, budgets: { planner: 900 } },
    4096,
  )
  assert.deepEqual([b.synthesizer, b.planner, b.executor], [5000, 900, 384])
  assert.equal(resolveBudgets({ compaction: { summaryMaxTokens: 700 } }, 4096).compaction, 700)
})

const plan = (n = 1) =>
  JSON.stringify({
    thought: 'ok',
    steps: Array.from({ length: n }, (_, i) => ({ description: `Step ${i + 1}` })),
  })

test('on the wire: the caps a call carries follow the window the agent runs in', async () => {
  const caps = async (extra: Partial<BrowserAgentConfig>) => {
    const m = scriptedModel((info) =>
      stageOf(info) === 'planner' ? { text: plan() } : { text: 'Done.' },
    )
    await (await createAgent({ model: m.model, ...extra })).run('hello')
    const seen: Record<string, unknown> = {}
    for (const c of m.calls) seen[stageOf(c)] ??= c.options.maxOutputTokens
    return seen
  }
  const small = await caps({ compaction: { contextWindowTokens: 32_768 } })
  assert.deepEqual(
    [small.planner, small.executor, small.synthesizer],
    [256, 384, 768],
    'a 32k window',
  )
  const dflt = await caps({})
  assert.deepEqual([dflt.planner, dflt.executor, dflt.synthesizer], [800, 1200, 3000])
  const explicit = await caps({
    compaction: { contextWindowTokens: 32_768 },
    limits: { perCall: { synthesizer: 5000 } },
  })
  assert.deepEqual([explicit.synthesizer, explicit.executor], [5000, 384])
})

// ── the whole context decides ────────────────────────────────────────────────

const SUMMARISE_HISTORY = 'Summarize the following conversation'
const SUMMARISE_STEPS = 'Summarize these completed agent steps'

const compactionRun = async (opts: {
  seed?: { role: 'user' | 'assistant'; content: string }[]
  goal?: string
  steps?: number
  stepText?: string
  systemPrompt?: string
  window?: number
  tools?: BrowserAgentConfig['tools']
  strategy?: BrowserAgentConfig['toolSelectionStrategy']
}) => {
  const memory = new MemoryStore()
  for (const m of opts.seed ?? []) await memory.append('default', m)
  const order: string[] = []
  const summariserPrompts: string[] = []
  const m = scriptedModel((info: CallInfo): Reply => {
    if (info.system.includes(SUMMARISE_HISTORY)) {
      order.push('summarise-history')
      summariserPrompts.push(info.user)
      return { text: 'earlier talk, summarised' }
    }
    if (info.system.includes(SUMMARISE_STEPS)) {
      order.push('summarise-steps')
      return { text: 'earlier steps, summarised' }
    }
    order.push(stageOf(info))
    if (stageOf(info) === 'planner') return { text: plan(opts.steps ?? 1) }
    if (stageOf(info) === 'executor') return { text: opts.stepText ?? 'ok' }
    return { text: 'Done.' }
  })
  const agent = await createAgent({
    model: m.model,
    memory,
    systemPrompt: opts.systemPrompt,
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.strategy ? { toolSelectionStrategy: opts.strategy } : {}),
    compaction: { contextWindowTokens: opts.window ?? 10_000, keepRecentSteps: 1 },
  })
  const events: AgentEvent[] = []
  await agent.run(opts.goal ?? 'hello', { onEvent: (e) => events.push(e) })
  const compacted = events.flatMap((e) => (e.type === 'context.compacted' ? [e.scope] : []))
  return { order, compacted, memory, summariserPrompts }
}

// 8 messages of `char`, as many as make them weigh about `tokens` BY THE ESTIMATOR ITSELF (so the
// scenarios keep their meaning if the estimate is ever recalibrated). The default keeps 4 verbatim.
const transcript = (tokens: number, char = 'x') => {
  const make = (n: number) =>
    Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: char.repeat(n),
    }))
  let lo = 1
  let hi = 200_000
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateMessagesTokens(make(mid)) <= tokens) lo = mid
    else hi = mid - 1
  }
  return make(lo)
}

// A system prompt that takes about `tokens` by the estimator ('p' = a letter, 0.44 a character).
const systemPromptOf = (tokens: number) => 'p'.repeat(Math.round(tokens / 0.44))

// Window 10 000 -> threshold 8 500 (85%); the fixed prompt is 1 500 tokens plus whatever the
// scenario adds (system prompt, tools, skills).
test('history: the fixed prompt counts - a transcript just under the threshold alone still compacts', async () => {
  const under = await compactionRun({ seed: transcript(5_000) })
  assert.deepEqual(under.compacted, [], '5 000 + 1 500 < 8 500')
  assert.ok(!under.order.includes('summarise-history'))
  const over = await compactionRun({ seed: transcript(7_500) })
  assert.ok(
    over.compacted.includes('history'),
    '7 500 alone is under 8 500; with the prompt it is not',
  )
  assert.equal(over.order.filter((s) => s === 'summarise-history').length, 1)
  // It happened BEFORE planning (so the run starts inside the window), not only after the run.
  assert.equal(over.order[0], 'summarise-history')
})

test('history: the same characters weigh differently - numbers cost more than prose', async () => {
  // 1 000 characters a message: prose is ~0.44 tokens a character, digits ~1.1.
  const chars = (n: number, c: string) =>
    Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: c.repeat(n),
    }))
  assert.deepEqual((await compactionRun({ seed: chars(1_000, 'x') })).compacted, [], 'prose')
  const digits = await compactionRun({ seed: chars(1_000, '7') })
  assert.ok(digits.compacted.includes('history'), 'digits: ~8 900 tokens')
  assert.equal(digits.order[0], 'summarise-history')
  assert.deepEqual(
    (await compactionRun({ seed: chars(1_000, 'ж') })).compacted,
    [],
    'Russian: ~4 400 - more than prose, nowhere near digits',
  )
})

test('step log: it shares the window with the fixed prompt and the transcript', async () => {
  // A 6 500-token system prompt leaves the log ~500 tokens of room under an 8 500 threshold.
  const big = systemPromptOf(6_500)
  const run = (systemPrompt?: string) =>
    compactionRun({ steps: 6, stepText: 'y'.repeat(500), systemPrompt })
  const tight = await run(big)
  assert.ok(tight.compacted.includes('trace'), 'the log was folded')
  assert.ok(tight.order.includes('summarise-steps'))
  const roomy = await run(undefined)
  assert.ok(!roomy.compacted.includes('trace'), 'the same log fits when nothing else is in the way')
})

test('after the run: the stored transcript is compacted when it no longer fits with the prompt', async () => {
  // Fixed prompt ~8 000; a 480-token transcript fits at the start (8 480 < 8 500) but the run
  // adds the goal and the answer.
  const big = systemPromptOf(6_500)
  const r = await compactionRun({ seed: transcript(480), systemPrompt: big, goal: 'g'.repeat(800) })
  assert.ok(!r.compacted.includes('trace'))
  assert.deepEqual(r.compacted, ['history'])
  const summaryAt = r.order.indexOf('summarise-history')
  assert.ok(summaryAt > r.order.indexOf('synthesizer'), 'after the answer, not before the run')
  const stored = await r.memory.load('default')
  assert.match(stored[0].content, /^Summary of earlier conversation/)
})

// ── what the summariser is shown ─────────────────────────────────────────────

test('compressHistory: the summariser sees the NEWEST part that fits maxInputTokens', async () => {
  const seen: string[] = []
  const m = scriptedModel((info) => {
    seen.push(info.user)
    return { text: 'summary' }
  })
  const lines = Array.from({ length: 40 }, (_, i) => ({
    role: 'user' as const,
    content: `line-${String(i).padStart(2, '0')} ${'z'.repeat(392)}`,
  }))
  await compressHistory(lines, m.model, { keepRecent: 2, force: true, maxInputTokens: 1_000 })
  const prompt = seen[0]
  assert.match(prompt, /line-37/, 'the newest of the older lines is there')
  assert.doesNotMatch(prompt, /line-00/, 'the oldest is cut')
  assert.ok(estimateTokens(prompt) <= 1_100, `${estimateTokens(prompt)} tokens`)
  // Without a budget it is the historical cut: the last 48 000 characters.
  await compressHistory(lines, m.model, { keepRecent: 2, force: true })
  assert.match(seen[1], /line-00/, '38 lines of 400 chars are under 48 000')
})

test('tool definitions count: a big catalogue tips a compaction that the transcript alone would not', async () => {
  const wordy = (name: string) =>
    defineTool({
      description: 'd'.repeat(8_000), // ~3 500 tokens of definition
      inputSchema: z.object({ q: z.string() }),
      execute: async () => name,
    })
  // 3 900 tokens of transcript + 1 500 fixed fits an 8 500 threshold; with ~3 500 of tool
  // definitions on top it does not.
  const without = await compactionRun({ seed: transcript(3_900) })
  assert.ok(!without.order.includes('summarise-history'))
  const withTool = await compactionRun({
    seed: transcript(3_900),
    tools: { big: wordy('big') },
    strategy: 'all', // 'auto' would already switch to search: the catalogue crowds a 10k window
  })
  assert.equal(withTool.order[0], 'summarise-history')
  // Under tool search only a few definitions are sent at a time, so the same catalogue weighs
  // at most the search allowance (3 000): 3 900 + 4 500 = 8 400 - and does not tip it.
  const searching = await compactionRun({
    seed: transcript(3_900),
    tools: { big: wordy('big') },
    strategy: 'search',
  })
  assert.ok(!searching.order.includes('summarise-history'))
})

test('step log: the transcript shares its window too', async () => {
  // History 5 600 + fixed ~1 500 = 7 100 < 8 500: no compaction at the start. That leaves the
  // log ~1 400 tokens, and eight steps of ~250 outgrow it.
  const r = await compactionRun({ seed: transcript(5_600), steps: 8, stepText: 'y'.repeat(560) })
  assert.notEqual(r.order[0], 'summarise-history', 'not compacted at the start')
  assert.ok(r.compacted.includes('trace'))
  assert.ok(r.order.includes('summarise-steps'))
  // Without the transcript in the way the same log fits.
  const alone = await compactionRun({ steps: 8, stepText: 'y'.repeat(560) })
  assert.ok(!alone.compacted.includes('trace'))
})

test('a long history is summarised through a window-sized lens, not the old 48 000 characters', async () => {
  // Older turns ~7 000 tokens; the summariser may be shown 60% of a 10 000 window.
  const r = await compactionRun({ seed: transcript(14_000) })
  const shown = r.summariserPrompts[0]
  assert.ok(shown, 'the history was summarised')
  assert.ok(estimateTokens(shown) <= 6_200, `${estimateTokens(shown)} tokens shown`)
  assert.ok(estimateTokens(shown) >= 5_000, 'and most of what fits, not a token or two')
})

test('after the model reports its window, the caps follow it (a loaded local model)', async () => {
  const scripted = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: JSON.stringify({ reply: '', plan: ['Look'] }) }
      : { text: 'Done.' },
  )
  Object.defineProperty(scripted.model, 'provider', { value: 'web-llm' })
  Object.defineProperty(scripted.model, 'modelId', { value: 'Qwen3.5-0.8B-q4f16_1-MLC' })
  Object.assign(scripted.model, {
    engine: {
      loadedModelIdToPipeline: new Map([['Qwen3.5-0.8B-q4f16_1-MLC', { contextWindowSize: 4096 }]]),
    },
  })
  const agent = await createAgent({ model: scripted.model })
  await agent.run('hello')
  const seen: Record<string, unknown> = {}
  for (const c of scripted.calls) seen[stageOf(c)] ??= c.options.maxOutputTokens
  assert.deepEqual([seen.planner, seen.executor, seen.synthesizer], [256, 384, 512])
})
