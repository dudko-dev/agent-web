import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLearning,
  findSecret,
  MemorySkillStore,
  normalizeSkillName,
  VfsSkillStore,
  VirtualFileSystem,
  type AgentEvent,
  type Skill,
} from '../dist/index.js'

// The notebook is where a prompt-injected page could leave a trap for later, so the guards are
// tested as hard as the features: what it refuses, what it records, what it never overwrites.
// (The browser sibling of @dudko.dev/agent's tests/learning.test.ts - same cases, same names.)

// ── credentials ──────────────────────────────────────────────────────────────

test('findSecret: catches what a credential looks like, leaves ordinary prose alone', () => {
  const secrets = [
    'sk-' + 'a1B2c3D4e5F6g7H8i9J0',
    'sk-ant-api03-' + 'x'.repeat(30),
    'AIza' + 'SyA-1234567890abcdefghijklmnopqrstuv',
    'ghp_' + 'a'.repeat(36),
    'AKIA' + 'ABCDEFGHIJKLMNOP',
    'xoxb-' + '1234567890-abcdef',
    '-----BEGIN RSA PRIVATE KEY-----',
    'Authorization: Bearer ' + 'abcdefghijklmnopqrstuvwxyz012345',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    'password = hunter2hunter2',
    'api_key: "abcd1234efgh5678"',
  ]
  for (const s of secrets) {
    assert.ok(findSecret(`step: set it to ${s} then retry`), s.slice(0, 20))
  }
  for (const fine of [
    'Send the token in the Authorization header, not the query string.',
    'The api key is required; ask the operator for it.',
    'Use a bearer scheme: Authorization: Bearer <token>',
    'password rules: at least 8 characters',
    'retry with exponential backoff on HTTP 429 and respect Retry-After',
    'run `npm run build` before `npm test`',
  ]) {
    assert.equal(findSecret(fine), undefined, fine)
  }
})

test('normalizeSkillName: a few words become a kebab-case name; junk becomes nothing', () => {
  assert.equal(normalizeSkillName('Retry on 429'), 'retry-on-429')
  assert.equal(normalizeSkillName('  my_trick.v2 '), 'my-trick-v2')
  assert.equal(normalizeSkillName('Ünïcode name!'), 'ncode-name')
  assert.equal(normalizeSkillName('a'.repeat(100))?.length, 64)
  assert.equal(normalizeSkillName('---'), undefined)
  assert.equal(normalizeSkillName('../../etc/passwd'), 'etcpasswd')
  assert.equal(normalizeSkillName(''), undefined)
})

// ── stores ───────────────────────────────────────────────────────────────────

const lesson = (over: Partial<Skill> = {}): Skill => ({
  name: 'retry-on-429',
  description: 'When the API answers 429: back off, honour "Retry-After"; it\'s a rate limit.',
  content: 'Wait for the Retry-After header.\n\n1. Sleep.\n2. Retry once.\n',
  origin: {
    kind: 'learned',
    at: 1_700_000_000_000,
    revision: 2,
    runId: 'r1',
    sources: ['https://docs.example.com/limits'],
  },
  ...over,
})

test('MemorySkillStore: keeps, replaces and forgets', () => {
  const store = new MemorySkillStore()
  store.save(lesson())
  store.save(lesson({ content: 'v2 instructions that are long enough' }))
  assert.equal(store.list().length, 1)
  assert.match(store.list()[0].content, /^v2/)
  assert.equal(store.remove('retry-on-429'), true)
  assert.equal(store.remove('retry-on-429'), false)
})

test('VfsSkillStore: SKILL.md files in the file system, with where each came from; survives a new instance', async () => {
  const vfs = new VirtualFileSystem({ memory: true })
  await new VfsSkillStore(vfs).save(lesson())
  // Plain files the user can see in the files panel, in the same shape as a host's own skills.
  const md = await vfs.read('/skills/retry-on-429/SKILL.md')
  assert.match(md?.content ?? '', /^---\nname: retry-on-429\ndescription: "/)
  assert.match(md?.content ?? '', /Wait for the Retry-After header\./)

  const fresh = await new VfsSkillStore(vfs).list()
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].description, lesson().description, 'quotes, colons survive the round trip')
  assert.deepEqual(fresh[0].origin, lesson().origin)

  // A skill someone put there by hand has no origin sidecar: listed, but not "learned" by the store.
  await vfs.write(
    '/skills/by-hand/SKILL.md',
    '---\nname: by-hand\ndescription: mine\n---\nbody here',
  )
  // Other files in the tree are not skills and not ours to judge.
  await vfs.write('/skills/notes.md', 'not a skill')
  await vfs.write('/skills/deep/er/SKILL.md', '---\nname: deep\ndescription: x\n---\nbody')
  const both = await new VfsSkillStore(vfs).list()
  assert.deepEqual(
    both.map((s) => [s.name, s.origin?.kind]),
    [
      ['by-hand', undefined],
      ['retry-on-429', 'learned'],
    ],
  )

  assert.equal(await new VfsSkillStore(vfs).remove('retry-on-429'), true)
  assert.equal(await new VfsSkillStore(vfs).remove('retry-on-429'), false)
  assert.equal(
    await vfs.read('/skills/retry-on-429/.origin.json'),
    undefined,
    'the sidecar goes too',
  )
  assert.ok(await vfs.read('/skills/by-hand/SKILL.md'))
})

test('VfsSkillStore: a name cannot walk out of its folder; a custom folder is honoured', async () => {
  const vfs = new VirtualFileSystem({ memory: true })
  const store = new VfsSkillStore(vfs)
  await assert.rejects(store.save(lesson({ name: '../escape' })), /invalid skill name/)
  await assert.rejects(store.save(lesson({ name: 'a/b' })), /invalid skill name/)
  assert.equal(await store.remove('../escape'), false)
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await vfs.list(), [])

  await new VfsSkillStore(vfs, '/notebook/').save(lesson())
  assert.ok(await vfs.read('/notebook/retry-on-429/SKILL.md'))
  assert.equal((await new VfsSkillStore(vfs, '/notebook').list()).length, 1)
  assert.equal((await store.list()).length, 0, 'the default folder does not see it')
})

// ── the guards ───────────────────────────────────────────────────────────────

type Exec = (input: unknown, options: unknown) => Promise<Record<string, unknown>>
const make = async (
  over: {
    skills?: Skill[]
    maxSkills?: number
    maxSkillChars?: number
    store?: MemorySkillStore
  } = {},
) => {
  const skills: Skill[] = over.skills ?? []
  const events: AgentEvent[] = []
  const warnings: string[] = []
  const learning = await createLearning(
    { store: over.store, maxSkills: over.maxSkills, maxSkillChars: over.maxSkillChars },
    skills,
    (m) => void warnings.push(m),
  )
  const call = (
    tool: string,
    input: unknown,
    run: { fetched?: string[]; runId?: string } = { runId: 'run-7' },
  ) =>
    (learning.tools[tool] as unknown as { execute: Exec }).execute(input, {
      toolCallId: 'c',
      messages: [],
      agentRun: {
        emit: (e: AgentEvent) => void events.push(e),
        addUsage: () => {},
        approve: async () => {},
        ...run,
      },
    })
  return { skills, events, warnings, learning, call }
}
const good = {
  name: 'Retry on 429',
  description: 'The API answers 429',
  instructions: 'Wait for the Retry-After header, then retry once.',
}

test('save_skill: a lesson joins the live skill list at once, with where it came from', async () => {
  const { skills, events, call } = await make()
  const r = await call('save_skill', {
    ...good,
    sources: ['https://docs.example.com/limits?token=s3cret'],
  })
  assert.deepEqual(r, { saved: true, name: 'retry-on-429', update: false })
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'retry-on-429')
  const o = skills[0].origin
  assert.ok(o?.kind === 'learned')
  assert.deepEqual([o.revision, o.runId], [1, 'run-7'])
  assert.deepEqual(o.sources, ['https://docs.example.com/limits'], 'no query string kept')
  const e = events.find((x) => x.type === 'skill.learned')
  assert.ok(e?.type === 'skill.learned' && !e.update && e.name === 'retry-on-429')
})

test('save_skill: pages the run read are recorded by the harness, not left to the model', async () => {
  const { skills, call } = await make()
  await call('save_skill', good, {
    runId: 'r',
    fetched: [
      'https://evil.example/page',
      'https://docs.example.com/limits',
      'https://evil.example/page',
    ],
  })
  assert.deepEqual(skills[0].origin?.fetched, [
    'https://evil.example/page',
    'https://docs.example.com/limits',
  ])
})

test('save_skill: the same name again is an update - revision up, one entry', async () => {
  const { skills, events, call } = await make()
  await call('save_skill', good)
  const r = await call('save_skill', {
    ...good,
    instructions: 'Wait for Retry-After; cap the wait at 30 seconds.',
  })
  assert.equal(r.update, true)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].origin?.revision, 2)
  assert.match(skills[0].content, /cap the wait/)
  assert.equal(events.filter((e) => e.type === 'skill.learned' && e.update).length, 1)
})

test('save_skill refuses what it should, with a reason the model can act on', async () => {
  const { skills, call } = await make({ maxSkills: 2, maxSkillChars: 200 })
  await assert.rejects(call('save_skill', { ...good, name: '!!!' }), /not a usable skill name/)
  await assert.rejects(
    call('save_skill', { ...good, description: '  ' }),
    /WHEN this lesson applies/,
  )
  await assert.rejects(
    call('save_skill', { ...good, description: 'x'.repeat(301) }),
    /under 300 characters/,
  )
  await assert.rejects(
    call('save_skill', { ...good, instructions: 'short' }),
    /a line is not a lesson/,
  )
  await assert.rejects(
    call('save_skill', { ...good, instructions: 'y'.repeat(201) }),
    /keep it under 200/,
  )
  assert.equal(skills.length, 0, 'nothing was stored')

  // Credentials: in the steps, in the description, in the name, in a source.
  const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0'
  await assert.rejects(
    call('save_skill', { ...good, instructions: `Call it with the key ${key} in the header.` }),
    /looks like it contains an API key/,
  )
  await assert.rejects(
    call('save_skill', { ...good, description: `use ${key}` }),
    /never the secret/,
  )
  await assert.rejects(
    call('save_skill', { ...good, sources: [`https://x.example/?k=${key}`] }),
    /never the secret/,
  )
  assert.equal(skills.length, 0)

  // The notebook is bounded.
  await call('save_skill', { ...good, name: 'one' })
  await call('save_skill', { ...good, name: 'two' })
  await assert.rejects(
    call('save_skill', { ...good, name: 'three' }),
    /notebook is full \(2 lessons\)/,
  )
  await call('save_skill', {
    ...good,
    name: 'two',
    instructions: 'An update still fits when full.',
  })
  assert.equal(skills.length, 2)
})

test("save_skill never overwrites a host's skill; forget_skill only forgets the agent's own", async () => {
  const mine: Skill = {
    name: 'house-style',
    description: 'The house style',
    content: 'Host rules, do not touch.',
  }
  const { skills, events, call, learning } = await make({ skills: [mine] })
  await assert.rejects(
    call('save_skill', { ...good, name: 'house-style' }),
    /host configured and cannot be changed/,
  )
  assert.equal(skills[0].content, 'Host rules, do not touch.')

  await call('save_skill', good)
  await assert.rejects(
    call('forget_skill', { name: 'house-style' }),
    /no lesson of yours named "house-style" \(yours: retry-on-429\)/,
  )
  assert.equal(skills.length, 2)
  assert.deepEqual(await call('forget_skill', { name: 'retry-on-429' }), {
    forgotten: true,
    name: 'retry-on-429',
  })
  assert.deepEqual(
    skills.map((s) => s.name),
    ['house-style'],
  )
  assert.ok(events.some((e) => e.type === 'skill.forgotten' && e.name === 'retry-on-429'))
  assert.equal(await learning.forget('house-style'), false)
})

test('earlier lessons are loaded at start - and the host wins a name clash', async () => {
  const store = new MemorySkillStore()
  store.save(lesson({ name: 'old-lesson' }))
  store.save(lesson({ name: 'house-style', content: 'a lesson pretending to be the host’s' }))
  const host: Skill = { name: 'house-style', description: 'House', content: 'The real one.' }
  const { skills, warnings, learning } = await make({ skills: [host], store })
  assert.deepEqual(skills.map((s) => s.name).sort(), ['house-style', 'old-lesson'])
  assert.equal(skills.find((s) => s.name === 'house-style')?.content, 'The real one.')
  assert.match(warnings[0], /clashes with a configured skill/)
  assert.deepEqual(
    learning.learned().map((s) => s.name),
    ['old-lesson'],
  )
})

test('the store is written and the lesson is on disk before the model is told it is saved', async () => {
  const vfs = new VirtualFileSystem({ memory: true })
  const { call } = await make({ store: new VfsSkillStore(vfs) as never })
  await call('save_skill', good)
  assert.ok(await vfs.read('/skills/retry-on-429/SKILL.md'))
  assert.match(
    (await vfs.read('/skills/retry-on-429/.origin.json'))?.content ?? '',
    /"revision": 1/,
  )
})
