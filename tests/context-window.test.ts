import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import {
  ContextWindowExceededError,
  contextOverflowOf,
  createAgent,
  defineTool,
  fitCompactionToWindow,
  resolveCompaction,
  supportsImages,
  supportsPdf,
  webLLMContextWindow,
  withWebLLMContextWindow,
  type AgentEvent,
} from '../dist/index.js'
import { scriptedModel, stageOf, type CallInfo, type Reply } from './helpers/scripted-model.ts'

const QWEN = 'Qwen3.5-0.8B-q4f16_1-MLC'

/** A scripted model dressed as a loaded WebLLM model with the given window. */
const webLLMModel = (route: (info: CallInfo) => Reply, window = 4096, modelId = QWEN) => {
  const scripted = scriptedModel(route)
  Object.defineProperty(scripted.model, 'provider', { value: 'web-llm' })
  Object.defineProperty(scripted.model, 'modelId', { value: modelId })
  Object.assign(scripted.model, {
    engine: { loadedModelIdToPipeline: new Map([[modelId, { contextWindowSize: window }]]) },
  })
  return scripted
}

const answer = (info: CallInfo): Reply => {
  const stage = stageOf(info)
  // Local models run the prompted path: the planner answers {"plan": [...]}.
  if (stage === 'planner') return { text: JSON.stringify({ reply: '', plan: ['Look it up'] }) }
  return { text: 'Done.' }
}

const WEBLLM_OVERFLOW =
  'WebLLM generation failed: Prompt tokens exceed context window size: number of prompt tokens: 4124; context window size: 4096Consider shortening the prompt, or increase `context_window_size`, or using sliding window via `sliding_window_size`.'

test('withWebLLMContextWindow overrides one model of an app config', () => {
  const base = {
    model_list: [
      { model_id: QWEN, model_lib: 'q.wasm', overrides: { context_window_size: 4096, x: 1 } },
      { model_id: 'other', model_lib: 'o.wasm', overrides: { context_window_size: 4096 } },
    ],
    useIndexedDBCache: false,
  }
  const next = withWebLLMContextWindow(base, QWEN, 32768)
  assert.equal(next.model_list[0].overrides.context_window_size, 32768)
  assert.equal(next.model_list[0].overrides.x, 1)
  assert.equal(next.model_list[1].overrides.context_window_size, 4096)
  assert.equal(next.useIndexedDBCache, false)
  assert.equal(base.model_list[0].overrides.context_window_size, 4096, 'the input is not mutated')
})

test('webLLMContextWindow reads the engine, then the config, then WebLLM defaults', () => {
  assert.equal(webLLMContextWindow({ provider: 'google', modelId: 'gemini' }), undefined)
  assert.equal(webLLMContextWindow(webLLMModel(answer, 16384).model), 16384)
  const configured = {
    provider: 'web-llm',
    modelId: QWEN,
    config: {
      options: {
        engineConfig: {
          appConfig: { model_list: [{ model_id: QWEN, overrides: { context_window_size: 8192 } }] },
        },
      },
    },
  }
  assert.equal(webLLMContextWindow(configured), 8192)
  assert.equal(webLLMContextWindow({ provider: 'web-llm', modelId: QWEN }), 4096)
  assert.equal(
    webLLMContextWindow({ provider: 'web-llm', modelId: 'gemma-2-2b-it-q4f16_1-MLC-1k' }),
    1024,
  )
})

test('fitCompactionToWindow caps the window and everything sized from it', () => {
  const configured = { contextWindowTokens: 8000, thresholdTokens: 6000 }
  const fitted = fitCompactionToWindow(resolveCompaction(configured), configured, 4096)
  assert.equal(fitted.contextWindowTokens, 4096)
  assert.equal(fitted.thresholdTokens, 2048)
  assert.equal(fitted.clearToolResultsAfterTokens, 1024)
  assert.equal(fitted.maxToolOutputChars, 4096)
  assert.equal(fitted.keepToolResults, 1)
  // A larger model window does not raise what the host chose.
  const roomy = fitCompactionToWindow(resolveCompaction(configured), configured, 32768)
  assert.equal(roomy.contextWindowTokens, 8000)
  // No known model window: the configuration stands as it is.
  const cloud = resolveCompaction(configured)
  assert.equal(fitCompactionToWindow(cloud, configured, undefined), cloud)
  // "Never" stays never.
  const never = { clearToolResultsAfterTokens: 0, maxToolOutputChars: 0 }
  const kept = fitCompactionToWindow(resolveCompaction(never), never, 4096)
  assert.equal(kept.clearToolResultsAfterTokens, 0)
  assert.equal(kept.maxToolOutputChars, 0)
})

test('contextOverflowOf turns provider "too long" errors into one clear error', () => {
  const webllm = contextOverflowOf(new Error(WEBLLM_OVERFLOW), {
    provider: 'web-llm',
    modelId: QWEN,
  })
  assert.ok(webllm instanceof ContextWindowExceededError)
  assert.equal(webllm.promptTokens, 4124)
  assert.equal(webllm.contextWindowTokens, 4096)
  assert.match(
    webllm.message,
    /no longer fits the context window of "Qwen3\.5-0\.8B.*4124 tokens; the window is 4096/,
  )
  assert.ok(
    contextOverflowOf(new Error("This model's maximum context length is 128000 tokens"), 'gpt'),
  )
  assert.ok(
    contextOverflowOf(new Error('prompt is too long: 210000 tokens > 200000 maximum'), 'claude'),
  )
  assert.equal(
    contextOverflowOf(new Error('Resource has been exhausted (e.g. check quota).'), 'g'),
    undefined,
  )
})

test('the agent never assumes more than a local model’s window', async () => {
  const { model } = webLLMModel(answer, 4096)
  const agent = await createAgent({
    model,
    compaction: { contextWindowTokens: 8000, thresholdTokens: 6000 },
  })
  assert.equal(agent.contextWindowTokens, 4096)
  // Without any compaction config the model's window is used too.
  const bare = await createAgent({ model: webLLMModel(answer, 32768).model })
  assert.equal(bare.contextWindowTokens, 32768)
  // A cloud model keeps the configured window.
  const cloud = await createAgent({
    model: scriptedModel(answer).model,
    compaction: { contextWindowTokens: 8000 },
  })
  assert.equal(cloud.contextWindowTokens, 8000)
})

test('auto tool selection searches once tool definitions would crowd the window', async () => {
  const wordy = (i: number) =>
    defineTool({
      description: `Tool ${i}. ${'Explains at length what it does and when to call it. '.repeat(12)}`,
      inputSchema: z.object({
        query: z.string().describe('What to look for, in detail. '.repeat(6)),
        limit: z.number().optional().describe('How many results to return at most.'),
      }),
      execute: async () => 'ok',
    })
  const tools = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tool_${i}`, wordy(i)]))
  const small = await createAgent({ model: webLLMModel(answer, 4096).model, tools })
  assert.equal(small.toolStrategy, 'search', 'eight wordy tools fill a quarter of 4k')
  const roomy = await createAgent({ model: webLLMModel(answer, 32768).model, tools })
  assert.equal(roomy.toolStrategy, 'all')
  const cloud = await createAgent({ model: scriptedModel(answer).model, tools })
  assert.equal(cloud.toolStrategy, 'all')
})

test('a prompt the model refuses for length surfaces as the clear error', async () => {
  const { model } = webLLMModel((info) => {
    if (stageOf(info) === 'executor') throw new Error(WEBLLM_OVERFLOW)
    return answer(info)
  })
  const lookup = defineTool({
    description: 'Look something up.',
    inputSchema: z.object({ q: z.string() }),
    execute: async () => 'ok',
  })
  const agent = await createAgent({ model, tools: { lookup }, maxIterations: 1, replan: false })
  const events: AgentEvent[] = []
  await agent.run('Look up the weather in Paris', { onEvent: (e) => events.push(e) })
  const errors = events.filter((e) => e.type === 'error') as { error: string }[]
  assert.ok(errors.length > 0)
  assert.match(
    errors[0].error,
    /no longer fits the context window.*4124 tokens; the window is 4096/,
  )
})

test('a local vision model takes images; other local models and PDFs do not', async () => {
  const vision = { provider: 'web-llm', modelId: 'Phi-3.5-vision-instruct-q4f16_1-MLC' }
  assert.equal(supportsImages(vision), true)
  assert.equal(supportsPdf(vision), false)
  assert.equal(supportsImages({ provider: 'web-llm', modelId: QWEN }), false)
  const agent = await createAgent({
    model: webLLMModel(answer, 4096, 'Phi-3.5-vision-instruct-q4f16_1-MLC').model,
  })
  assert.equal(agent.capabilities.images, true)
  assert.equal(agent.capabilities.pdf, false)
  const text = await createAgent({ model: webLLMModel(answer).model })
  assert.equal(text.capabilities.images, false)
})
