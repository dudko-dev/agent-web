import { asSchema, jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import type { IUsage } from '../agent/loop-types.js'
import { createAgent, type Agent } from '../agent/runner.js'
import type { BrowserAgentConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import { clip } from '../llm/util.js'
import type { ProviderModelSpec } from '../providers/types.js'
import type { CredentialStore } from '../secrets/store.js'
import { isReadOnlyTool } from '../tools/approval.js'
import type { AgentTool } from '../tools/types.js'
import { toolRunContextOf } from '../tools/wrap.js'
import {
  safePost,
  toCloneable,
  type ProxiedToolSpec,
  type WorkerLike,
  type WorkerToParent,
} from './protocol.js'

/** The serializable slice of BrowserAgentConfig a worker subagent can be built from. */
export type SubagentWorkerConfig = Pick<
  BrowserAgentConfig,
  | 'clientName'
  | 'systemPrompt'
  | 'availableTools'
  | 'excludedTools'
  | 'toolMode'
  | 'toolSelectionStrategy'
  | 'toolSearchThreshold'
  | 'skills'
  | 'maxIterations'
  | 'maxStepsPerTask'
  | 'maxRevisions'
  | 'maxToolCalls'
  | 'maxPlanSteps'
  | 'chatTimeoutMs'
  | 'budgets'
  | 'limits'
  | 'temperature'
  | 'thinking'
  | 'stageThinking'
  | 'promptCaching'
  | 'compaction'
  | 'replan'
  | 'synthesize'
  | 'logLevel'
> & {
  /** The child's model, resolved inside the worker (by its `resolveModel`, or the registry). */
  model: ProviderModelSpec
  /** Consent policy inside the worker — mode and rules only (no callbacks cross threads). */
  toolApproval?: { mode?: 'autopilot' | 'read-only'; rules?: Record<string, 'allow' | 'deny'> }
}

/**
 * A named way to run the same subagent. Its fields are laid OVER the base
 * `config` / `workerConfig`, field by field and shallow: a profile's `limits`
 * replaces the base's `limits`, it is not merged into it. The PARENT model picks
 * one per call with the optional `profile` argument; the host decides what each
 * name means — a cheap model for a quick lookup, a strong one with thinking for
 * a hard question, a different system prompt, a narrower tool set.
 */
export interface SubagentProfile {
  /** When to pick this profile — shown to the parent model, which chooses by it. */
  description: string
  /** In-process subagent: fields laid over `config` (model, thinking, limits, systemPrompt, tools …). */
  config?: Partial<BrowserAgentConfig>
  /** Worker subagent: fields laid over `workerConfig`. */
  workerConfig?: Partial<SubagentWorkerConfig>
}

export interface SubagentToolOptions {
  /** Label for events and logs (the tool's KEY in your ToolSet is up to you). */
  name: string
  /** What the subagent is for — the parent model reads this to decide when to delegate. */
  description: string
  /** In-process subagent: a full config (models, tools, …) for the child agent. */
  config?: BrowserAgentConfig
  /**
   * Worker subagent: builds a fresh Worker per delegated task, e.g.
   * `() => new Worker(new URL('./agent.worker.ts', import.meta.url), { type: 'module' })`.
   * The worker module calls `serveSubagentWorker()`.
   */
  worker?: () => WorkerLike
  /** Worker subagent: the child's serializable config. */
  workerConfig?: SubagentWorkerConfig
  /**
   * Resolves `workerConfig.model.credentialRef` in the main thread; the key is
   * posted to the worker for that one task and never stored there.
   */
  credentials?: CredentialStore
  /**
   * Host tools the subagent may call. In-process they are merged into the
   * child's tools; with a worker they stay in the main thread and are called
   * over RPC. Either way each call passes the PARENT's consent gate.
   */
  tools?: ToolSet
  /** Parallel delegations allowed at once (default 4); extra calls queue. */
  maxConcurrent?: number
  /** Give up on one delegated task after this many ms (default: none). */
  timeoutMs?: number
  /** Cap on the text handed back to the parent model (default 8000 chars). */
  outputMaxChars?: number
  /** Mark the tool read-only for the parent's consent gate (default false). */
  readOnly?: boolean
  /**
   * Named variants the parent model chooses between per call. The tool gains an
   * optional `profile` argument (one of these names); leaving it out runs the base
   * config. The child's context is still just `task` — a profile that changes
   * `systemPrompt`, `skills` or `tools` is how a child gets a different one.
   * Without profiles the tool is exactly what it was.
   */
  profiles?: Record<string, SubagentProfile>
}

interface ChildOutcome {
  text: string
  usage: IUsage
}

const abortError = (): Error => {
  const e = new Error('The subagent was aborted')
  e.name = 'AbortError'
  return e
}

/** A tiny FIFO semaphore: at most `size` holders, abort-aware waiting. */
const createSemaphore = (size: number) => {
  let active = 0
  const queue: (() => void)[] = []
  return async (signal?: AbortSignal): Promise<() => void> => {
    if (active >= size) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          const i = queue.indexOf(go)
          if (i >= 0) queue.splice(i, 1)
          reject(abortError())
        }
        queue.push(go)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
    active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      active -= 1
      queue.shift()?.()
    }
  }
}

let seq = 0

/**
 * Expose a subagent as a tool: the parent delegates `{ task }`, the child runs
 * its own plan → execute → synthesize loop — in this thread, or isolated in a
 * Web Worker — and its final answer comes back as the tool result. Several
 * delegations in one model step run in parallel (bounded by `maxConcurrent`).
 *
 * The parent sees `subagent.start` / `subagent.event` / `subagent.complete` /
 * `subagent.error` events, and the child's tokens are charged to the parent
 * run (a `usage` event with phase 'subagent'), so the parent's limits apply.
 */
export const createSubagentTool = (opts: SubagentToolOptions): AgentTool => {
  if (!opts.config === !opts.worker) {
    throw new Error(
      `subagent "${opts.name}": pass exactly one of \`config\` (in-process) or \`worker\``,
    )
  }
  if (opts.worker && !opts.workerConfig) {
    throw new Error(`subagent "${opts.name}": a worker subagent needs \`workerConfig\``)
  }
  const profiles = opts.profiles ?? {}
  const profileNames = Object.keys(profiles)
  for (const [pname, p] of Object.entries(profiles)) {
    if (!pname.trim()) throw new Error(`subagent "${opts.name}": a profile needs a non-empty name`)
    if (!p || typeof p.description !== 'string' || !p.description.trim()) {
      throw new Error(
        `subagent "${opts.name}": profile "${pname}" needs a description — the parent model chooses by it`,
      )
    }
    if (opts.worker && p.config) {
      throw new Error(
        `subagent "${opts.name}": profile "${pname}" sets \`config\`, which does not apply to a worker subagent — use \`workerConfig\``,
      )
    }
    if (!opts.worker && p.workerConfig) {
      throw new Error(
        `subagent "${opts.name}": profile "${pname}" sets \`workerConfig\`, which does not apply to an in-process subagent — use \`config\``,
      )
    }
  }
  /** An empty value counts as "not given": models do send `profile: ""`. */
  const pickProfile = (name: string | undefined): SubagentProfile | undefined => {
    if (!name) return undefined
    // hasOwn, not `in`: a model answering "constructor" must not resolve to Object's.
    if (!Object.hasOwn(profiles, name)) {
      throw new Error(
        `subagent "${opts.name}": unknown profile "${name}" — choose one of: ${profileNames.join(', ')}`,
      )
    }
    return profiles[name]
  }
  const acquire = createSemaphore(Math.max(1, opts.maxConcurrent ?? 4))
  const outputMax = opts.outputMaxChars ?? 8_000

  const gatedHostTools = (
    approve: ((name: string, input: unknown, readOnly: boolean) => Promise<void>) | undefined,
  ): ToolSet =>
    Object.fromEntries(
      Object.entries(opts.tools ?? {}).map(([name, t]) => {
        const execute = (t as { execute?: (i: unknown, o: unknown) => unknown }).execute
        if (typeof execute !== 'function' || !approve) return [name, t]
        return [
          name,
          {
            ...t,
            execute: async (input: unknown, o: unknown) => {
              await approve(name, input, isReadOnlyTool(t as Tool))
              return execute.call(t, input, o)
            },
          },
        ]
      }),
    )

  const runInProcess = async (
    task: string,
    signal: AbortSignal | undefined,
    forward: (e: AgentEvent) => void,
    hostTools: ToolSet,
    profile: SubagentProfile | undefined,
  ): Promise<ChildOutcome> => {
    const config = { ...(opts.config as BrowserAgentConfig), ...profile?.config }
    // One child per task: its host tools are gated by THIS parent run. A
    // direct model (incl. a loaded WebLLM engine) is passed through, not rebuilt.
    const agent: Agent = await createAgent({ ...config, tools: { ...config.tools, ...hostTools } })
    let runError: string | undefined
    const result = await agent.run(task, {
      signal,
      onEvent: (e) => {
        if (e.type === 'error' && e.phase === 'run') runError = e.error
        forward(e)
      },
    })
    if (result.stopped) throw abortError()
    if (runError) throw new Error(runError)
    return { text: result.final, usage: result.usage }
  }

  const proxiedSpecs = async (): Promise<ProxiedToolSpec[]> =>
    Promise.all(
      Object.entries(opts.tools ?? {}).map(async ([name, t]) => ({
        name,
        description: typeof t.description === 'string' ? t.description : '',
        inputSchema: toCloneable(await asSchema(t.inputSchema as never).jsonSchema),
        readOnly: isReadOnlyTool(t as Tool),
      })),
    )

  const workerConfigFor = async (
    profile: SubagentProfile | undefined,
  ): Promise<Record<string, unknown>> => {
    const cfg = { ...opts.workerConfig, ...profile?.workerConfig } as SubagentWorkerConfig
    let model: ProviderModelSpec = { ...cfg.model }
    if (model.credentialRef && !model.apiKey && opts.credentials) {
      const apiKey = await opts.credentials.getApiKey(model.credentialRef)
      if (!apiKey)
        throw new Error(`no API key stored under "${model.credentialRef}" for the subagent`)
      model = { ...model, apiKey }
    }
    return toCloneable({ ...cfg, model }) as Record<string, unknown>
  }

  const runInWorker = async (
    task: string,
    signal: AbortSignal | undefined,
    forward: (e: AgentEvent) => void,
    hostTools: ToolSet,
    profile: SubagentProfile | undefined,
  ): Promise<ChildOutcome> => {
    if (signal?.aborted) throw abortError()
    const [config, proxied] = await Promise.all([workerConfigFor(profile), proxiedSpecs()])
    // Stopped while the config was being resolved (a credential read, the schemas): the
    // abort event has already fired, so a listener added now would wait for nothing.
    if (signal?.aborted) throw abortError()
    const worker = (opts.worker as () => WorkerLike)()
    return new Promise<ChildOutcome>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        worker.removeEventListener?.('message', onMessage)
        worker.removeEventListener?.('error', onError)
        // A worker is single-use: terminating frees its memory and any engine.
        worker.terminate?.()
        fn()
      }
      const onAbort = (): void => {
        safePost(worker, { type: 'abort' })
        finish(() => reject(abortError()))
      }
      const onError = (ev: { message?: string }): void =>
        finish(() => reject(new Error(`subagent worker failed: ${ev?.message ?? 'unknown error'}`)))
      const callHostTool = async (callId: string, name: string, input: unknown): Promise<void> => {
        const t = hostTools[name] as { execute?: (i: unknown, o: unknown) => unknown } | undefined
        try {
          if (!t || typeof t.execute !== 'function') throw new Error(`unknown host tool "${name}"`)
          const output = await t.execute(input, {
            toolCallId: callId,
            messages: [],
            abortSignal: signal,
          })
          if (!settled) safePost(worker, { type: 'tool-result', callId, ok: true, output })
        } catch (err) {
          const output = err instanceof Error ? err.message : String(err)
          if (!settled) safePost(worker, { type: 'tool-result', callId, ok: false, output })
        }
      }
      const onMessage = (ev: { data: unknown }): void => {
        const msg = ev.data as WorkerToParent
        switch (msg?.type) {
          case 'event':
            forward(msg.event)
            break
          case 'tool-call':
            void callHostTool(msg.callId, msg.name, msg.input)
            break
          case 'done':
            finish(() => resolve({ text: msg.text, usage: msg.usage }))
            break
          case 'error':
            finish(() => reject(new Error(msg.error)))
            break
        }
      }
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onError)
      signal?.addEventListener('abort', onAbort, { once: true })
      safePost(worker, { type: 'run', task, config, proxied })
    })
  }

  // The profiles are described in the tool's DESCRIPTION, not only on the schema property:
  // a prompted-mode model reads the catalogue and a one-line shape hint, and would
  // otherwise never learn what "deep" is for.
  const description = profileNames.length
    ? `${opts.description}\n\nOptional \`profile\` (omit it for the default):\n${profileNames
        .map((n) => `- ${n}: ${profiles[n].description}`)
        .join('\n')}`
    : opts.description
  const t = tool({
    description,
    inputSchema: jsonSchema<{ task: string; profile?: string }>({
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'A complete, self-contained task: the subagent sees nothing of your context except this text.',
        },
        ...(profileNames.length
          ? {
              profile: {
                type: 'string',
                enum: profileNames,
                description:
                  "One of this tool's profiles, described above. Omit it for the default.",
              },
            }
          : {}),
      },
      required: ['task'],
      additionalProperties: false,
    }),
    execute: async ({ task, profile: profileName }, options) => {
      // Before taking a slot or announcing a start: an unknown name is a tool error
      // the model can correct, not a delegation that began and died.
      const profile = pickProfile(profileName)
      const runCtx = toolRunContextOf(options)
      const parentSignal =
        (options as { abortSignal?: AbortSignal } | undefined)?.abortSignal ?? runCtx?.signal
      const id = `${opts.name}-${(seq += 1)}`
      const release = await acquire(parentSignal)
      const emit = (e: AgentEvent) => runCtx?.emit(e)
      // One controller per task: the parent's abort and our own deadline both
      // stop the child (and its worker) the same way.
      const controller = new AbortController()
      const onParentAbort = () => controller.abort()
      parentSignal?.addEventListener('abort', onParentAbort, { once: true })
      if (parentSignal?.aborted) controller.abort()
      let timedOut = false
      let stoppedByUser = false
      const timer =
        opts.timeoutMs && opts.timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true
              controller.abort()
            }, opts.timeoutMs)
          : undefined
      emit({
        type: 'subagent.start',
        id,
        name: opts.name,
        task,
        ...(profile ? { profile: profileName } : {}),
      })
      // Listed in the run's control from here, so the host can stop THIS child on its own.
      const unregister = runCtx?.control?.registerSubagent(
        {
          id,
          name: opts.name,
          task,
          ...(profile ? { profile: profileName } : {}),
          startedAt: Date.now(),
        },
        () => {
          stoppedByUser = true
          controller.abort()
        },
      )
      try {
        const forward = (event: AgentEvent) =>
          emit({ type: 'subagent.event', id, name: opts.name, event })
        const hostTools = gatedHostTools(runCtx?.approve)
        const run = opts.worker ? runInWorker : runInProcess
        const out = await run(task, controller.signal, forward, hostTools, profile).catch(
          (err: unknown) => {
            // The user's stop wins over a deadline that fired at the same moment.
            if (stoppedByUser)
              throw new Error(
                `subagent "${opts.name}" was stopped by the user before it finished — carry on without its result, or take another approach`,
              )
            if (timedOut)
              throw new Error(`subagent "${opts.name}" timed out after ${opts.timeoutMs} ms`)
            throw err
          },
        )
        runCtx?.addUsage(out.usage)
        emit({ type: 'subagent.complete', id, name: opts.name, text: out.text, usage: out.usage })
        return clip(out.text, outputMax)
      } catch (err) {
        emit({
          type: 'subagent.error',
          id,
          name: opts.name,
          error: err instanceof Error ? err.message : String(err),
          ...(stoppedByUser ? { stopped: true } : {}),
        })
        throw err
      } finally {
        unregister?.()
        if (timer !== undefined) clearTimeout(timer)
        parentSignal?.removeEventListener('abort', onParentAbort)
        release()
      }
    },
  }) as AgentTool
  t.promptHint = profileNames.length
    ? `{ task: string, profile?: ${profileNames.map((n) => JSON.stringify(n)).join(' | ')} }`
    : '{ task: string }'
  if (opts.readOnly) t.readOnly = true
  return t
}
