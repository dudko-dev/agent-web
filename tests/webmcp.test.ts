import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { defineTool } from '../dist/index.js'
import {
  connectWebMcp,
  findModelContext,
  isWebMcpAvailable,
  registerWebMcpTools,
  toWebMcpTools,
} from '../dist/webmcp.js'

const tools = () => ({
  add_note: defineTool({
    description: 'Add a note to the page.',
    inputSchema: z.object({
      text: z.string().describe('The note'),
      pinned: z.boolean().optional(),
    }),
    execute: async ({ text }) => ({ ok: true, added: text }),
  }),
  read_notes: defineTool({
    description: 'Read every note.',
    inputSchema: z.object({}),
    readOnly: true,
    execute: async () => 'two notes',
  }),
  wipe: defineTool({
    description: 'Delete every note.',
    inputSchema: z.object({}),
    execute: async () => ({ ok: true }),
  }),
})

/** A stand-in for `document.modelContext` that records what is registered and honours signals. */
const fakeContext = (opts: { refuse?: string[] } = {}) => {
  const registered = new Map<string, any>()
  const signals = new Map<string, AbortSignal>()
  return {
    registered,
    signals,
    registerTool(def: any, options?: { signal?: AbortSignal }) {
      if (registered.has(def.name) || opts.refuse?.includes(def.name)) {
        return Promise.reject(new DOMException('taken', 'InvalidStateError'))
      }
      registered.set(def.name, def)
      if (options?.signal) {
        signals.set(def.name, options.signal)
        options.signal.addEventListener('abort', () => registered.delete(def.name))
      }
      return Promise.resolve()
    },
  }
}

test('toWebMcpTools: one definition per tool, with schema, annotations and a callable execute', async () => {
  const defs = await toWebMcpTools(tools(), { prefix: 'notes_', consequential: ['wipe'] })
  assert.deepEqual(
    defs.map((d) => d.name),
    ['notes_add_note', 'notes_read_notes', 'notes_wipe'],
  )
  const add = defs[0]
  assert.equal(add.description, 'Add a note to the page.')
  assert.equal((add.inputSchema as any).type, 'object')
  assert.equal((add.inputSchema as any).$schema, undefined)
  assert.deepEqual((add.inputSchema as any).required, ['text'])
  assert.equal((add.inputSchema as any).properties.text.description, 'The note')
  assert.deepEqual(add.annotations, { readOnlyHint: false })
  assert.deepEqual(defs[1].annotations, { readOnlyHint: true })
  assert.deepEqual(defs[2].annotations, { readOnlyHint: false, consequentialHint: true })

  const out: any = await add.execute({ text: 'hi' })
  assert.deepEqual(JSON.parse(out.content[0].text), { ok: true, added: 'hi' })
  const read: any = await defs[1].execute({})
  assert.equal(read.content[0].text, 'two notes')
})

test('toWebMcpTools: only / except, and names WebMCP does not allow are left out', async () => {
  assert.deepEqual(
    (await toWebMcpTools(tools(), { only: ['wipe'] })).map((d) => d.name),
    ['wipe'],
  )
  assert.deepEqual(
    (await toWebMcpTools(tools(), { except: ['wipe'] })).map((d) => d.name),
    ['add_note', 'read_notes'],
  )
  const odd = { 'bad name!': tools().wipe, ok_name: tools().wipe }
  assert.deepEqual(
    (await toWebMcpTools(odd)).map((d) => d.name),
    ['ok_name'],
  )
})

test('toWebMcpTools: a tool without execute is not published; an execute error stays an error', async () => {
  const set: any = {
    declared: { description: 'no execute', inputSchema: z.object({}) },
    boom: defineTool({
      description: 'fails',
      inputSchema: z.object({}),
      execute: async () => {
        throw new Error('nope')
      },
    }),
  }
  const defs = await toWebMcpTools(set)
  assert.deepEqual(
    defs.map((d) => d.name),
    ['boom'],
  )
  await assert.rejects(defs[0].execute({}), /nope/)
})

test('registerWebMcpTools: registers with a signal; unregister (twice) withdraws', async () => {
  const ctx = fakeContext()
  const reg = await registerWebMcpTools(tools(), { context: ctx as any, prefix: 'n_' })
  assert.ok(reg)
  assert.deepEqual(reg.names, ['n_add_note', 'n_read_notes', 'n_wipe'])
  assert.equal(ctx.registered.size, 3)
  assert.ok([...ctx.signals.values()].every((s) => !s.aborted))
  reg.unregister()
  reg.unregister()
  assert.equal(ctx.registered.size, 0)
})

test('registerWebMcpTools: an outer signal withdraws the tools too', async () => {
  const ctx = fakeContext()
  const controller = new AbortController()
  await registerWebMcpTools(tools(), { context: ctx as any, signal: controller.signal })
  assert.equal(ctx.registered.size, 3)
  controller.abort()
  assert.equal(ctx.registered.size, 0)
  const late = fakeContext()
  await registerWebMcpTools(tools(), { context: late as any, signal: controller.signal })
  assert.equal(late.registered.size, 0)
})

test('registerWebMcpTools: a refused tool is skipped without a thrown error or an unhandled rejection', async () => {
  let unhandled = 0
  const onUnhandled = () => (unhandled += 1)
  process.on('unhandledRejection', onUnhandled)
  const ctx = fakeContext({ refuse: ['read_notes'] })
  const reg = await registerWebMcpTools(tools(), { context: ctx as any })
  await new Promise((r) => setTimeout(r, 10))
  process.off('unhandledRejection', onUnhandled)
  assert.equal(unhandled, 0)
  assert.ok(reg)
  assert.ok(ctx.registered.has('add_note') && ctx.registered.has('wipe'))
  reg.unregister()
})

test('registerWebMcpTools: the early-preview API (no signal) is withdrawn by name', async () => {
  const withdrawn: string[] = []
  const ctx = {
    registerTool: () => undefined,
    unregisterTool: (n: string) => void withdrawn.push(n),
  }
  const reg = await registerWebMcpTools(tools(), { context: ctx as any })
  reg!.unregister()
  reg!.unregister()
  assert.deepEqual(withdrawn, ['add_note', 'read_notes', 'wipe'])
})

test('registerWebMcpTools: resolves to undefined where the browser has no WebMCP', async () => {
  assert.equal(isWebMcpAvailable(), false)
  assert.equal(findModelContext(), undefined)
  assert.equal(await registerWebMcpTools(tools()), undefined)
  assert.equal(await connectWebMcp(), undefined)
})

test('findModelContext prefers document.modelContext and falls back to navigator.modelContext', () => {
  const early = { registerTool: () => undefined }
  const current = { registerTool: () => undefined }
  const nav = globalThis.navigator as any
  Object.defineProperty(nav, 'modelContext', { value: early, configurable: true })
  try {
    assert.equal(findModelContext({}), early)
    assert.equal(findModelContext({ modelContext: current }), current)
    assert.equal(findModelContext({ modelContext: {} }), early)
  } finally {
    delete nav.modelContext
  }
})

test("connectWebMcp: the page's tools become agent tools, run through executeTool", async () => {
  const calls: any[] = []
  const pageTools = [
    {
      name: 'search',
      description: 'Search the page',
      inputSchema: JSON.stringify({ type: 'object', properties: { q: { type: 'string' } } }),
      annotations: { readOnlyHint: true },
    },
    { name: 'buy', description: 'Buy it', inputSchema: { type: 'object', properties: {} } },
  ]
  const listeners: Record<string, () => void> = {}
  const ctx = {
    registerTool: () => undefined,
    getTools: async () => pageTools,
    executeTool: async (t: any, input: any) => {
      calls.push([t.name, input])
      return JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ hits: 2 }) }] })
    },
    addEventListener: (type: string, fn: () => void) => void (listeners[type] = fn),
    removeEventListener: (type: string) => void delete listeners[type],
  }
  let changed = 0
  const web = await connectWebMcp({
    context: ctx as any,
    onToolsChanged: () => void (changed += 1),
  })
  assert.ok(web)
  assert.deepEqual(Object.keys(web.tools), ['search', 'buy'])
  assert.equal((web.tools.search as any).readOnly, true)
  assert.equal((web.tools.buy as any).readOnly, undefined)
  assert.equal(web.tools.search.description, 'Search the page')

  const out = await (web.tools.search as any).execute({ q: 'x' }, { toolCallId: '1', messages: [] })
  assert.deepEqual(out, { hits: 2 })
  assert.deepEqual(calls, [['search', { q: 'x' }]])

  // the page registers another tool: the same object is updated in place
  pageTools.push({
    name: 'more',
    description: 'More',
    inputSchema: { type: 'object', properties: {} },
  })
  listeners.toolchange()
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(Object.keys(web.tools), ['search', 'buy', 'more'])
  assert.equal(changed, 1)
  web.close()
  assert.equal(listeners.toolchange, undefined)
})

test('connectWebMcp: filter skips tools; plain-text and unparsable results come through', async () => {
  const ctx = {
    registerTool: () => undefined,
    getTools: async () => [
      { name: 'mine', description: 'published by this agent' },
      { name: 'text', description: 't', inputSchema: '{not json' },
    ],
    executeTool: async () => 'plain words',
  }
  const web = await connectWebMcp({ context: ctx as any, filter: (t) => t.name !== 'mine' })
  assert.deepEqual(Object.keys(web!.tools), ['text'])
  assert.equal(
    await (web!.tools.text as any).execute({}, { toolCallId: '1', messages: [] }),
    'plain words',
  )
})

// ── Where WebMCP's namespace is wider than a provider's ─────────────────────
// WebMCP allows `.` and 128 characters; providers take ^[a-zA-Z0-9_-]{1,64}$
// and reject the whole request, so an unmapped page name does not fail its own
// call — it fails every run of an agent that merged the set.

test('connectWebMcp: page names are mapped into what a provider accepts', async () => {
  const long = 'x'.repeat(100)
  const ctx = {
    registerTool: () => {},
    getTools: async () => [
      { name: 'editor.clear', description: 'dotted' },
      { name: long, description: 'too long' },
      { name: 'plain_tool', description: 'already fine' },
    ],
    executeTool: async () => 'ok',
  }
  const web = await connectWebMcp({ context: ctx as never })
  const keys = Object.keys(web!.tools)
  for (const k of keys) {
    assert.match(k, /^[a-zA-Z0-9_-]+$/, `${k} uses only characters providers accept`)
    assert.ok(k.length <= 64, `${k} is within the 64-char cap`)
  }
  assert.ok(keys.includes('editor_clear'), 'the dot became an underscore')
  assert.ok(keys.includes('plain_tool'), 'a name that was already fine is untouched')
  assert.equal(keys.length, 3, 'nothing was dropped')
})

test('connectWebMcp: two page names that map onto one key both survive', async () => {
  const ctx = {
    registerTool: () => {},
    getTools: async () => [{ name: 'a.b' }, { name: 'a-b' }, { name: 'a_b' }],
    executeTool: async (t: { name: string }) => `ran ${t.name}`,
  }
  const web = await connectWebMcp({ context: ctx as never })
  assert.equal(Object.keys(web!.tools).length, 3, 'a collision suffixes instead of dropping')
  // Dispatch still reaches the right page tool: executeTool gets the page's own object.
  const results = await Promise.all(
    Object.values(web!.tools).map((t) =>
      (t.execute as (i: unknown, o: unknown) => Promise<unknown>)({}, {}),
    ),
  )
  assert.deepEqual(results.sort(), ['ran a-b', 'ran a.b', 'ran a_b'])
})

test('toWebMcpTools: a tool that returns nothing still publishes valid text content', async () => {
  const defs = await toWebMcpTools({
    clear_page: defineTool({
      description: 'Clear the page.',
      inputSchema: z.object({}),
      execute: async () => undefined,
    }),
  })
  const result = (await defs[0].execute({}, {})) as { content: { type: string; text: string }[] }
  assert.equal(typeof result.content[0].text, 'string', 'text is a string, not undefined')
})

test('toWebMcpTools: one tool that cannot be described does not take the others with it', async () => {
  const defs = await toWebMcpTools({
    good_one: defineTool({
      description: 'Fine.',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    }),
    bad_one: {
      description: () => {
        throw new Error('needs a run context')
      },
      inputSchema: z.object({}),
      execute: async () => 'ok',
    } as never,
    also_good: defineTool({
      description: 'Also fine.',
      inputSchema: z.object({}),
      execute: async () => 'ok',
    }),
  })
  assert.deepEqual(
    defs.map((d) => d.name),
    ['good_one', 'also_good'],
    'the throwing tool is skipped; the one after it is still published',
  )
})

test('connectWebMcp: a failing refresh on toolchange does not reject unhandled', async () => {
  let fail = false
  const listeners: (() => void)[] = []
  const ctx = {
    registerTool: () => {},
    getTools: async () => {
      if (fail) throw new Error('the page went away')
      return [{ name: 'a_tool' }]
    },
    executeTool: async () => 'ok',
    addEventListener: (_t: string, l: () => void) => listeners.push(l),
    removeEventListener: () => {},
  }
  const web = await connectWebMcp({ context: ctx as never })
  const unhandled: unknown[] = []
  const onUnhandled = (e: unknown) => unhandled.push(e)
  process.on('unhandledRejection', onUnhandled)
  fail = true
  listeners[0]?.()
  await new Promise((r) => setTimeout(r, 50))
  process.off('unhandledRejection', onUnhandled)
  assert.deepEqual(unhandled, [], 'the rejected refresh was caught')
  assert.deepEqual(Object.keys(web!.tools), ['a_tool'], 'the previous tools are left intact')
})
