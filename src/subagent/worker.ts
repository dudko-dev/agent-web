import { dynamicTool, jsonSchema, type LanguageModel, type ToolSet } from 'ai'
import { createAgent } from '../agent/runner.js'
import type { BrowserAgentConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import { buildModelFromStage, resolveStage } from '../providers/registry.js'
import type { ProviderModelSpec } from '../providers/types.js'
import { MemoryCredentialStore } from '../secrets/store.js'
import { markReadOnly } from '../tools/approval.js'
import {
  safePost,
  type MessageEndpoint,
  type ParentToWorker,
  type ProxiedToolSpec,
} from './protocol.js'

export interface ServeSubagentOptions {
  /**
   * Build the child's model from its spec. Pass one when your bundler can't
   * resolve the core's dynamic provider imports inside a worker (Vite): import
   * the provider factories statically in the worker module and build here.
   * Default: the core registry (dynamic import of the optional peer).
   */
  resolveModel?: (spec: ProviderModelSpec) => LanguageModel | Promise<LanguageModel>
  /**
   * Worker-local tools — they run in the worker thread, so CPU-heavy work
   * (search, parsing, simulation) never blocks the page.
   */
  tools?: ToolSet
  /** The worker's message endpoint (default: the worker global scope). */
  scope?: MessageEndpoint
}

// The key arrives with the task and lives only in this in-memory store, so
// the registry builds the model without the inline-key warning.
const SUBAGENT_REF = '__subagent__'

const defaultResolveModel = (spec: ProviderModelSpec): Promise<LanguageModel> => {
  const { apiKey, ...rest } = spec
  const credentials = apiKey ? new MemoryCredentialStore({ [SUBAGENT_REF]: apiKey }) : undefined
  return buildModelFromStage(
    resolveStage(apiKey ? { ...rest, credentialRef: SUBAGENT_REF } : rest, undefined, 'subagent'),
    credentials,
  )
}

/**
 * Serve subagent tasks inside a Web Worker. Call it once at the top of your
 * worker module; the parent's `createSubagentTool({ worker })` posts a task,
 * this builds a child agent (worker-local tools + the parent's host tools
 * proxied over RPC), runs it, streams its events back and answers with the
 * final text.
 *
 * ```ts
 * // agent.worker.ts
 * import { serveSubagentWorker } from '@dudko.dev/agent-web'
 * import { createGoogleGenerativeAI } from '@ai-sdk/google'
 * serveSubagentWorker({
 *   resolveModel: (spec) => createGoogleGenerativeAI({ apiKey: spec.apiKey })(spec.model),
 *   tools: { heavy_search: defineTool({ … }) },
 * })
 * ```
 */
export const serveSubagentWorker = (opts: ServeSubagentOptions = {}): void => {
  const scope = opts.scope ?? (globalThis as unknown as MessageEndpoint)
  let controller: AbortController | undefined
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let callSeq = 0

  const proxy = (spec: ProxiedToolSpec) => {
    const t = dynamicTool({
      description: spec.description,
      inputSchema: jsonSchema(spec.inputSchema as Parameters<typeof jsonSchema>[0]),
      execute: (input, options) =>
        new Promise((resolve, reject) => {
          const callId = `call-${(callSeq += 1)}`
          const signal = options?.abortSignal
          if (signal?.aborted) return reject(new Error('aborted'))
          pending.set(callId, { resolve, reject })
          signal?.addEventListener(
            'abort',
            () => {
              if (pending.delete(callId)) reject(new Error('aborted'))
            },
            { once: true },
          )
          safePost(scope, { type: 'tool-call', callId, name: spec.name, input })
        }),
    })
    return spec.readOnly ? markReadOnly(t) : t
  }

  const run = async (msg: Extract<ParentToWorker, { type: 'run' }>): Promise<void> => {
    controller = new AbortController()
    let runError: string | undefined
    try {
      const { model: spec, ...rest } = msg.config as { model: ProviderModelSpec } & Record<
        string,
        unknown
      >
      const model = await (opts.resolveModel ?? defaultResolveModel)(spec)
      const proxied = Object.fromEntries(msg.proxied.map((p) => [p.name, proxy(p)]))
      const agent = await createAgent({
        ...(rest as Partial<BrowserAgentConfig>),
        model,
        tools: { ...opts.tools, ...proxied },
      })
      const result = await agent.run(msg.task, {
        signal: controller.signal,
        onEvent: (event: AgentEvent) => {
          if (event.type === 'error' && event.phase === 'run') runError = event.error
          safePost(scope, { type: 'event', event })
        },
      })
      if (result.stopped) safePost(scope, { type: 'error', error: 'aborted' })
      else if (runError) safePost(scope, { type: 'error', error: runError })
      else
        safePost(scope, {
          type: 'done',
          text: result.final,
          usage: result.usage,
          steps: result.steps,
        })
    } catch (err) {
      safePost(scope, { type: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }

  scope.addEventListener('message', (ev: { data: unknown }) => {
    const msg = ev.data as ParentToWorker
    switch (msg?.type) {
      case 'run':
        void run(msg)
        break
      case 'abort':
        controller?.abort()
        for (const [id, p] of pending) {
          pending.delete(id)
          p.reject(new Error('aborted'))
        }
        break
      case 'tool-result': {
        const p = pending.get(msg.callId)
        if (!p) break
        pending.delete(msg.callId)
        if (msg.ok) p.resolve(msg.output)
        else
          p.reject(
            new Error(typeof msg.output === 'string' ? msg.output : JSON.stringify(msg.output)),
          )
        break
      }
    }
  })
}
