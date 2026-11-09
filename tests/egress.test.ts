import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import {
  checkEgressUrl,
  classifyAddress,
  createAgent,
  createGuardedFetch,
  createEgressTools,
  createWebFetchTool,
  EgressError,
  hostMatches,
  htmlToText,
  isReadOnlyTool,
  resolveEgressPolicy,
  WEB_FETCH_TOOL,
  type AgentEvent,
  type IEgressPolicy,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

// The browser's egress guard. It cannot pin DNS, so it is judged on what it CAN do: refuse by
// URL, host list and address shape before a request is made, send nothing of the user's, bound
// the answer, and never follow a redirect it cannot see.

const code = (c: string) => (err: unknown) => err instanceof EgressError && err.code === c

// ── addresses and patterns (the same logic as the server's) ──────────────────

test('classifyAddress: public / private / never, IPv4 inside IPv6 unwrapped', () => {
  for (const ip of ['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(classifyAddress(ip), 'public', ip)
  }
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '192.168.0.1',
    '172.16.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
  ]) {
    assert.equal(classifyAddress(ip), 'private', ip)
  }
  for (const ip of [
    '169.254.169.254',
    '100.100.100.200',
    '192.0.0.192',
    'fd00:ec2::254',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    'ff02::1',
    '::ffff:169.254.169.254',
    '2002:a9fe:a9fe::1',
  ]) {
    assert.equal(classifyAddress(ip), 'never', ip)
  }
  for (const junk of ['', 'localhost', '1.2.3', '256.1.1.1', '01.2.3.4', '::g', 'fe80::1%eth0']) {
    assert.equal(classifyAddress(junk), 'never', JSON.stringify(junk))
  }
})

test('hostMatches: exact, subdomain wildcard (not the apex, not a suffix), IP and CIDR', () => {
  assert.equal(hostMatches('Example.COM.', 'example.com'), true)
  assert.equal(hostMatches('www.example.com', 'example.com'), false)
  assert.equal(hostMatches('a.b.example.com', '*.example.com'), true)
  assert.equal(hostMatches('example.com', '*.example.com'), false)
  assert.equal(hostMatches('evilexample.com', '*.example.com'), false)
  assert.equal(hostMatches('198.51.100.200', '198.51.100.0/24'), true)
  assert.equal(hostMatches('198.51.101.1', '198.51.100.0/24'), false)
  assert.equal(hostMatches('example.com', '198.51.100.0/24'), false)
})

// ── the URL checks, browser flavour ──────────────────────────────────────────

const refuses = (url: string, policy: IEgressPolicy, c: string, method = 'GET') =>
  assert.throws(
    () => checkEgressUrl(new URL(url), resolveEgressPolicy(policy), method),
    code(c),
    `${method} ${url}`,
  )
const accepts = (url: string, policy: IEgressPolicy, method = 'GET') =>
  assert.doesNotThrow(() => checkEgressUrl(new URL(url), resolveEgressPolicy(policy), method), url)

test('checkEgressUrl: https:443 GET only, no credentials; allow is exclusive, deny wins', () => {
  accepts('https://example.com/a?b=1', {})
  refuses('http://example.com/', {}, 'bad-protocol')
  refuses('file:///etc/passwd', {}, 'bad-protocol')
  refuses('javascript:alert(1)', {}, 'bad-protocol')
  refuses('https://u:p@example.com/', {}, 'credentials-in-url')
  refuses('https://example.com:8443/', {}, 'bad-port')
  refuses('https://example.com/', {}, 'bad-method', 'POST')
  accepts('http://example.com/', { protocols: ['https', 'http'] })
  accepts('https://docs.example.com/', { allow: ['*.example.com'] })
  refuses('https://example.org/', { allow: ['*.example.com'] }, 'not-allowed-host')
  refuses(
    'https://docs.example.com/',
    { allow: ['*.example.com'], deny: ['docs.example.com'] },
    'denied-host',
  )
})

test('checkEgressUrl: IP literals, URL-parser tricks and internal-looking names are refused; metadata always', () => {
  for (const url of [
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://10.1.2.3/',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::ffff:169.254.169.254]/',
    'https://2130706433/',
    'https://0x7f.0.0.1/',
    'https://0177.0.0.1/',
    'https://127.1/',
  ]) {
    refuses(url, {}, 'denied-address')
  }
  // Names that are internal by shape - all a page can tell without resolving them.
  for (const url of [
    'https://localhost/',
    'https://app.localhost/',
    'https://printer.local/',
    'https://db.internal/',
    'https://intranet/',
    'https://router/',
    'https://nas.home.arpa/',
    'https://wiki.corp/',
  ]) {
    refuses(url, {}, 'denied-address')
  }
  accepts('https://example.com/', {})
  accepts('https://sub.example.co.uk/', {})
  // Opt-in for an intranet page; metadata stays refused.
  accepts('https://localhost/', { allowPrivateNetwork: true })
  accepts('https://10.1.2.3/', { allowPrivateNetwork: true })
  accepts('https://wiki.corp/', { allowPrivateNetwork: true })
  refuses('https://169.254.169.254/', { allowPrivateNetwork: true }, 'denied-address')
  refuses('https://10.1.2.3/', { allowPrivateNetwork: true, deny: ['10.0.0.0/8'] }, 'denied-host')
})

// ── the fetch ────────────────────────────────────────────────────────────────

interface ISeen {
  url: string
  init: RequestInit
}
const html =
  (body: string, type = 'text/html; charset=utf-8') =>
  (): Response =>
    new Response(body, { headers: { 'content-type': type } })
/** A `fetch` double that records what it was asked and answers with `make()`. */
const spy = (make: (url: string) => Response | Promise<Response>) => {
  const seen: ISeen[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} })
    return make(String(input))
  }) as typeof fetch
  return { seen, fetchImpl }
}
const withUrl = (res: Response, url: string): Response => {
  Object.defineProperty(res, 'url', { value: url })
  return res
}

test('guarded fetch: refusals happen BEFORE any request is made', async () => {
  const { seen, fetchImpl } = spy(html('x'))
  const f = createGuardedFetch({ fetch: fetchImpl })
  for (const url of [
    'http://example.com/',
    'https://localhost/',
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'not a url',
    'https://u:p@example.com/',
  ]) {
    await assert.rejects(f(url), (err: unknown) => err instanceof EgressError, url)
  }
  await assert.rejects(f('https://example.com/', { method: 'POST' }), code('bad-method'))
  assert.equal(seen.length, 0, 'not one request left the page')
})

test('guarded fetch: nothing of the user rides along, and redirects are not followed blindly', async () => {
  const { seen, fetchImpl } = spy(html('hello'))
  const f = createGuardedFetch({ fetch: fetchImpl })
  const res = await f('https://example.com/page', { headers: { 'x-thing': '1' } })
  assert.equal(await res.text(), 'hello')
  const init = seen[0].init
  assert.equal(init.credentials, 'omit')
  assert.equal(init.referrerPolicy, 'no-referrer')
  assert.equal(init.cache, 'no-store')
  assert.equal(init.redirect, 'manual')
  assert.equal(init.mode, 'cors')
  assert.equal(init.method, 'GET')
  assert.deepEqual(init.headers, { 'x-thing': '1' })
})

test('guarded fetch: a redirect fails the request by default - a page cannot see where it goes', async () => {
  const opaque = spy(() => {
    const r = new Response(null, { status: 200 })
    Object.defineProperty(r, 'type', { value: 'opaqueredirect' })
    return r
  })
  await assert.rejects(
    createGuardedFetch({ fetch: opaque.fetchImpl })('https://example.com/'),
    code('bad-redirect'),
  )
})

test('guarded fetch: followRedirects judges the FINAL url - after the fact, and withholds the answer', async () => {
  const { seen, fetchImpl } = spy((url) =>
    withUrl(new Response('internal secret'), url.includes('/go') ? 'https://router/admin' : url),
  )
  const f = createGuardedFetch({ fetch: fetchImpl, followRedirects: true })
  assert.equal(seen.length, 0)
  await assert.rejects(f('https://example.com/go'), code('denied-address'))
  assert.equal(seen[0].init.redirect, 'follow')
  const ok = await f('https://example.com/fine')
  assert.equal(await ok.text(), 'internal secret', 'a final url that passes is returned')
})

test('guarded fetch: the size cap holds - declared and streamed', async () => {
  const big = new Response('x'.repeat(5000), { headers: { 'content-length': '5000' } })
  await assert.rejects(
    createGuardedFetch({ maxResponseBytes: 1000, fetch: spy(() => big).fetchImpl })(
      'https://example.com/',
    ),
    code('too-large'),
  )

  const streamed = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 20; i += 1)
            controller.enqueue(new TextEncoder().encode('y'.repeat(100)))
          controller.close()
        },
      }),
    )
  const res = await createGuardedFetch({ maxResponseBytes: 1000, fetch: spy(streamed).fetchImpl })(
    'https://example.com/',
  )
  await assert.rejects(res.arrayBuffer(), code('too-large'))
  const small = await createGuardedFetch({
    maxResponseBytes: 5000,
    fetch: spy(streamed).fetchImpl,
  })('https://example.com/')
  assert.equal((await small.text()).length, 2000)
})

test('guarded fetch: timeout, caller abort and a network failure are told apart', async () => {
  // AbortSignal.timeout's timer is unref'd (right for a library); hold the loop open for the test.
  const keepAlive = setInterval(() => {}, 50)
  after(() => clearInterval(keepAlive))
  // The double honours the signal like a real fetch.
  const abortable = (async (_u: unknown, init?: RequestInit) =>
    new Promise<Response>((_res, rej) =>
      init?.signal?.addEventListener('abort', () =>
        rej(init.signal?.reason ?? new Error('aborted')),
      ),
    )) as typeof fetch
  await assert.rejects(
    createGuardedFetch({ timeoutMs: 100, fetch: abortable })('https://example.com/'),
    code('timeout'),
  )
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 50)
  await assert.rejects(
    createGuardedFetch({ timeoutMs: 10_000, fetch: abortable })('https://example.com/', {
      signal: ac.signal,
    }),
    (err: unknown) => !(err instanceof EgressError),
  )
  const broken = (async () => {
    throw new TypeError('Failed to fetch')
  }) as typeof fetch
  await assert.rejects(
    createGuardedFetch({ fetch: broken })('https://example.com/'),
    code('network'),
  )
})

// ── the tool ─────────────────────────────────────────────────────────────────

type Exec = (input: unknown, options: unknown) => Promise<Record<string, unknown>>
const runTool = async (
  policy: IEgressPolicy,
  input: { url: string; maxChars?: number },
  events: AgentEvent[] = [],
) => {
  const tool = createWebFetchTool({ policy }) as unknown as { execute: Exec }
  const agentRun = {
    emit: (e: AgentEvent) => void events.push(e),
    addUsage: () => {},
    approve: async () => {},
  }
  return tool.execute(input, { toolCallId: 'c1', messages: [], agentRun })
}

test('web_fetch: a page becomes readable text with its title, flagged untrusted', async () => {
  const { fetchImpl } = spy(
    html(
      '<html><head><title>Docs &amp; Guides</title><script>evil()</script></head><body><h1>Install</h1><p>Run <code>npm i</code> &lt;now&gt;.</p></body></html>',
    ),
  )
  const r = await runTool({ fetch: fetchImpl }, { url: 'https://docs.example.com/x?token=s3cret' })
  assert.equal(r.title, 'Docs & Guides')
  assert.match(String(r.text), /Install\s+Run npm i <now>\./)
  assert.ok(!String(r.text).includes('evil'))
  assert.equal(r.untrusted, true)
  assert.equal(r.status, 200)
})

test('web_fetch: json passes through, the cap truncates and says so, binary is refused with a reason', async () => {
  const json = await runTool(
    { fetch: spy(html('{"ok":true}', 'application/json')).fetchImpl },
    { url: 'https://api.example.com/' },
  )
  assert.equal(json.text, '{"ok":true}')
  const long = await runTool(
    { fetch: spy(html('abcdefghij'.repeat(500), 'text/plain')).fetchImpl },
    { url: 'https://example.com/', maxChars: 300 },
  )
  assert.deepEqual([String(long.text).length, long.truncated], [300, true])
  await assert.rejects(
    runTool({ fetch: spy(html('PNG', 'image/png')).fetchImpl }, { url: 'https://example.com/i' }),
    /reads text.*image\/png/,
  )
})

test('web_fetch: events say what happened - origin and path only, never the query string', async () => {
  const events: AgentEvent[] = []
  await runTool(
    { fetch: spy(html('hi', 'text/plain')).fetchImpl },
    { url: 'https://example.com/p?token=s3cret' },
    events,
  )
  await assert.rejects(runTool({}, { url: 'https://localhost/p?token=s3cret' }, events))
  const [ok, no] = events.filter((e) => e.type === 'egress.request')
  assert.ok(
    ok?.type === 'egress.request' &&
      ok.allowed &&
      ok.status === 200 &&
      ok.url === 'https://example.com/p',
  )
  assert.ok(
    no?.type === 'egress.request' && !no.allowed && /^denied-address:/.test(no.reason ?? ''),
  )
  assert.ok(!JSON.stringify(events).includes('s3cret'))
})

test('web_fetch: read-only for the consent gate only when the policy names the hosts', () => {
  assert.equal(isReadOnlyTool(createWebFetchTool({ policy: {} })), false)
  assert.equal(isReadOnlyTool(createWebFetchTool({ policy: { deny: ['x.example'] } })), false)
  assert.equal(
    isReadOnlyTool(createWebFetchTool({ policy: { allow: ['docs.example.com'] } })),
    true,
  )
  assert.equal(createEgressTools(undefined), undefined)
  assert.equal(createEgressTools(false), undefined)
  assert.deepEqual(Object.keys(createEgressTools(true) ?? {}), [WEB_FETCH_TOOL])
})

test('htmlToText: no scripts, styles, comments or markup; entities decoded; odd ones left alone', () => {
  const t = htmlToText(
    '<style>p{}</style><!-- c --><p>a &amp; b &#169; &#x41;&nbsp;c</p><script>x()</script>',
  )
  assert.equal(t.text, 'a & b © A c')
  assert.equal(htmlToText('a &unknown; &#99999999;').text, 'a &unknown; &#99999999;')
})

// ── the agent ────────────────────────────────────────────────────────────────

const plan = JSON.stringify({ thought: 'read it', steps: [{ description: 'Read the page' }] })
const reader =
  (url: string) =>
  (info: CallInfo): Reply => {
    switch (stageOf(info)) {
      case 'planner':
        return { text: plan }
      case 'executor':
        return info.toolResults === 0 && info.tools.includes('web_fetch')
          ? { toolCalls: [{ name: 'web_fetch', args: { url } }] }
          : { text: 'Read.' }
      default:
        return { text: 'Done.' }
    }
  }

test('agent: without egress the model is not offered a fetch', async () => {
  const model = scriptedModel(reader('https://docs.example.com/'))
  const agent = await createAgent({ model: model.model })
  const result = await agent.run('read the page')
  assert.ok(
    model.calls
      .filter((c) => stageOf(c) === 'executor')
      .every((c) => !c.tools.includes('web_fetch')),
  )
  assert.equal(result.trace[0].toolCalls.length, 0)
})

test('agent: with egress the model reads an allowed page; a refused one comes back as an error it can read', async () => {
  const { seen, fetchImpl } = spy(
    html('<html><title>T</title><body>the answer is 42</body></html>'),
  )
  const model = scriptedModel(reader('https://docs.example.com/guide'))
  const agent = await createAgent({
    model: model.model,
    egress: { allow: ['docs.example.com'], fetch: fetchImpl },
  })
  const events: AgentEvent[] = []
  const result = await agent.run('read the page', { onEvent: (e) => events.push(e) })
  const call = result.trace[0].toolCalls[0]
  assert.equal(call.ok, true)
  assert.equal((call.output as { text: string }).text, 'the answer is 42')
  assert.equal(seen.length, 1)
  assert.ok(events.some((e) => e.type === 'egress.request' && e.allowed))

  // Same agent shape, but the model asks for something outside the allow list.
  const other = spy(html('nope'))
  const model2 = scriptedModel(reader('https://evil.example.net/'))
  const agent2 = await createAgent({
    model: model2.model,
    egress: { allow: ['docs.example.com'], fetch: other.fetchImpl },
  })
  const r2 = await agent2.run('read the page')
  assert.equal(r2.trace[0].toolCalls[0].ok, false)
  assert.match(
    String((r2.trace[0].toolCalls[0].output as Error).message ?? r2.trace[0].toolCalls[0].output),
    /not on the allow list/,
  )
  assert.equal(other.seen.length, 0, 'the request was never made')
})

test('agent: a localhost URL is refused with the defaults, and a tool of your own named web_fetch wins', async () => {
  const guard = spy(html('secret'))
  const model = scriptedModel(reader('https://localhost/admin'))
  const agent = await createAgent({ model: model.model, egress: { fetch: guard.fetchImpl } })
  const result = await agent.run('read the page')
  assert.equal(result.trace[0].toolCalls[0].ok, false)
  assert.equal(guard.seen.length, 0)

  const { defineTool } = await import('../dist/index.js')
  const { z } = await import('zod')
  const mine = defineTool({
    description: 'mine',
    inputSchema: z.object({ url: z.string() }),
    execute: async () => ({ text: 'from my own tool' }),
  })
  const model2 = scriptedModel(reader('https://example.com/'))
  const agent2 = await createAgent({
    model: model2.model,
    egress: true,
    tools: { web_fetch: mine },
  })
  const r2 = await agent2.run('read it')
  assert.deepEqual(r2.trace[0].toolCalls[0].output, { text: 'from my own tool' })
})
