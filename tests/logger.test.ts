import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from '../dist/index.js'

const collector = () => {
  const seen: { level: string; args: unknown[] }[] = []
  return {
    seen,
    sink: {
      error: (...args: unknown[]) => seen.push({ level: 'error', args }),
      warn: (...args: unknown[]) => seen.push({ level: 'warn', args }),
      info: (...args: unknown[]) => seen.push({ level: 'info', args }),
      debug: (...args: unknown[]) => seen.push({ level: 'debug', args }),
    },
  }
}

test('logger filters below the level and prefixes messages', () => {
  const { seen, sink } = collector()
  const log = createLogger('warn', sink)
  log.debug('hidden')
  log.info('hidden')
  log.warn('shown')
  log.error('shown too')
  assert.deepEqual(
    seen.map((s) => s.level),
    ['warn', 'error'],
  )
  assert.equal(seen[0].args[0], '[agent-web]')
  assert.equal(seen[0].args[1], 'shown')
})

test("logger 'debug' passes everything, 'silent' nothing", () => {
  const all = collector()
  const log = createLogger('debug', all.sink)
  log.debug('a')
  log.info('b')
  log.warn('c')
  log.error('d')
  assert.equal(all.seen.length, 4)

  const none = collector()
  const quiet = createLogger('silent', none.sink)
  quiet.error('never')
  assert.equal(none.seen.length, 0)
})
