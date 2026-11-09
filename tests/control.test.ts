import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  createAgent,
  createRunControl,
  createSubagentTool,
  defineTool,
  MemoryRunStore,
  MemoryStore,
  type AgentEvent,
  type RunControl,
  type RunPersistence,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Steering a run that is already going. What matters is what the MODEL is shown and when —
// so these tests read the model's call log (the messages of each call), not the final text:
// a run that quietly ignored the message would still end with a fine-looking answer.

const plan = (steps: string[]) =>
  JSON.stringify({ thought: 'plan', steps: steps.map((description) => ({ description })) })
const replan = (decision: 'continue' | 'revise' | 'finish', steps: string[] = []) =>
  JSON.stringify({
    decision,
    reason: `because ${decision}`,
    ...(steps.length ? { plan: steps } : {}),
  })

type Msg = { role: string; content: string | { type: string; text?: string }[] }
const messagesOf = (info: CallInfo): Msg[] => (info.options.prompt ?? []) as Msg[]
const textOf = (m: Msg): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => (p.type === 'text' ? (p.text ?? '') : `<${p.type}>`)).join('')
/** Roles of the conversation as the model sees it, system left out. */
const shape = (info: CallInfo): string[] =>
  messagesOf(info)
    .filter((m) => m.role !== 'system')
    .map((m) => m.role)
const MID_STEP = 'NEW MESSAGE FROM THE USER'
/** How many user turns carry the mid-step message. */
const injected = (info: CallInfo): number =>
  messagesOf(info).filter((m) => m.role === 'user' && textOf(m).includes(MID_STEP)).length
const stepOf = (info: CallInfo): string => /STEP \d+\/\d+: ([^\n]+)/.exec(info.user)?.[1] ?? '?'
const at = (calls: CallInfo[], stage: string): CallInfo[] =>
  calls.filter((c) => stageOf(c) === stage)

const collect = () => {
  const events: AgentEvent[] = []
  return { events, onEvent: (e: AgentEvent) => events.push(e) }
}
const types = (events: AgentEvent[]): string[] => events.map((e) => e.type)

/** A tool that, when called, says something to the run — the user typing during a long call. */
const speakingTool = (control: RunControl, ...said: string[]) =>
  defineTool({
    description: 'Fetch a thing',
    inputSchema: z.object({}),
    execute: async () => {
      for (const text of said) control.send(text)
      return { ok: true }
    },
  })

// ── the handle itself ────────────────────────────────────────────────────────

test('control: refuses what cannot be delivered, keeps order, announces on attach', () => {
  const c = createRunControl()
  assert.equal(c.send(''), false)
  assert.equal(c.send('   \n'), false)
  assert.equal(c.send(undefined as never), false)
  assert.equal(c.send('  first  '), true, 'trimmed')
  assert.equal(c.send('second'), true)
  assert.deepEqual(c.pending(), ['first', 'second'])
  assert.deepEqual(c.subagents(), [])
  assert.equal(c.stopSubagent('nope'), false, 'nothing by that id is running')
})

test('control: a hand-made object is refused loudly, before anything is spent', async () => {
  const { model, calls } = scriptedModel(() => ({ text: plan(['x']) }))
  const agent = await createAgent({ model })
  const fake = {
    send: () => true,
    pending: () => [],
    subagents: () => [],
    stopSubagent: () => false,
  }
  await assert.rejects(agent.run('go', { control: fake }), /createRunControl/)
  assert.equal(calls.length, 0, 'no model call was made')
})

// ── delivery inside a step ───────────────────────────────────────────────────

test('control: a message sent during a tool call reaches the model on its next round, once', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Fetch the report']) }
      case 'executor':
        // Round 1 calls the tool, round 2 calls it again, round 3 answers.
        return info.toolResults < 2
          ? { toolCalls: [{ name: 'fetch', args: {} }] }
          : { text: 'fetched' }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'Report fetched.' }
    }
  })
  let spoke = false
  const fetch = defineTool({
    description: 'Fetch',
    inputSchema: z.object({}),
    execute: async () => {
      if (!spoke) {
        spoke = true
        control.send('use the staging database')
      }
      return { ok: true }
    },
  })
  const agent = await createAgent({ model: model.model, tools: { fetch } })
  const { events, onEvent } = collect()
  const result = await agent.run('get the report', { control, onEvent })

  const exec = at(model.calls, 'executor')
  assert.equal(exec.length, 3)
  assert.equal(injected(exec[0]), 0, 'round 1 was made before anyone spoke')
  assert.equal(injected(exec[1]), 1, 'round 2 is the first call after the tool ran')
  assert.equal(injected(exec[2]), 1, 'round 3 still has it — and once, not again')
  // After the tool result, as its own turn: the order providers need (tool_result first).
  assert.deepEqual(shape(exec[1]), ['user', 'assistant', 'tool', 'user'])
  assert.match(textOf(messagesOf(exec[1]).at(-1) as Msg), /use the staging database/)

  // Told to the model, and from then on part of the run's story.
  assert.deepEqual(
    events
      .filter((e) => e.type.startsWith('message.'))
      .map((e) => [e.type, (e as never as { at?: string }).at]),
    [
      ['message.queued', undefined],
      ['message.delivered', 'round'],
    ],
  )
  const ordered = types(events)
  assert.ok(ordered.indexOf('message.queued') < ordered.indexOf('message.delivered'))
  assert.deepEqual(result.undelivered, [])
  // The step ended with the message unweighed: the replanner looks at the plan against it.
  const replanner = at(model.calls, 'replanner')
  assert.equal(replanner.length, 1, 'a message forces the replanner even when no step failed')
  assert.match(replanner[0].user, /MESSAGES FROM THE USER/)
  assert.match(replanner[0].user, /use the staging database\s+\[NEW/)
})

test('control: a step that ends without another round still hands the message to the replanner', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Gather', 'Report']) }
      case 'executor':
        return { text: `did ${stepOf(info)}` }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'done' }
    }
  })
  const agent = await createAgent({ model: model.model })
  const { events, onEvent } = collect()
  const result = await agent.run('go', {
    control,
    onEvent: (e) => {
      onEvent(e)
      // The user types while step one is finishing.
      if (e.type === 'step.complete' && e.step.description === 'Gather')
        control.send('skip the report')
    },
  })

  const delivered = events.find((e) => e.type === 'message.delivered')
  assert.ok(delivered?.type === 'message.delivered')
  assert.equal(delivered.at, 'step')
  const decision = events.find((e) => e.type === 'replan.decision')
  assert.ok(decision?.type === 'replan.decision')
  assert.equal(decision.byUser, true, 'the event says why the replanner ran')
  // Step two's executor knows what the user said, though the replanner chose to continue.
  const second = at(model.calls, 'executor')[1]
  assert.match(second.user, /MESSAGES FROM THE USER/)
  assert.match(second.user, /skip the report/)
  assert.equal(result.steps, 2)
})

test('control: a message can revise the plan; it ignores replan:false and maxRevisions and is not counted', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Gather', 'Report']) }
      case 'executor':
        return { text: `did ${stepOf(info)}` }
      case 'replanner':
        // The first look (the user's message) revises; any other look continues.
        return {
          text: info.user.includes('use metric')
            ? replan('revise', ['Report in metric'])
            : replan('continue'),
        }
      default:
        return { text: 'done' }
    }
  })
  const agent = await createAgent({ model: model.model, replan: false, maxRevisions: 0 })
  const { events, onEvent } = collect()
  await agent.run('go', {
    control,
    onEvent: (e) => {
      onEvent(e)
      if (e.type === 'step.complete' && e.step.description === 'Gather') control.send('use metric')
    },
  })
  const revised = events.find((e) => e.type === 'plan.revised')
  assert.ok(
    revised?.type === 'plan.revised',
    'the plan was revised though revising was switched off',
  )
  assert.deepEqual(
    at(model.calls, 'executor').map(stepOf),
    ['Gather', 'Report in metric'],
    'the revised step ran, the old one did not',
  )
})

test('control: a revise forced by a message does not use up maxRevisions', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['One', 'Two', 'Three']) }
      case 'executor':
        // The second step cannot be done: that is what the failure rule replans on.
        return { text: stepOf(info) === 'Two' ? 'cannot [BLOCKER]' : `did ${stepOf(info)}` }
      case 'replanner':
        return {
          // The first look is the one with the NEW message; the second is the failure rule's.
          text: info.user.includes('[NEW —')
            ? replan('revise', ['Two'])
            : replan('revise', ['Two, another way']),
        }
      default:
        return { text: 'done' }
    }
  })
  // One revision allowed in all. The user's message takes none of it.
  const agent = await createAgent({ model: model.model, maxRevisions: 1 })
  await agent.run('go', {
    control,
    onEvent: (e) => {
      if (e.type === 'step.complete' && e.step.description === 'One') control.send('use metric')
    },
  })
  assert.deepEqual(
    at(model.calls, 'executor').map(stepOf),
    ['One', 'Two', 'Two, another way'],
    'the failure after the user-forced revise was still allowed its own revision',
  )
})

test('control: messages are weighed once; a second step boundary does not re-ask', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['One', 'Two', 'Three']) }
      case 'executor':
        return { text: `did ${stepOf(info)}` }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'done' }
    }
  })
  const agent = await createAgent({ model: model.model, replan: false })
  await agent.run('go', {
    control,
    onEvent: (e) => {
      if (e.type === 'step.complete' && e.step.description === 'One') control.send('careful')
    },
  })
  assert.equal(at(model.calls, 'replanner').length, 1, 'one look for one message, not one per step')
  // …but every later step still sees it, and so does the answer.
  assert.ok(at(model.calls, 'executor')[2].user.includes('careful'))
  assert.ok(at(model.calls, 'synthesizer')[0].user.includes('careful'))
})

test('control: a message that says stop lets the replanner finish the run early', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['One', 'Two', 'Three']) }
      case 'executor':
        return { text: `did ${stepOf(info)}` }
      case 'replanner':
        return { text: replan('finish') }
      default:
        return { text: 'Stopped early, as asked.' }
    }
  })
  const agent = await createAgent({ model: model.model })
  const result = await agent.run('go', {
    control,
    onEvent: (e) => {
      if (e.type === 'step.complete' && e.step.description === 'One')
        control.send('stop, that is enough')
    },
  })
  assert.deepEqual(at(model.calls, 'executor').map(stepOf), ['One'])
  assert.equal(result.final, 'Stopped early, as asked.')
})

// ── delivery at the end ──────────────────────────────────────────────────────

test('control: a message that arrives after the last step boundary is shown to the synthesizer', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Only step']) }
      case 'executor':
        return { text: 'did it' }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'answer' }
    }
  })
  const agent = await createAgent({ model: model.model })
  const { events, onEvent } = collect()
  const result = await agent.run('go', {
    control,
    onEvent: (e) => {
      onEvent(e)
      // One while the step ends (weighed by the replanner), one while the replanner thinks —
      // too late for the boundary, in time for the answer.
      if (e.type === 'step.complete') control.send('first')
      if (e.type === 'replan.decision') control.send('second')
    },
  })
  const replanner = at(model.calls, 'replanner')[0]
  assert.ok(replanner.user.includes('first'))
  assert.ok(!replanner.user.includes('second'), 'the replanner had already started')
  const synth = at(model.calls, 'synthesizer')[0]
  assert.match(synth.user, /1\. first\n2\. second/, 'both, in order, in the answer prompt')
  assert.ok(!synth.user.includes('[NEW'), 'the answer prompt does not talk about a plan')
  assert.deepEqual(
    events
      .filter((e) => e.type === 'message.delivered')
      .map((e) => (e as never as { at: string }).at),
    ['step', 'final'],
  )
  assert.deepEqual(result.undelivered, [])
})

test('control: a message sent while the answer streams comes back as undelivered, never shown', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Only step']) }
      case 'executor':
        return { text: 'did it' }
      default:
        return { text: 'answer' }
    }
  })
  const agent = await createAgent({ model: model.model })
  const { events, onEvent } = collect()
  const result = await agent.run('go', {
    control,
    onEvent: (e) => {
      onEvent(e)
      if (e.type === 'final.text-delta') control.send('also, one more thing')
    },
  })
  assert.deepEqual(result.undelivered, ['also, one more thing'])
  assert.ok(
    !model.calls.some((c) => c.options && JSON.stringify(c.options).includes('one more thing')),
    'no model call ever saw it',
  )
  assert.equal(events.filter((e) => e.type === 'message.delivered').length, 0)
  assert.equal(
    events.filter((e) => e.type === 'message.queued').length,
    1,
    'it was announced as queued',
  )
  assert.equal(control.send('too late'), false, 'the run is over: nothing to deliver to')
  assert.deepEqual(
    control.pending(),
    ['also, one more thing'],
    'still readable afterwards, for a run that threw and could not return it',
  )
})

// ── around the edges ─────────────────────────────────────────────────────────

test('control: what was said before the run started is announced when it starts, in order', async () => {
  const control = createRunControl()
  assert.equal(control.send('before one'), true)
  assert.equal(control.send('before two'), true)
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['A', 'B']) }
      : stageOf(info) === 'replanner'
        ? { text: replan('continue') }
        : { text: `ok ${stepOf(info)}` },
  )
  const agent = await createAgent({ model: model.model })
  const { events, onEvent } = collect()
  await agent.run('go', { control, onEvent })
  const queued = events.filter((e) => e.type === 'message.queued')
  assert.deepEqual(
    queued.map((e) => (e as never as { text: string }).text),
    ['before one', 'before two'],
  )
  assert.ok(types(events).indexOf('run.start') < types(events).indexOf('message.queued'))
  assert.equal(
    injected(at(model.calls, 'executor')[0]),
    0,
    'not into the first call of a step: the boundary handles it',
  )
  // Delivered at the first boundary, together: one replanner look for both.
  assert.equal(at(model.calls, 'replanner').length, 1)
  assert.match(
    at(model.calls, 'replanner')[0].user,
    /1\. before one[^\n]*\[NEW[^\n]*\n2\. before two[^\n]*\[NEW/,
  )
})

test('control: prompted mode gets the message in the results turn of the same step', async () => {
  const control = createRunControl()
  const calls: string[] = []
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: JSON.stringify({ reply: 'plan', plan: ['Fetch it'] }) }
      case 'executor': {
        calls.push(info.user)
        return info.user.includes('TOOL RESULTS')
          ? { text: JSON.stringify({ reply: 'fetched', actions: [] }) }
          : { text: JSON.stringify({ reply: 'fetching', actions: [{ tool: 'fetch', args: {} }] }) }
      }
      case 'replanner':
        return { text: JSON.stringify({ decision: 'continue', reason: 'fits' }) }
      default:
        return { text: 'done' }
    }
  })
  const agent = await createAgent({
    model: model.model,
    toolMode: 'prompted',
    tools: { fetch: speakingTool(control, 'only the last quarter') },
  })
  await agent.run('get it', { control })

  const exec = at(model.calls, 'executor')
  assert.equal(exec.length, 2)
  assert.equal(injected(exec[0]), 0)
  assert.equal(injected(exec[1]), 1)
  const second = textOf(messagesOf(exec[1]).at(-1) as Msg)
  // In the turn that carries the tool results, before the "continue" contract.
  assert.ok(second.indexOf('TOOL RESULTS') < second.indexOf(MID_STEP))
  assert.ok(second.indexOf(MID_STEP) < second.indexOf('Continue THIS step'))
  assert.match(second, /only the last quarter/)
})

test('control: the session transcript keeps what the user said, in the order it was said', async () => {
  const control = createRunControl()
  const memory = new MemoryStore()
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['A']) }
      : stageOf(info) === 'replanner'
        ? { text: replan('continue') }
        : { text: 'ok' },
  )
  const agent = await createAgent({ model: model.model, memory })
  await agent.run('start', {
    control,
    onEvent: (e) => {
      if (e.type === 'step.complete') control.send('mid-run note')
    },
  })
  assert.deepEqual(
    (await memory.load('default')).map((m) => `${m.role}: ${m.content}`),
    ['user: start', 'user: mid-run note', 'assistant: ok'],
  )
})

test('control: a control that served a run starts the next one clean', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner' ? { text: plan(['A']) } : { text: 'ok' },
  )
  const agent = await createAgent({ model: model.model })
  const first = await agent.run('one', {
    control,
    onEvent: (e) => {
      if (e.type === 'final.text-delta') control.send('left over')
    },
  })
  assert.deepEqual(first.undelivered, ['left over'])

  const { events, onEvent } = collect()
  const second = await agent.run('two', { control, onEvent })
  assert.deepEqual(second.undelivered, [], 'the leftover was handed back once, not carried over')
  assert.ok(!types(events).includes('message.queued'), 'and not announced for the new run')
  assert.deepEqual(control.pending(), [])
})

test('control: a stopped run hands back what it never showed the model', async () => {
  const control = createRunControl()
  const abort = new AbortController()
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner' ? { text: plan(['A', 'B']) } : { text: 'ok' },
  )
  const agent = await createAgent({ model: model.model })
  const result = await agent.run('go', {
    control,
    signal: abort.signal,
    onEvent: (e) => {
      if (e.type === 'plan.created') {
        control.send('sent just before the stop')
        abort.abort()
      }
    },
  })
  assert.equal(result.stopped, true)
  assert.deepEqual(result.undelivered, ['sent just before the stop'])
})

test('control: with no step left to plan, the message still reaches the answer — and no replanner runs', async () => {
  const control = createRunControl()
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['A', 'B']) }
      : stageOf(info) === 'replanner'
        ? { text: replan('revise', ['C']) }
        : { text: 'ok' },
  )
  const agent = await createAgent({ model: model.model, maxIterations: 1 })
  const { events, onEvent } = collect()
  const result = await agent.run('go', {
    control,
    onEvent: (e) => {
      onEvent(e)
      if (e.type === 'step.complete') control.send('and mind the budget')
    },
  })
  assert.equal(at(model.calls, 'replanner').length, 0, 'a revised plan could not run anyway')
  assert.match(at(model.calls, 'synthesizer')[0].user, /and mind the budget/)
  assert.equal(events.filter((e) => e.type === 'message.delivered').length, 1)
  assert.deepEqual(result.undelivered, [])
})

test('control: a run without a control behaves exactly as before — no extra calls, events or prompt text', async () => {
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['A', 'B']) }
      : stageOf(info) === 'replanner'
        ? { text: replan('continue') }
        : { text: 'ok' },
  )
  // 'always' puts the replanner and the synthesizer prompts in play too.
  const agent = await createAgent({ model: model.model, replanAfter: 'always' })
  const { events, onEvent } = collect()
  const result = await agent.run('go', { onEvent })
  assert.equal(result.undelivered, undefined)
  assert.ok(!types(events).some((t) => t.startsWith('message.')))
  assert.deepEqual(model.calls.map(stageOf), [
    'planner',
    'executor',
    'replanner',
    'executor',
    'replanner',
    'synthesizer',
  ])
  for (const call of model.calls) {
    const sent = messagesOf(call).map(textOf).join('\n')
    assert.doesNotMatch(
      sent,
      /MESSAGES? FROM THE USER|\[NEW/,
      `${stageOf(call)} prompt is untouched`,
    )
  }
})

// ── persistence ──────────────────────────────────────────────────────────────

test('control: what the user said survives a crash — and the resumed run still knows it', async () => {
  const control = createRunControl()
  const store = new MemoryRunStore()
  const abort = new AbortController()
  const persistence: RunPersistence = {
    onRunStart: (s) => store.onRunStart?.(s),
    onStepComplete: async (s) => {
      await store.onStepComplete?.(s)
      if (s.trace.length === 1) abort.abort()
    },
    loadRun: (id) => store.loadRun?.(id) ?? null,
  }
  const model = scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['One', 'Two']) }
      case 'executor':
        return { text: `did ${stepOf(info)}` }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'done' }
    }
  })
  const first = await createAgent({ model: model.model, persistence })
  const r1 = await first.run('go', {
    control,
    signal: abort.signal,
    onEvent: (e) => {
      if (e.type === 'step.complete') control.send('keep it short')
    },
  })
  const saved = store.loadRun(r1.runId)
  assert.deepEqual(saved?.userUpdates, [{ text: 'keep it short', reconciled: true }])

  const second = await createAgent({ model: model.model, persistence: store })
  await second.run('', { resumeFromRunId: r1.runId })
  assert.match(at(model.calls, 'executor').at(-1)?.user ?? '', /keep it short/)
  assert.match(at(model.calls, 'synthesizer')[0].user, /keep it short/)
})

// ── subagents ────────────────────────────────────────────────────────────────

/** A child that never finishes on its own: its one tool waits for the abort. */
const hangingChild = () => {
  const hang = defineTool({
    description: 'Wait',
    inputSchema: z.object({}),
    execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) =>
      new Promise((resolve) => {
        if (options.abortSignal?.aborted) return resolve('aborted')
        options.abortSignal?.addEventListener('abort', () => resolve('aborted'), { once: true })
      }),
  })
  const model = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['Wait forever']) }
      : stageOf(info) === 'executor'
        ? info.toolResults === 0
          ? { toolCalls: [{ name: 'hang', args: {} }] }
          : { text: 'gave up' }
        : { text: 'CHILD-ANSWER' },
  )
  return { model: model.model, tools: { hang } }
}

/** A parent that, in one round, delegates to each named tool (the task is the tool's own word). */
const delegatingTo = (...tools: string[]) =>
  scriptedModel((info) => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Delegate']) }
      case 'executor':
        return info.toolResults === 0
          ? {
              toolCalls: tools.map((name) => ({
                name,
                args: { task: name.replace(/_agent$/, '') },
              })),
            }
          : { text: 'delegated' }
      case 'replanner':
        return { text: replan('continue') }
      default:
        return { text: 'Parent answer.' }
    }
  })

test('control: the host sees which subagents run, stops ONE, and the parent carries on', async () => {
  const control = createRunControl()
  const parent = delegatingTo('slow_agent', 'quick_agent')
  const slow = hangingChild()
  const quick = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: plan(['Answer']) }
      : stageOf(info) === 'executor'
        ? { text: 'quick result' }
        : { text: 'QUICK-ANSWER' },
  )
  const agent = await createAgent({
    model: parent.model,
    tools: {
      slow_agent: createSubagentTool({
        name: 'slow_agent',
        description: 'Takes long',
        config: { model: slow.model, tools: slow.tools },
      }),
      quick_agent: createSubagentTool({
        name: 'quick_agent',
        description: 'Takes no time',
        config: { model: quick.model },
      }),
    },
  })
  const { events, onEvent } = collect()
  let listed: ReturnType<RunControl['subagents']> = []
  let stopped: boolean | undefined
  let afterStep: ReturnType<RunControl['subagents']> | undefined
  const result = await agent.run('delegate two things', {
    control,
    onEvent: (e) => {
      onEvent(e)
      // Both children are done by the time the step is: neither is still listed.
      if (e.type === 'step.complete') afterStep = control.subagents()
      // The slow child is mid-task once it has called its tool.
      if (
        e.type === 'subagent.event' &&
        e.name === 'slow_agent' &&
        e.event.type === 'step.tool-call'
      ) {
        listed = control.subagents()
        const slowOne = listed.find((s) => s.name === 'slow_agent')
        stopped = slowOne ? control.stopSubagent(slowOne.id) : undefined
      }
    },
  })

  const slowInfo = listed.find((s) => s.name === 'slow_agent')
  assert.ok(slowInfo, 'the running child is listed')
  assert.equal(slowInfo.task, 'slow')
  assert.ok(slowInfo.id && slowInfo.startedAt > 0)
  assert.equal(stopped, true)

  // Only that child failed — with a reason, flagged as the user's doing.
  const err = events.find((e) => e.type === 'subagent.error')
  assert.ok(err?.type === 'subagent.error')
  assert.equal(err.name, 'slow_agent')
  assert.equal(err.id, slowInfo.id)
  assert.equal(err.stopped, true)
  assert.match(err.error, /stopped by the user/)
  assert.ok(events.some((e) => e.type === 'subagent.complete' && e.name === 'quick_agent'))
  assert.equal(events.filter((e) => e.type === 'subagent.error').length, 1)

  // The run was not stopped: the parent got the failure as a tool error it can route around.
  assert.equal(result.stopped, false)
  const calls = result.trace[0].toolCalls
  const bySlow = calls.find((c) => (c.input as { task: string }).task === 'slow')
  const byQuick = calls.find((c) => (c.input as { task: string }).task === 'quick')
  assert.equal(bySlow?.ok, false)
  assert.match(
    String(bySlow?.output instanceof Error ? bySlow.output.message : bySlow?.output),
    /stopped by the user/,
  )
  assert.equal(byQuick?.ok, true)
  assert.equal(byQuick?.output, 'QUICK-ANSWER')
  assert.equal(result.final, 'Parent answer.')
  assert.deepEqual(
    afterStep,
    [],
    'a finished or stopped subagent leaves the list while the run goes on',
  )
  assert.deepEqual(control.subagents(), [], 'nothing is left registered')
  assert.equal(control.stopSubagent(slowInfo.id), false, 'a finished subagent cannot be stopped')
})

/** A worker that never answers; `onRun` fires when it is told to start. */
const silentWorker = (onRun: () => void) => {
  const state = { posted: [] as string[], terminated: false, made: 0 }
  const make = () => {
    state.made += 1
    return {
      postMessage: (msg: { type: string }) => {
        state.posted.push(msg.type)
        if (msg.type === 'run') onRun()
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      terminate: () => {
        state.terminated = true
      },
    } as never
  }
  return { state, make }
}
const workerTool = (make: () => never) =>
  createSubagentTool({
    name: 'w',
    description: 'Worker',
    worker: make,
    workerConfig: { model: { providerType: 'openai', model: 'x', apiKey: 'k' } },
  })

test('control: stopping a worker subagent tells the worker to abort and terminates it', async () => {
  const control = createRunControl()
  const { state, make } = silentWorker(() =>
    setTimeout(() => {
      const [child] = control.subagents()
      control.stopSubagent(child.id)
    }, 0),
  )
  const agent = await createAgent({
    model: delegatingTo('w').model,
    tools: { w: workerTool(make) },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('delegate', { control, onEvent })
  assert.deepEqual(state.posted, ['run', 'abort'])
  assert.equal(state.terminated, true)
  const err = events.find((e) => e.type === 'subagent.error')
  assert.ok(err?.type === 'subagent.error' && err.stopped === true)
  assert.equal(result.stopped, false)
})

test('control: a stop that lands while the worker is still being set up never starts it', async () => {
  const control = createRunControl()
  const { state, make } = silentWorker(() => {})
  const agent = await createAgent({
    model: delegatingTo('w').model,
    tools: { w: workerTool(make) },
  })
  const { events, onEvent } = collect()
  const result = await agent.run('delegate', {
    control,
    onEvent: (e) => {
      onEvent(e)
      // Registered right after the start event; stop on the next tick — before the worker exists.
      if (e.type === 'subagent.start') queueMicrotask(() => control.stopSubagent(e.id))
    },
  })
  assert.equal(state.made, 0, 'no worker was built for a task that was already stopped')
  const err = events.find((e) => e.type === 'subagent.error')
  assert.ok(err?.type === 'subagent.error' && err.stopped === true)
  assert.equal(result.stopped, false)
})

test('control: a subagent that fails on its own is not marked as stopped by the user', async () => {
  const control = createRunControl()
  const boom = scriptedModel(() => {
    throw new Error('provider exploded')
  })
  const parent = delegatingTo('w')
  const agent = await createAgent({
    model: parent.model,
    tools: {
      w: createSubagentTool({ name: 'w', description: 'Breaks', config: { model: boom.model } }),
    },
  })
  const { events, onEvent } = collect()
  await agent.run('delegate', { control, onEvent })
  const err = events.find((e) => e.type === 'subagent.error')
  assert.ok(err?.type === 'subagent.error')
  assert.equal(err.stopped, undefined)
  assert.doesNotMatch(err.error, /stopped by the user/)
})
