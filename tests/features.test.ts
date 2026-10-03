import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  checkLimits,
  createAgent,
  createSubagentTool,
  decideToolPermission,
  defaultPrompts,
  defineSkill,
  defineTool,
  limitModelOutput,
  matchRule,
  MemoryStore,
  parseSkillMarkdown,
  renderSearchCatalog,
  resolveThinking,
  searchTools,
  serveSubagentWorker,
  thinkingFor,
  type AgentEvent,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

const plan = (steps: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    thought: 'plan',
    steps: steps.map((description) => ({ description })),
    ...extra,
  })

const collect = () => {
  const events: AgentEvent[] = []
  return {
    events,
    onEvent: (e: AgentEvent) => events.push(e),
    types: () => events.map((e) => e.type),
  }
}

// ── pure helpers ────────────────────────────────────────────────────────────

test('resolveThinking maps settings to a reasoning level and provider options', () => {
  assert.deepEqual(resolveThinking(undefined), {})
  assert.deepEqual(resolveThinking(false), {})
  // WebLLM ignores the portable level; its thinking models take enable_thinking.
  const webllm = (on: boolean) => ({ extra_body: { enable_thinking: on } })
  assert.deepEqual(resolveThinking('none'), {
    reasoning: 'none',
    providerOptions: { 'web-llm': webllm(false) },
  })
  const on = resolveThinking(true)
  assert.equal(on.reasoning, 'medium')
  assert.deepEqual(on.providerOptions?.google, { thinkingConfig: { includeThoughts: true } })
  assert.deepEqual(on.providerOptions?.openai, { reasoningSummary: 'auto' })
  assert.deepEqual(on.providerOptions?.['web-llm'], webllm(true))
  const budget = resolveThinking({ level: 'high', budgetTokens: 2048 })
  assert.equal(budget.reasoning, 'high')
  assert.deepEqual(budget.providerOptions?.anthropic, {
    thinking: { type: 'enabled', budgetTokens: 2048 },
  })
  assert.deepEqual(budget.providerOptions?.google, {
    thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
  })
  assert.deepEqual(budget.providerOptions?.['web-llm'], webllm(true))
  assert.deepEqual(resolveThinking({ level: 'low', includeThoughts: false }), {
    reasoning: 'low',
    providerOptions: { 'web-llm': webllm(true) },
  })
})

test('thinkingFor: a stage entry wins over the top-level setting', () => {
  assert.equal(thinkingFor('executor', 'high', { executor: 'low' }), 'low')
  assert.equal(thinkingFor('planner', 'high', { executor: 'low' }), 'high')
  assert.equal(thinkingFor('synthesizer', 'high', { synthesizer: false }), false)
})

test('checkLimits reports the broadest cap reached first', () => {
  const usage = {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    reasoningTokens: 40,
  }
  assert.equal(checkLimits(usage, undefined), undefined)
  assert.equal(checkLimits(usage, { maxTotalTokens: 1000 }), undefined)
  assert.deepEqual(checkLimits(usage, { maxTotalTokens: 150, maxInputTokens: 10 }), {
    kind: 'total',
    tokens: 150,
    cap: 150,
  })
  assert.deepEqual(checkLimits(usage, { maxInputTokens: 100 }), {
    kind: 'input',
    tokens: 100,
    cap: 100,
  })
  assert.deepEqual(checkLimits(usage, { maxOutputTokens: 20 }), {
    kind: 'output',
    tokens: 50,
    cap: 20,
  })
  assert.deepEqual(checkLimits(usage, { maxReasoningTokens: 40 }), {
    kind: 'reasoning',
    tokens: 40,
    cap: 40,
  })
})

test('searchTools ranks name over server over description and honours filters', () => {
  const catalog = [
    { name: 'docs__search_pages', description: 'Full-text search over the wiki', server: 'docs' },
    { name: 'github__list_issues', description: 'List issues of a repository', server: 'github' },
    { name: 'github__create_issue', description: 'Open a new issue', server: 'github' },
    { name: 'jira__find', description: 'Search jira issues by JQL', server: 'jira' },
  ]
  const hits = searchTools(catalog, 'issues')
  assert.deepEqual(
    hits.map((h) => h.name),
    ['github__list_issues', 'github__create_issue', 'jira__find'],
  )
  assert.deepEqual(
    searchTools(catalog, 'issue', { server: 'jira' }).map((h) => h.name),
    ['jira__find'],
  )
  assert.equal(searchTools(catalog, 'createIssue')[0].name, 'github__create_issue')
  assert.deepEqual(searchTools(catalog, 'unrelated words'), [])
  assert.equal(searchTools(catalog, 'issue', { limit: 1 }).length, 1)
})

test('renderSearchCatalog groups by server and stays within its budget', () => {
  const catalog = Array.from({ length: 300 }, (_, i) => ({
    name: `s${i % 3}__tool_${i}`,
    description: 'A tool that does a thing '.repeat(5),
    server: `s${i % 3}`,
  }))
  const out = renderSearchCatalog(catalog, 2_000)
  assert.ok(out.length < 2_200)
  assert.match(out, /^\[s0\] 100 tool\(s\)/)
  assert.match(out, /more tool\(s\) — the executor can find them with find_tools/)
})

test('parseSkillMarkdown reads frontmatter (quoted and folded values) and the body', () => {
  const skill = parseSkillMarkdown(
    `---\nname: release-notes\ndescription: >\n  Write release notes\n  from merged PRs.\nauthor: 'Jane'\n---\n# Steps\n1. List PRs\n`,
    [{ path: 'template.md', content: '## Notes' }],
  )
  assert.equal(skill.name, 'release-notes')
  assert.equal(skill.description, 'Write release notes from merged PRs.')
  assert.equal(skill.content, '# Steps\n1. List PRs')
  assert.equal(skill.files?.[0].path, 'template.md')
  assert.equal(
    parseSkillMarkdown('---\nname: "quoted-name"\ndescription: "a: b"\n---\nx').description,
    'a: b',
  )
  assert.throws(() => parseSkillMarkdown('no frontmatter'), /frontmatter/)
  assert.throws(() => defineSkill({ name: 'Bad Name', description: 'd', content: '' }), /invalid/)
  assert.throws(() => defineSkill({ name: 'ok', description: ' ', content: '' }), /description/)
})

test('tool permission: remembered > most specific rule > mode default', () => {
  const rules = { 'github__*': 'ask', 'github__delete_*': 'deny', github__read: 'allow' } as const
  assert.equal(matchRule(rules, 'github__delete_repo'), 'deny')
  assert.equal(matchRule(rules, 'github__read'), 'allow')
  assert.equal(matchRule(rules, 'github__write'), 'ask')
  assert.equal(matchRule(rules, 'jira__x'), undefined)
  const decide = (mode: 'autopilot' | 'ask-writes' | 'ask-all' | 'read-only', readOnly: boolean) =>
    decideToolPermission({ toolName: 'x', readOnly, mode })
  assert.equal(decide('autopilot', false), 'allow')
  assert.equal(decide('ask-writes', false), 'ask')
  assert.equal(decide('ask-writes', true), 'allow')
  assert.equal(decide('ask-all', true), 'ask')
  assert.equal(decide('read-only', false), 'deny')
  assert.equal(decide('read-only', true), 'allow')
  // An explicit rule beats autopilot; a remembered approval beats the rule.
  assert.equal(
    decideToolPermission({ toolName: 'github__x', readOnly: false, mode: 'autopilot', rules }),
    'ask',
  )
  assert.equal(
    decideToolPermission({
      toolName: 'github__x',
      readOnly: false,
      mode: 'ask-all',
      rules,
      remembered: new Set(['github__x']),
    }),
    'allow',
  )
})

test('limitModelOutput truncates what the model sees, text and json alike', async () => {
  const cap = limitModelOutput(undefined, 10)
  const text = await cap({ toolCallId: 'c', input: {}, output: 'x'.repeat(50) } as never)
  assert.equal(text.type, 'text')
  assert.match((text as { value: string }).value, /^x{10}… \[truncated 40 chars\]$/)
  const json = await cap({ toolCallId: 'c', input: {}, output: { a: 'y'.repeat(50) } } as never)
  assert.equal(json.type, 'text')
  const small = await cap({ toolCallId: 'c', input: {}, output: { a: 1 } } as never)
  assert.deepEqual(small, { type: 'json', value: { a: 1 } })
})

test('prompts are autonomous: no asking the user, consent is the system’s job', () => {
  const planner = defaultPrompts.planner({ goal: 'g', toolCatalog: '-', mode: 'native' })
  assert.match(planner.system, /Never plan a step that asks the user/)
  const executor = defaultPrompts.executor({
    goal: 'g',
    step: 's',
    index: 1,
    total: 1,
    toolCatalog: '-',
    done: [],
    mode: 'native',
  })
  assert.match(executor.system, /never ask the user questions or for confirmation/)
  // The goal and progress are dynamic and stay OUT of the cacheable system prompt.
  assert.doesNotMatch(executor.system, /GOAL:/)
  assert.match(planner.system, /TOOLS:/)
})

// ── native runs over a scripted model ──────────────────────────────────────

const noteTools = (log: string[]) => ({
  add_note: defineTool({
    description: 'Add a note',
    inputSchema: z.object({ text: z.string() }),
    execute: async ({ text }: { text: string }) => {
      log.push(`add:${text}`)
      return { id: log.length }
    },
  }),
  list_notes: defineTool({
    description: 'List notes',
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => {
      log.push('list')
      return { notes: [] }
    },
  }),
})

/** Executor: call `calls` on the first round, then report `done`. */
const executorReply = (info: CallInfo, calls: Reply['toolCalls'], done = 'Done.'): Reply =>
  info.toolResults === 0 && calls?.length ? { toolCalls: calls } : { text: done }

test('thinking: the level and provider options reach the model, thoughts stream, usage counts them', async () => {
  const { model, calls } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Add a note']) }
      case 'executor':
        return {
          ...executorReply(info, [{ name: 'add_note', args: { text: 'hi' } }]),
          reasoning: info.toolResults === 0 ? 'thinking about notes' : undefined,
          usage: { reasoning: 3, cacheRead: 4 },
        }
      default:
        return { text: 'Added the note.', reasoning: 'summing up' }
    }
  })
  const log: string[] = []
  const agent = await createAgent({
    model,
    tools: noteTools(log),
    thinking: { level: 'high', budgetTokens: 1024 },
    stageThinking: { planner: false },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('add a note hi', { onEvent })

  assert.deepEqual(log, ['add:hi'])
  const executorCall = calls.find((c) => stageOf(c) === 'executor')!
  assert.equal(executorCall.options.reasoning, 'high')
  assert.deepEqual((executorCall.options.providerOptions as Record<string, unknown>).anthropic, {
    thinking: { type: 'enabled', budgetTokens: 1024 },
  })
  const plannerCall = calls.find((c) => stageOf(c) === 'planner')!
  assert.equal(plannerCall.options.reasoning, undefined)
  assert.ok(
    events.some((e) => e.type === 'step.reasoning-delta' && e.delta === 'thinking about notes'),
  )
  assert.ok(events.some((e) => e.type === 'final.reasoning-delta' && e.delta === 'summing up'))
  assert.ok((result.usage.reasoningTokens ?? 0) >= 6)
  assert.ok((result.usage.cachedInputTokens ?? 0) >= 8)
  assert.equal(result.final, 'Added the note.')
})

test('prompt caching: a cacheable system message + an OpenAI cache key; off → plain string', async () => {
  const route = (info: CallInfo): Reply =>
    stageOf(info) === 'planner' ? { text: plan(['Do it']) } : { text: 'ok' }
  const on = scriptedModel(route)
  await (await createAgent({ model: on.model, clientName: 'app' })).run('do it now please')
  const prompt = on.calls[0].options.prompt as { role: string; providerOptions?: unknown }[]
  assert.equal(prompt[0].role, 'system')
  assert.deepEqual(prompt[0].providerOptions, {
    anthropic: { cacheControl: { type: 'ephemeral' } },
  })
  assert.deepEqual(on.calls[0].options.providerOptions, {
    openai: { promptCacheKey: 'app:planner' },
  })

  const off = scriptedModel(route)
  await (await createAgent({ model: off.model, promptCaching: false })).run('do it now please')
  const plain = off.calls[0].options.prompt as { role: string; providerOptions?: unknown }[]
  assert.equal(plain[0].providerOptions, undefined)
  assert.equal(off.calls[0].options.providerOptions, undefined)
})

test('approval ask-writes: a write tool asks and a denial blocks it; read-only tools run freely', async () => {
  const { model } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['List then add']) }
      case 'executor':
        return executorReply(info, [
          { name: 'list_notes', args: {} },
          { name: 'add_note', args: { text: 'x' } },
        ])
      case 'replanner':
        return { text: JSON.stringify({ decision: 'finish', reason: 'denied' }) }
      default:
        return { text: 'Could not add the note: the user said no.' }
    }
  })
  const log: string[] = []
  const requests: string[] = []
  const agent = await createAgent({
    model,
    tools: noteTools(log),
    toolApproval: {
      mode: 'ask-writes',
      onRequest: (req) => {
        requests.push(req.toolName)
        return { approved: false, reason: 'not now' }
      },
    },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('list and add a note', { onEvent })
  assert.deepEqual(log, ['list'])
  assert.deepEqual(requests, ['add_note'])
  const failed = result.trace[0].toolCalls.find((c) => c.name === 'add_note')
  assert.equal(failed?.ok, false)
  assert.match(String(failed?.output), /denied by the user: not now/)
  assert.ok(events.some((e) => e.type === 'tool.approval-requested' && e.name === 'add_note'))
  assert.ok(
    events.some(
      (e) => e.type === 'tool.approval-resolved' && e.approved === false && e.automatic === false,
    ),
  )
})

test('approval: "always allow" is remembered and setToolApprovalMode switches policy live', async () => {
  const { model } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Add']) }
      case 'executor':
        return executorReply(info, [{ name: 'add_note', args: { text: 'a' } }])
      default:
        return { text: 'ok' }
    }
  })
  const log: string[] = []
  let asked = 0
  const agent = await createAgent({
    model,
    tools: noteTools(log),
    toolApproval: {
      mode: 'ask-all',
      onRequest: () => {
        asked += 1
        return { approved: true, remember: true }
      },
    },
  })
  await agent.run('add a note please')
  await agent.run('add a note please')
  assert.equal(asked, 1)
  assert.equal(log.length, 2)

  agent.setToolApprovalMode('read-only')
  assert.equal(agent.toolApprovalMode, 'read-only')
  // Remembered approvals still win over the mode.
  await agent.run('add a note please')
  assert.equal(log.length, 3)
  assert.throws(() => agent.setToolApprovalMode('nope' as never), /unknown tool approval mode/)
})

test('approval read-only: writes are refused without asking anyone', async () => {
  const { model } = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['Add']) }
      : stageOf(info) === 'executor'
        ? executorReply(info, [{ name: 'add_note', args: { text: 'a' } }])
        : { text: JSON.stringify({ decision: 'finish', reason: 'blocked' }) },
  )
  const log: string[] = []
  const agent = await createAgent({
    model,
    tools: noteTools(log),
    toolApproval: { mode: 'read-only', onRequest: () => assert.fail('must not ask') },
  })
  const { events, onEvent } = collect()
  await agent.run('add a note please', { onEvent })
  assert.deepEqual(log, [])
  const resolved = events.find((e) => e.type === 'tool.approval-resolved')
  assert.equal(resolved?.type === 'tool.approval-resolved' && resolved.automatic, true)
})

test('token limits: a crossed cap stops executing, emits budget.exceeded, and still answers', async () => {
  const { model } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['one', 'two', 'three']), usage: { input: 40, output: 10 } }
      case 'executor':
        return { text: 'step done', usage: { input: 40, output: 10 } }
      default:
        return { text: 'Partial answer.' }
    }
  })
  const agent = await createAgent({ model, limits: { maxTotalTokens: 90 } })
  const { events, onEvent } = collect()
  const result = await agent.run('do three things', { onEvent })
  assert.equal(result.trace.length, 1)
  assert.deepEqual(result.budgetExceeded, { kind: 'total', tokens: 100, cap: 90 })
  assert.ok(events.some((e) => e.type === 'budget.exceeded'))
  assert.equal(result.final, 'Partial answer.')
})

test('maxToolCalls: calls beyond the budget fail with a clear error', async () => {
  const { model } = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['Add two']) }
      : stageOf(info) === 'executor'
        ? executorReply(info, [
            { name: 'add_note', args: { text: 'a' } },
            { name: 'add_note', args: { text: 'b' } },
          ])
        : { text: 'ok' },
  )
  const log: string[] = []
  const agent = await createAgent({ model, tools: noteTools(log), maxToolCalls: 1, replan: false })
  const result = await agent.run('add two notes')
  assert.equal(log.length, 1)
  const failed = result.trace[0].toolCalls.find((c) => !c.ok)
  assert.match(String(failed?.output), /Tool-call budget exhausted/)
})

test('skills: a planner-picked skill is activated; load_skill activates another on demand', async () => {
  const { model, calls } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Write it'], { skills: ['tone', 'ghost'] }) }
      case 'executor':
        return executorReply(info, [{ name: 'load_skill', args: { name: 'format' } }])
      default:
        return { text: 'Written.' }
    }
  })
  const agent = await createAgent({
    model,
    skills: [
      { name: 'tone', description: 'Friendly tone', content: 'ALWAYS-BE-FRIENDLY' },
      { name: 'format', description: 'Output format', content: 'USE-BULLETS' },
    ],
  })
  const { events, onEvent } = collect()
  const result = await agent.run('write a friendly note', { onEvent })
  const activated = events.filter((e) => e.type === 'skill.activated')
  assert.deepEqual(
    activated.map((e) => (e.type === 'skill.activated' ? `${e.name}:${e.by}` : '')),
    ['tone:plan', 'format:tool'],
  )
  assert.deepEqual(result.skills, ['tone', 'format'])
  const planner = calls.find((c) => stageOf(c) === 'planner')!
  assert.match(planner.system, /SKILLS:\n- tone: Friendly tone/)
  const executor = calls.find((c) => stageOf(c) === 'executor')!
  assert.match(executor.system, /ALWAYS-BE-FRIENDLY/)
  const synth = calls.find((c) => stageOf(c) === 'synthesizer')!
  assert.match(synth.system, /USE-BULLETS/)
})

test('tool search: a large catalogue starts small and find_tools activates the tool next step', async () => {
  const hit: string[] = []
  const tools = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [
      `srv${i % 3}__tool_${i}`,
      defineTool({
        description: i === 42 ? 'Send an invoice to a customer' : `Generic operation number ${i}`,
        inputSchema: z.object({}),
        execute: async () => {
          hit.push(`tool_${i}`)
          return 'sent'
        },
      }),
    ]),
  )
  const offered: string[][] = []
  const { model, calls } = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Send the invoice']) }
      case 'executor':
        offered.push(info.tools)
        if (info.toolResults === 0)
          return { toolCalls: [{ name: 'find_tools', args: { query: 'invoice' } }] }
        if (info.toolResults === 1) return { toolCalls: [{ name: 'srv0__tool_42', args: {} }] }
        return { text: 'Invoice sent.' }
      default:
        return { text: 'Sent.' }
    }
  })
  const agent = await createAgent({ model, tools })
  assert.equal(agent.toolStrategy, 'search')
  const { events, onEvent } = collect()
  await agent.run('send the invoice', { onEvent })
  assert.deepEqual(hit, ['tool_42'])
  assert.deepEqual(offered[0], ['find_tools'])
  assert.ok(offered[1].includes('srv0__tool_42'))
  const discovered = events.find((e) => e.type === 'tools.discovered')
  assert.ok(discovered?.type === 'tools.discovered' && discovered.names.includes('srv0__tool_42'))
  const planner = calls.find((c) => stageOf(c) === 'planner')!
  assert.match(planner.system, /\[srv0\] 20 tool\(s\)/)
})

test('tool search (prompted): discovered tools are listed and dispatchable in the next round', async () => {
  const hit: string[] = []
  const tools = Object.fromEntries(
    Array.from({ length: 45 }, (_, i) => [
      `t${i}`,
      defineTool({
        description: i === 7 ? 'Book a meeting room' : `Other ${i}`,
        inputSchema: z.object({ room: z.string().optional() }),
        execute: async () => {
          hit.push(`t${i}`)
          return 'booked'
        },
      }),
    ]),
  )
  const executorPrompts: string[] = []
  const { model } = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: JSON.stringify({ reply: 'ok', plan: ['Book'] }) }
    if (stage === 'executor') {
      const last = JSON.stringify(info.options.prompt)
      executorPrompts.push(last)
      const round = (info.options.prompt as { role: string }[]).filter(
        (m) => m.role === 'user',
      ).length
      if (round === 1) {
        return {
          text: JSON.stringify({
            reply: 'searching',
            actions: [{ tool: 'find_tools', args: { query: 'meeting room' } }],
          }),
        }
      }
      if (round === 2) {
        return {
          text: JSON.stringify({
            reply: 'booking',
            actions: [{ tool: 't7', args: { room: 'A' } }],
          }),
        }
      }
      return { text: JSON.stringify({ reply: 'Booked room A.', actions: [] }) }
    }
    return { text: 'Booked.' }
  })
  const agent = await createAgent({ model, tools, toolMode: 'prompted' })
  await agent.run('book a meeting room')
  assert.deepEqual(hit, ['t7'])
  assert.match(executorPrompts[1], /TOOLS NOW AVAILABLE/)
  assert.match(executorPrompts[1], /t7\(\{ room\?: string \}\)/)
})

test('compaction: agent.compact summarises the stored transcript', async () => {
  const { model } = scriptedModel(() => ({ text: 'SUMMARY-OF-EVERYTHING' }))
  const memory = new MemoryStore()
  for (let i = 0; i < 10; i += 1) {
    await memory.append('s', {
      role: i % 2 ? 'assistant' : 'user',
      content: `message ${i} `.repeat(50),
    })
  }
  const agent = await createAgent({
    model,
    memory,
    sessionId: 's',
    compaction: { keepRecentTurns: 2 },
  })
  const out = await agent.compact()
  assert.equal(out.compacted, true)
  assert.ok(out.afterTokens < out.beforeTokens)
  const after = await memory.load('s')
  assert.equal(after.length, 3)
  assert.match(after[0].content, /SUMMARY-OF-EVERYTHING/)
  assert.equal((await (await createAgent({ model })).compact()).compacted, false)
})

test('compaction: a long step log is folded into a summary between steps', async () => {
  const { model, calls } = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['a', 'b', 'c', 'd']) }
    if (stage === 'executor') return { text: `result ${'z'.repeat(400)}` }
    if (stage === 'synthesizer') return { text: 'All done.' }
    return { text: 'STEPS-SUMMARY' }
  })
  const agent = await createAgent({
    model,
    compaction: { thresholdTokens: 150, keepRecentSteps: 1 },
  })
  const { events, onEvent } = collect()
  await agent.run('do four things', { onEvent })
  assert.ok(events.some((e) => e.type === 'context.compacted' && e.scope === 'trace'))
  assert.ok(events.some((e) => e.type === 'usage' && e.phase === 'compact'))
  const synth = calls.find((c) => stageOf(c) === 'synthesizer')!
  assert.match(synth.user, /Summary of \d+ earlier step\(s\): STEPS-SUMMARY/)
})

test('step results flow into later steps and the answer (with tool findings)', async () => {
  const { model, calls } = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['Find the id', 'Use it']) }
    if (stage === 'executor') {
      if (info.user.includes('STEP 1/2')) {
        return executorReply(info, [{ name: 'list_notes', args: {} }], 'Found note id 4711.')
      }
      return { text: 'Used it.' }
    }
    return { text: 'The id is 4711.' }
  })
  const agent = await createAgent({ model, tools: noteTools([]) })
  await agent.run('find and use the id')
  const step2 = calls
    .filter((c) => stageOf(c) === 'executor')
    .find((c) => c.user.includes('STEP 2/2'))!
  assert.match(step2.user, /Found note id 4711/)
  const synth = calls.find((c) => stageOf(c) === 'synthesizer')!
  assert.match(synth.user, /FINDINGS \(tool results\):\n- list_notes: \{"notes":\[\]\}/)
})

// ── subagents ───────────────────────────────────────────────────────────────

test('subagent (in-process): the child runs the task and its usage is charged to the parent', async () => {
  const child = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['Research']) }
      : stageOf(info) === 'executor'
        ? { text: 'researched' }
        : { text: 'CHILD-ANSWER' },
  )
  const parent = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['Delegate']) }
    if (stage === 'executor') {
      return executorReply(info, [{ name: 'research', args: { task: 'look it up' } }], 'Delegated.')
    }
    return { text: 'Parent answer.' }
  })
  const agent = await createAgent({
    model: parent.model,
    tools: {
      research: createSubagentTool({
        name: 'researcher',
        description: 'Research a question',
        config: { model: child.model },
      }),
    },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('research something', { onEvent })
  const call = result.trace[0].toolCalls[0]
  assert.equal(call.ok, true)
  assert.equal(call.output, 'CHILD-ANSWER')
  assert.ok(events.some((e) => e.type === 'subagent.start' && e.task === 'look it up'))
  assert.ok(events.some((e) => e.type === 'subagent.event' && e.event.type === 'plan.created'))
  assert.ok(events.some((e) => e.type === 'usage' && e.phase === 'subagent'))
  const complete = events.find((e) => e.type === 'subagent.complete')
  assert.ok(complete?.type === 'subagent.complete' && complete.usage.totalTokens > 0)
})

test('subagent (worker): runs behind a message channel, calls a proxied host tool through the parent gate', async () => {
  const childModel = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['Use host tool']) }
    if (stage === 'executor')
      return executorReply(info, [{ name: 'add_note', args: { text: 'from-worker' } }])
    return { text: 'WORKER-DONE' }
  })
  const opened: MessagePort[] = []
  const makeWorker = () => {
    const channel = new MessageChannel()
    opened.push(channel.port1, channel.port2)
    serveSubagentWorker({ scope: channel.port2, resolveModel: () => childModel.model })
    channel.port1.start()
    channel.port2.start()
    return Object.assign(channel.port1, {
      terminate: () => {
        channel.port1.close()
        channel.port2.close()
      },
    })
  }
  const log: string[] = []
  const parent = scriptedModel((info) => {
    const stage = stageOf(info)
    if (stage === 'planner') return { text: plan(['Delegate']) }
    if (stage === 'executor')
      return executorReply(info, [{ name: 'worker', args: { task: 'add a note' } }])
    return { text: 'ok' }
  })
  const asked: string[] = []
  const agent = await createAgent({
    model: parent.model,
    tools: {
      worker: createSubagentTool({
        name: 'w',
        description: 'Delegate to a worker',
        worker: makeWorker,
        workerConfig: { model: { providerType: 'openai', model: 'x', apiKey: 'k' } },
        tools: { add_note: noteTools(log).add_note },
      }),
    },
    toolApproval: {
      mode: 'ask-writes',
      onRequest: (req) => {
        asked.push(req.toolName)
        return true
      },
    },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('delegate a note', { onEvent })
  assert.equal(result.trace[0].toolCalls[0].output, 'WORKER-DONE')
  assert.deepEqual(log, ['add:from-worker'])
  // The parent gate saw both the delegation and the host tool the child called.
  assert.deepEqual(asked, ['worker', 'add_note'])
  assert.ok(events.some((e) => e.type === 'subagent.event' && e.event.type === 'step.tool-call'))
  for (const p of opened) p.close()
})
