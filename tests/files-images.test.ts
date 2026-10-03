import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AttachmentsNotSupportedError,
  attachmentKind,
  createAgent,
  supportsPdf,
  toFilePart,
  createFileTools,
  ImagesNotSupportedError,
  normalizePath,
  supportsImages,
  VirtualFileSystem,
  type AgentEvent,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo } from './helpers/scripted-model.ts'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='

const callTool = (tools: Record<string, unknown>, name: string, args: unknown) =>
  (tools[name] as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {})

// ── virtual file system ─────────────────────────────────────────────────────

test('normalizePath: absolute, collapsed, and never above the root', () => {
  assert.equal(normalizePath('notes/./a//b.md'), '/notes/a/b.md')
  assert.equal(normalizePath('/x/../y.txt'), '/y.txt')
  assert.throws(() => normalizePath('../etc/passwd'), /escapes the root/)
  assert.throws(() => normalizePath('/'), /required/)
})

for (const mode of ['memory', 'indexeddb'] as const) {
  test(`VirtualFileSystem (${mode}): write, read, list by prefix, data URLs, delete, change events`, async () => {
    const vfs = new VirtualFileSystem(
      mode === 'memory' ? { memory: true } : { dbName: 'vfs-test', namespace: 'n1' },
    )
    const changes: string[] = []
    vfs.onChange((c) => changes.push(`${c.type}:${c.path}`))
    await vfs.write('/docs/a.md', '# A')
    await vfs.write('docs/b.txt', 'bee')
    await vfs.writeDataUrl('/img/dot.png', PNG)
    assert.deepEqual(
      (await vfs.list()).map((f) => f.path),
      ['/docs/a.md', '/docs/b.txt', '/img/dot.png'],
    )
    assert.deepEqual(
      (await vfs.list('/docs')).map((f) => f.path),
      ['/docs/a.md', '/docs/b.txt'],
    )
    const a = await vfs.read('/docs/a.md')
    assert.equal(a?.content, '# A')
    assert.equal(a?.mimeType, 'text/markdown')
    const img = await vfs.read('/img/dot.png')
    assert.equal(img?.encoding, 'base64')
    assert.equal(img?.mimeType, 'image/png')
    assert.equal(await vfs.readDataUrl('/img/dot.png'), PNG)
    assert.equal(await vfs.delete('/docs/b.txt'), true)
    assert.equal(await vfs.delete('/docs/b.txt'), false)
    assert.equal(await vfs.read('/docs/b.txt'), undefined)
    assert.deepEqual(changes, [
      'write:/docs/a.md',
      'write:/docs/b.txt',
      'write:/img/dot.png',
      'delete:/docs/b.txt',
    ])
    await vfs.clear()
    assert.deepEqual(await vfs.list(), [])
  })
}

test('VirtualFileSystem: namespaces in one database do not see each other', async () => {
  const a = new VirtualFileSystem({ dbName: 'vfs-ns', namespace: 'a' })
  const b = new VirtualFileSystem({ dbName: 'vfs-ns', namespace: 'b' })
  await a.write('/x.txt', 'from a')
  assert.deepEqual(await b.list(), [])
  assert.equal((await a.list()).length, 1)
})

test('VirtualFileSystem: refuses a file above the size cap', async () => {
  const vfs = new VirtualFileSystem({ memory: true, maxFileBytes: 4 })
  await assert.rejects(() => vfs.write('/big.txt', 'hello'), /limit is 4/)
})

test('createFileTools: list / read / write / delete, read-only tools marked, binary refused as text', async () => {
  const vfs = new VirtualFileSystem({ memory: true })
  const tools = createFileTools(vfs)
  assert.deepEqual(Object.keys(tools), ['fs_list', 'fs_read', 'fs_write', 'fs_delete'])
  assert.equal((tools.fs_read as { readOnly?: boolean }).readOnly, true)
  assert.equal((tools.fs_write as { readOnly?: boolean }).readOnly, undefined)
  assert.deepEqual(await callTool(tools, 'fs_write', { path: '/r.md', content: 'report' }), {
    written: '/r.md',
    size: 6,
  })
  assert.equal(await callTool(tools, 'fs_read', { path: '/r.md' }), 'report')
  await assert.rejects(() => callTool(tools, 'fs_read', { path: '/nope' }), /files: \/r.md/)
  await vfs.writeDataUrl('/p.png', PNG)
  assert.match(String(await callTool(tools, 'fs_read', { path: '/p.png' })), /binary file/)
  assert.deepEqual(await callTool(tools, 'fs_delete', { path: '/r.md' }), { deleted: true })
  assert.deepEqual(Object.keys(createFileTools(vfs, { readOnly: true, prefix: 'ws_' })), [
    'ws_list',
    'ws_read',
  ])
})

// ── images ──────────────────────────────────────────────────────────────────

test('supportsImages: local runtimes and text-only families say no, vision providers yes', () => {
  assert.equal(supportsImages({ provider: 'web-llm', modelId: 'Qwen3' }), false)
  assert.equal(supportsImages({ provider: 'deepseek.chat', modelId: 'deepseek-chat' }), false)
  assert.equal(supportsImages({ provider: 'openai.chat', modelId: 'gpt-3.5-turbo' }), false)
  assert.equal(
    supportsImages({ provider: 'google.generative-ai', modelId: 'gemini-3.5-flash' }),
    true,
  )
  assert.equal(supportsImages({ provider: 'anthropic.messages', modelId: 'claude-sonnet-5' }), true)
  assert.equal(supportsImages('openai/gpt-5.4-mini'), true)
  assert.equal(supportsImages({ provider: 'my-server.chat', modelId: 'llama' }), undefined)
})

const imageParts = (info: CallInfo): unknown[] =>
  ((info.options.prompt ?? []) as { role: string; content: unknown }[])
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) =>
      (m.content as { type: string }[]).filter((p) => p.type === 'file' || p.type === 'image'),
    )

test('images reach the planner, the executor and the synthesizer of a vision model', async () => {
  const { model, calls } = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: JSON.stringify({ thought: 't', steps: [{ description: 'Describe it' }] }) }
      : { text: 'A red dot.' },
  )
  const agent = await createAgent({ model, vision: true })
  assert.equal(agent.capabilities.images, true)
  const result = await agent.run('what is in the picture?', {
    images: [{ data: PNG, name: 'dot.png' }],
  })
  assert.equal(result.final, 'A red dot.')
  for (const stage of ['planner', 'executor', 'synthesizer']) {
    const call = calls.find((c) => stageOf(c) === stage)!
    assert.equal(imageParts(call).length, 1, `${stage} sees the image`)
  }
})

test('images + a text-only model: the run ends at once with a clear error, no tokens spent', async () => {
  const { model, calls } = scriptedModel(() => ({ text: 'unused' }))
  const agent = await createAgent({ model, toolMode: 'prompted' })
  assert.equal(agent.capabilities.images, false)
  const events: AgentEvent[] = []
  const result = await agent.run('describe this', {
    images: [{ data: PNG, name: 'dot.png' }],
    onEvent: (e) => events.push(e),
  })
  assert.equal(calls.length, 0)
  assert.match(result.final, /can't take images \(it runs in the text-only prompted tool mode\)/)
  const err = events.find((e) => e.type === 'error')
  assert.ok(err?.type === 'error' && err.phase === 'run')
  // `vision: false` forces the same for a model that would otherwise be tried.
  const forced = await createAgent({ model, vision: false })
  assert.match((await forced.run('look', { images: [{ data: PNG }] })).final, /can't take images/)
})

test('images + a provider that refuses them: the refusal becomes ImagesNotSupportedError', async () => {
  const { model } = scriptedModel((info) => {
    if (imageParts(info).length) throw new Error('This model does not support image input')
    return { text: 'ok' }
  })
  const agent = await createAgent({ model })
  assert.equal(agent.capabilities.images, undefined)
  const events: AgentEvent[] = []
  const result = await agent.run('what is this', {
    images: [{ data: PNG }],
    onEvent: (e) => events.push(e),
  })
  assert.match(
    result.final,
    /can't take images \(the provider said: This model does not support image input\)/,
  )
  assert.ok(events.some((e) => e.type === 'error' && e.phase === 'run'))
  assert.ok(new ImagesNotSupportedError('m') instanceof Error)
})

test('memory keeps a text note of the images, not their bytes', async () => {
  const { MemoryStore } = await import('../dist/index.js')
  const memory = new MemoryStore()
  const { model } = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: JSON.stringify({ thought: 'Hello!', steps: [] }) }
      : { text: 'x' },
  )
  const agent = await createAgent({ model, memory, sessionId: 's', vision: true })
  await agent.run('hi', { images: [{ data: PNG, name: 'cat.png' }] })
  const stored = await memory.load('s')
  assert.match(stored[0].content, /\[attached: cat.png\]/)
  assert.doesNotMatch(stored[0].content, /base64/)
})

// ── PDFs, other files, URLs ─────────────────────────────────────────────────

const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcfsj6IK'

test('attachments: kind and part by media type — image part, PDF file part, URL passthrough', () => {
  assert.equal(attachmentKind({ data: PNG }), 'image')
  assert.equal(attachmentKind({ data: PDF }), 'pdf')
  assert.equal(attachmentKind({ data: 'https://example.com/report.pdf' }), 'pdf')
  assert.equal(attachmentKind({ data: 'aGk=', mediaType: 'text/csv' }), 'file')
  assert.deepEqual(toFilePart({ data: PDF, name: 'r.pdf' }), {
    type: 'file',
    data: 'JVBERi0xLjQKJcfsj6IK',
    mediaType: 'application/pdf',
    filename: 'r.pdf',
  })
  const url = toFilePart({ data: 'https://example.com/cat.png' }) as {
    type: string
    data: URL
    mediaType: string
  }
  assert.equal(url.type, 'file')
  assert.equal(url.mediaType, 'image/png')
  assert.ok(url.data instanceof URL)
  assert.equal(url.data.href, 'https://example.com/cat.png')
})

test('supportsPdf: Gemini/Claude/OpenAI read PDFs; local and text-only models do not', () => {
  assert.equal(supportsPdf({ provider: 'google.generative-ai', modelId: 'gemini-3.5-flash' }), true)
  assert.equal(supportsPdf({ provider: 'anthropic.messages', modelId: 'claude-haiku-4-5' }), true)
  assert.equal(supportsPdf({ provider: 'web-llm', modelId: 'x' }), false)
  assert.equal(supportsPdf({ provider: 'xai.chat', modelId: 'grok-4' }), undefined)
})

test('a PDF reaches the model as a file part; a URL stays a URL', async () => {
  const { model, calls } = scriptedModel((info) =>
    stageOf(info) === 'planner'
      ? { text: JSON.stringify({ thought: 't', steps: [{ description: 'Read it' }] }) }
      : { text: 'It is a report.' },
  )
  const agent = await createAgent({ model, inputs: { pdf: true, images: true } })
  await agent.run('summarise the attachments', {
    files: [{ data: PDF, name: 'r.pdf' }, { data: 'https://example.com/cat.png' }],
  })
  const parts = imageParts(calls.find((c) => stageOf(c) === 'planner')!) as {
    type: string
    mediaType: string
    data: unknown
  }[]
  assert.deepEqual(
    parts.map((p) => p.mediaType),
    ['application/pdf', 'image/png'],
  )
  // The provider receives the link itself, not downloaded bytes.
  const link = parts[1].data as { type: string; url: URL }
  assert.equal(link.type, 'url')
  assert.equal(String(link.url), 'https://example.com/cat.png')
})

test('a PDF for a model that cannot read PDFs: a clear error that suggests converting it', async () => {
  const { model, calls } = scriptedModel(() => ({ text: 'unused' }))
  const agent = await createAgent({ model, inputs: { pdf: false } })
  assert.equal(agent.capabilities.pdf, false)
  const result = await agent.run('read this', { files: [{ data: PDF, name: 'r.pdf' }] })
  assert.equal(calls.length, 0)
  assert.match(result.final, /can't take PDF files\. Convert the PDF to text first/)
  assert.equal(new AttachmentsNotSupportedError('m', 'pdf').kind, 'pdf')
})
