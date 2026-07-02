import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MockLanguageModelV3 } from 'ai/test'
import { preloadWebLLMModel, unloadWebLLMModel } from '../dist/index.js'

const usage = {
  inputTokens: {
    total: 1,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: 1,
  totalTokens: 2,
  reasoningTokens: undefined,
  cachedInputTokens: undefined,
} as never

test('preloadWebLLMModel forces one tiny generation (engine init path)', async () => {
  let calls = 0
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      calls += 1
      return {
        content: [{ type: 'text', text: 'ok' }],
        finishReason: 'stop' as const,
        usage,
        warnings: [],
      }
    },
  })
  await preloadWebLLMModel(model)
  assert.equal(calls, 1)
})

test('unloadWebLLMModel calls the private engine.unload when present', async () => {
  let unloaded = 0
  const model = new MockLanguageModelV3({}) as unknown as Record<string, unknown>
  model.engine = {
    unload: async () => {
      unloaded += 1
    },
  }
  await unloadWebLLMModel(model as never)
  assert.equal(unloaded, 1)
})

test('unloadWebLLMModel is a safe no-op without an engine or on a throwing one', async () => {
  const bare = new MockLanguageModelV3({})
  await assert.doesNotReject(unloadWebLLMModel(bare))

  const throwing = new MockLanguageModelV3({}) as unknown as Record<string, unknown>
  throwing.engine = {
    unload: async () => {
      throw new Error('boom')
    },
  }
  await assert.doesNotReject(unloadWebLLMModel(throwing as never))
})
