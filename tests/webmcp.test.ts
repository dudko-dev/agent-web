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
