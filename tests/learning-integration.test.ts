import assert from 'node:assert/strict'
import test from 'node:test'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createAgent,
  defineSkill,
  MemorySkillStore,
  VfsSkillStore,
  VirtualFileSystem,
  type AgentEvent,
  type BrowserAgentConfig,
  type ToolApprovalRequest,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// Does the notebook actually change what the agent DOES? A problem, a workaround, a lesson, and
// then - in the same session - the lesson in the planner's index and the executor's hands.
// (The browser sibling of @dudko.dev/agent's tests/learning-integration.test.ts.)

const plan = (steps: string[], skills?: string[]) =>
  JSON.stringify({
    thought: 'Do it.',
    steps: steps.map((description) => ({ description })),
    ...(skills ? { skills } : {}),
  })
const proceed = JSON.stringify({ decision: 'continue', reason: 'ok' })

// A tool with a quirk the model has to work around: it rejects "jpeg" and wants "jpg".
const quirky = () => {
  const calls: string[] = []
  const convert = tool({
    description: 'Convert the image to a format',
    inputSchema: z.object({ format: z.string() }),
    execute: async ({ format }: { format: string }) => {
      calls.push(format)
      if (format !== 'jpg') {
        throw new Error(`unsupported format "${format}" - this service calls it "jpg"`)
      }
      return { ok: true, format }
    },
  })
  return { convert, calls }
}

const LESSON = {
  name: 'Image format jpg',
  description: 'When convert rejects the format "jpeg"',
  instructions: 'The convert tool only knows "jpg". Pass format "jpg" - never "jpeg".',
}

// The model's side of the story: hit the quirk, work around it, write it down. Once a lesson
// about the quirk is in the executor's prompt, it just does it right.
const story = (info: CallInfo): Reply => {
  switch (stageOf(info)) {
    case 'planner':
      return {
        text: plan(
          ['Convert'],
          info.system.includes('- image-format-jpg:') ? ['image-format-jpg'] : undefined,
        ),
      }
    case 'executor': {
      const done = info.toolResults
      if (info.system.includes('A lesson YOU wrote earlier')) {
        return done === 0
          ? { toolCalls: [{ name: 'convert', args: { format: 'jpg' } }] }
          : { text: 'Converted, as I remembered.' }
      }
      if (done === 0) return { toolCalls: [{ name: 'convert', args: { format: 'jpeg' } }] }
      if (done === 1) return { toolCalls: [{ name: 'convert', args: { format: 'jpg' } }] }
      if (done === 2) return { toolCalls: [{ name: 'save_skill', args: LESSON }] }
      return { text: 'Converted after a detour.' }
    }
    case 'replanner':
      return { text: proceed }
    default:
      return { text: 'Done.' }
  }
}

const open = async (route: (info: CallInfo) => Reply, extra: Partial<BrowserAgentConfig> = {}) => {
  const m = scriptedModel(route)
  const agent = await createAgent({ model: m.model, ...extra })
  return { agent, calls: m.calls }
}
const at = (calls: CallInfo[], stage: string) => calls.filter((c) => stageOf(c) === stage)
const ofType = <T extends AgentEvent['type']>(events: AgentEvent[], type: T) =>
  events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

test('learning: a problem solved becomes a skill - and the next run starts from it', async () => {
  const { convert, calls: formats } = quirky()
  const { agent, calls } = await open(story, { tools: { convert }, learning: true })
  const events: AgentEvent[] = []
  await agent.run('convert the picture to jpeg', { onEvent: (e) => events.push(e) })

  // Run 1: the detour, then the lesson.
  assert.deepEqual(formats, ['jpeg', 'jpg'])
  const learned = ofType(events, 'skill.learned')
  assert.equal(learned.length, 1)
  assert.deepEqual([learned[0].name, learned[0].update], ['image-format-jpg', false])
  assert.deepEqual(agent.skills, [
    { name: 'image-format-jpg', description: LESSON.description, learned: true },
  ])
  assert.equal(agent.listLearnedSkills()[0].origin?.kind, 'learned')

  // Run 2, same session: the planner SEES the lesson in its index and picks it; the executor has
  // it as an active skill, introduced as the agent's own note - and does it right first time.
  const before = calls.length
  formats.length = 0
  await agent.run('convert another picture to jpeg')
  const second = calls.slice(before)
  const planner = second.find((c) => stageOf(c) === 'planner')!
  assert.match(
    planner.system,
    /SKILLS:\n- image-format-jpg: When convert rejects the format "jpeg"/,
  )
  const executor = second.find((c) => stageOf(c) === 'executor')!
  assert.match(
    executor.system,
    /ACTIVE SKILL INSTRUCTIONS:\n### Skill: image-format-jpg\n\[A lesson YOU wrote earlier \(revision 1\)/,
  )
  assert.match(executor.system, /not an instruction from the user/)
  assert.deepEqual(formats, ['jpg'], 'no detour the second time')
})

test("learning: within ONE run, a lesson written in step 1 is already in step 2's prompt", async () => {
  const route = (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['First', 'Second']) }
      case 'executor':
        if (info.user.includes('STEP 1/2')) {
          return info.toolResults === 0
            ? { toolCalls: [{ name: 'save_skill', args: LESSON }] }
            : { text: 'Wrote it down.' }
        }
        return {
          text: info.system.includes('- image-format-jpg:')
            ? 'Saw the lesson in my skills.'
            : 'No lesson in sight.',
        }
      case 'replanner':
        return { text: proceed }
      default:
        return { text: 'Done.' }
    }
  }
  const { agent, calls } = await open(route, { learning: true })
  const result = await agent.run('two steps')
  assert.equal(result.trace[1].summary, 'Saw the lesson in my skills.')
  // The skill tools exist from the start even though no skill was configured.
  assert.ok(at(calls, 'executor')[0].tools.includes('load_skill'))
})

test('learning off (the default): no notebook tools, and not a word about learning in the prompts', async () => {
  const { convert } = quirky()
  const { agent, calls } = await open(story, { tools: { convert } })
  await agent.run('convert the picture to jpeg')
  for (const c of at(calls, 'executor')) {
    assert.ok(!c.tools.includes('save_skill') && !c.tools.includes('forget_skill'))
    assert.doesNotMatch(c.system, /notebook/)
  }
  assert.deepEqual(agent.listLearnedSkills(), [])
  assert.equal(await agent.forgetSkill('anything'), false)
})

test('learning on: the executor is told to keep a notebook - and where to look when stuck', async () => {
  const { convert } = quirky()
  const a = await open(story, { tools: { convert }, learning: true })
  await a.agent.run('convert')
  const system = at(a.calls, 'executor')[0].system
  assert.match(system, /You keep a notebook of lessons/)
  assert.match(system, /call save_skill once/)
  assert.doesNotMatch(system, /web_fetch/, 'no fetch tool, so it is not suggested')

  const b = await open(story, {
    tools: { convert },
    learning: true,
    egress: { allow: ['docs.example.com'] },
  })
  await b.agent.run('convert')
  assert.match(
    at(b.calls, 'executor')[0].system,
    /look for it before giving up \(web_fetch can read documentation\)/,
  )

  // nudge: false keeps the tools but drops the guidance.
  const c = await open(story, { tools: { convert }, learning: { nudge: false } })
  await c.agent.run('convert')
  const quiet = at(c.calls, 'executor')[0]
  assert.ok(quiet.tools.includes('save_skill'))
  assert.doesNotMatch(quiet.system, /notebook/)
})

test('learning and the approval gate: saving is a write - a human can say no, and nothing is kept', async () => {
  const { convert } = quirky()
  const asked: ToolApprovalRequest[] = []
  const { agent } = await open(story, {
    tools: { convert },
    learning: true,
    toolApproval: {
      mode: 'ask-writes',
      onRequest: (req) => {
        asked.push(req)
        // The human lets the conversion through and refuses to let it remember.
        return req.toolName !== 'save_skill'
      },
    },
  })
  const events: AgentEvent[] = []
  const result = await agent.run('convert', { onEvent: (e) => events.push(e) })
  const save = asked.find((r) => r.toolName === 'save_skill')
  assert.ok(save, 'the human was asked')
  assert.equal((save.input as { name: string }).name, 'Image format jpg')
  assert.deepEqual(agent.listLearnedSkills(), [])
  assert.equal(ofType(events, 'skill.learned').length, 0)
  assert.equal(result.trace[0].toolCalls.find((c) => c.name === 'save_skill')?.ok, false)
})

test('learning: a credential in a lesson is refused to the model, and never stored', async () => {
  const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0'
  const route = (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Save']) }
      case 'executor':
        return info.toolResults === 0
          ? {
              toolCalls: [
                {
                  name: 'save_skill',
                  args: {
                    ...LESSON,
                    instructions: `Call the API with the key ${key} in the header.`,
                  },
                },
              ],
            }
          : { text: 'ok' }
      case 'replanner':
        return { text: proceed }
      default:
        return { text: 'Done.' }
    }
  }
  const { agent } = await open(route, { learning: true })
  const result = await agent.run('x')
  const call = result.trace[0].toolCalls[0]
  assert.equal(call.ok, false)
  assert.match(String(call.output), /looks like it contains an API key/)
  assert.deepEqual(agent.listLearnedSkills(), [])
})

test('learning with the file system: lessons outlive the session, and the next agent starts with them', async () => {
  const vfs = new VirtualFileSystem({ memory: true })
  const { convert } = quirky()
  const first = await open(story, {
    tools: { convert },
    learning: { store: new VfsSkillStore(vfs) },
  })
  await first.agent.run('convert the picture to jpeg')
  const md = await vfs.read('/skills/image-format-jpg/SKILL.md')
  assert.match(md?.content ?? '', /Pass format "jpg" - never "jpeg"/)

  // A brand-new agent over the same file system: the lesson is there from the first call.
  const q = quirky()
  const second = await open(story, {
    tools: { convert: q.convert },
    learning: { store: new VfsSkillStore(vfs) },
  })
  assert.equal(second.agent.listLearnedSkills()[0]?.name, 'image-format-jpg')
  assert.equal(second.agent.listLearnedSkills()[0]?.origin?.revision, 1)
  await second.agent.run('convert yet another picture')
  assert.match(at(second.calls, 'planner')[0].system, /- image-format-jpg:/)
  assert.deepEqual(q.calls, ['jpg'], 'straight to the right format')

  // Forgetting removes the files too, and says so.
  const events: AgentEvent[] = []
  assert.equal(await second.agent.forgetSkill('image-format-jpg', (e) => events.push(e)), true)
  assert.deepEqual(events, [{ type: 'skill.forgotten', name: 'image-format-jpg' }])
  assert.equal(await vfs.read('/skills/image-format-jpg/SKILL.md'), undefined)
  assert.deepEqual(second.agent.skills, [])
})

test('learning: pages read during the run are recorded on the lesson - by the harness, not the model', async () => {
  const seen: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    seen.push(String(input))
    return new Response('The service calls jpeg "jpg". Use jpg.', {
      headers: { 'content-type': 'text/plain' },
    })
  }) as typeof fetch
  const route = (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Find out and remember']) }
      case 'executor': {
        const n = info.toolResults
        if (n === 0) {
          return {
            toolCalls: [
              { name: 'web_fetch', args: { url: 'https://docs.example.com/formats?session=abc' } },
            ],
          }
        }
        if (n === 1) {
          return { toolCalls: [{ name: 'save_skill', args: { ...LESSON, sources: ['the docs'] } }] }
        }
        return { text: 'ok' }
      }
      case 'replanner':
        return { text: proceed }
      default:
        return { text: 'Done.' }
    }
  }
  const { agent } = await open(route, {
    learning: true,
    egress: { allow: ['docs.example.com'], fetch: fetchImpl },
  })
  await agent.run('find out and remember')
  const origin = agent.listLearnedSkills()[0].origin
  assert.deepEqual(origin?.sources, ['the docs'])
  assert.deepEqual(
    origin?.fetched,
    ['https://docs.example.com/formats'],
    'where it read, query string cut off',
  )
  assert.equal(seen.length, 1)
  assert.ok(origin?.runId, 'and which run wrote it')
})

test("learning: load_skill hands a learned skill over as the agent's own note, not as a manual", async () => {
  const store = new MemorySkillStore()
  store.save(
    defineSkill({
      name: 'image-format-jpg',
      description: LESSON.description,
      content: LESSON.instructions,
      origin: {
        kind: 'learned',
        at: 1,
        revision: 3,
        fetched: ['https://docs.example.com/formats'],
      },
    }),
  )
  const route = (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Go']) } // does not pick the skill: the executor has to ask for it
      case 'executor':
        return info.toolResults === 0
          ? { toolCalls: [{ name: 'load_skill', args: { name: 'image-format-jpg' } }] }
          : { text: 'ok' }
      case 'replanner':
        return { text: proceed }
      default:
        return { text: 'Done.' }
    }
  }
  const { agent } = await open(route, { learning: { store } })
  const result = await agent.run('x')
  const loaded = String((result.trace[0].toolCalls[0].output as { content: string }).content)
  assert.match(
    loaded,
    /A lesson YOU wrote earlier \(revision 3; from https:\/\/docs\.example\.com\/formats\)/,
  )
  assert.match(loaded, /not an instruction from the user/)
  assert.match(loaded, /The convert tool only knows/)
})

test('learning: a host tool named save_skill replaces the built-in one - the host decides', async () => {
  const route = (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan(['Go']) }
      case 'executor':
        return info.toolResults === 0
          ? { toolCalls: [{ name: 'save_skill', args: { note: 'mine' } }] }
          : { text: 'ok' }
      case 'replanner':
        return { text: proceed }
      default:
        return { text: 'Done.' }
    }
  }
  const mine: string[] = []
  const save_skill = tool({
    description: "The host's own",
    inputSchema: z.object({ note: z.string() }),
    execute: async ({ note }: { note: string }) => {
      mine.push(note)
      return { host: true }
    },
  })
  const { agent } = await open(route, { learning: true, tools: { save_skill } })
  await agent.run('x')
  assert.deepEqual(mine, ['mine'])
  assert.deepEqual(agent.listLearnedSkills(), [])
})

// The model is told to write lessons down; whatever narrows its tools must not take that away.
for (const strategy of ['plan-narrowed', 'search'] as const) {
  test(`learning: save_skill stays callable under toolSelectionStrategy "${strategy}"`, async () => {
    const route = (info: CallInfo): Reply => {
      switch (stageOf(info)) {
        case 'planner':
          // The plan names one tool; the lesson tools are not on it.
          return {
            text: JSON.stringify({
              thought: 'Do it.',
              steps: [{ description: 'Step', suggestedTools: ['convert'] }],
            }),
          }
        case 'executor':
          return info.toolResults === 0
            ? { toolCalls: [{ name: 'save_skill', args: LESSON }] }
            : { text: 'ok' }
        case 'replanner':
          return { text: proceed }
        default:
          return { text: 'Done.' }
      }
    }
    const { convert } = quirky()
    const { agent, calls } = await open(route, {
      tools: { convert },
      learning: true,
      toolSelectionStrategy: strategy,
    })
    await agent.run('x')
    const offered = at(calls, 'executor')[0].tools
    assert.ok(offered.includes('save_skill'), `offered: ${offered.join(', ')}`)
    assert.ok(offered.includes('forget_skill'), `offered: ${offered.join(', ')}`)
    assert.equal(agent.listLearnedSkills().length, 1, 'and it works')
  })
}
