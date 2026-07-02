import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveStage, buildModelFromStage, MemoryCredentialStore } from '../dist/index.js'

const fakeModel = { specificationVersion: 'v3', provider: 'mock', modelId: 'm' }

test('resolveStage: a direct model passes through untouched', () => {
  const r = resolveStage(fakeModel as never, undefined, 'model')
  assert.equal(r.type, 'direct')
})

test('resolveStage: a partial override inherits base provider + credentials', () => {
  const base = { providerType: 'openai', model: 'gpt-4o', credentialRef: 'k' } as const
  const r = resolveStage(base, { model: 'gpt-4o-mini' }, 'planner')
  assert.equal(r.type, 'spec')
  if (r.type !== 'spec') return
  assert.equal(r.spec.providerType, 'openai')
  assert.equal(r.spec.model, 'gpt-4o-mini')
  assert.equal(r.spec.credentialRef, 'k')
})

test('resolveStage: a cross-provider override without its own key throws', () => {
  const base = { providerType: 'openai', model: 'gpt-4o', credentialRef: 'k' } as const
  assert.throws(
    () => resolveStage(base, { providerType: 'anthropic', model: 'claude-haiku-4-5' }, 'planner'),
    /cross-provider/,
  )
})

test('resolveStage: openai-compatible requires a baseURL', () => {
  assert.throws(
    () => resolveStage({ providerType: 'openai-compatible', model: 'm' }, undefined, 'model'),
    /baseURL/,
  )
})

test('buildModelFromStage: an openai spec with an inline key builds a model', async () => {
  const r = resolveStage(
    { providerType: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-test' },
    undefined,
    'model',
  )
  const m = await buildModelFromStage(r)
  assert.equal(typeof m === 'object' && m !== null && 'specificationVersion' in m, true)
})

test('buildModelFromStage: a credentialRef is resolved via the CredentialStore', async () => {
  const creds = new MemoryCredentialStore({ openaiKey: 'sk-fromvault' })
  const r = resolveStage(
    { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'openaiKey' },
    undefined,
    'model',
  )
  const m = await buildModelFromStage(r, creds)
  assert.ok(m)
})

test('buildModelFromStage: a missing credentialRef surfaces a clear error', async () => {
  const creds = new MemoryCredentialStore()
  const r = resolveStage(
    { providerType: 'openai', model: 'gpt-4o-mini', credentialRef: 'absent' },
    undefined,
    'model',
  )
  await assert.rejects(() => buildModelFromStage(r, creds), /no API key/)
})
