import type { IUsage } from '../agent/loop-types.js'
import type { AgentEvent } from '../events.js'

/**
 * The wire protocol between a parent agent and a subagent running in a Web
 * Worker. Every message is structured-cloneable; anything that is not (an
 * Error, a function in a tool output) is flattened before it is posted.
 */

/** A host tool the worker can call back into the main thread for. */
export interface ProxiedToolSpec {
  name: string
  description: string
  /** JSON Schema of the tool input. */
  inputSchema: unknown
  readOnly?: boolean
}

export type ParentToWorker =
  | {
      type: 'run'
      task: string
      /** Serializable agent config (model is a ProviderModelSpec). */
      config: Record<string, unknown>
      proxied: ProxiedToolSpec[]
    }
  | { type: 'abort' }
  | { type: 'tool-result'; callId: string; ok: boolean; output: unknown }

export type WorkerToParent =
  | { type: 'event'; event: AgentEvent }
  | { type: 'tool-call'; callId: string; name: string; input: unknown }
  | { type: 'done'; text: string; usage: IUsage; steps: number }
  | { type: 'error'; error: string }

/**
 * The slice of the Worker / DedicatedWorkerGlobalScope / MessagePort API we
 * use. Structural, so a real `Worker`, a worker's `self`, or a MessageChannel
 * port (tests) all fit.
 */
export interface MessageEndpoint {
  postMessage(message: unknown): void
  addEventListener(type: string, listener: (ev: any) => void): void
  removeEventListener?(type: string, listener: (ev: any) => void): void
}

/** A worker as the parent sees it. */
export interface WorkerLike extends MessageEndpoint {
  terminate?(): void
}

/** JSON-safe copy (Errors become their message, cycles become strings). */
export const toCloneable = (value: unknown): unknown => {
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v: unknown) => (v instanceof Error ? v.message : v)) ?? 'null',
    )
  } catch {
    return String(value)
  }
}

/** postMessage that never throws a DataCloneError: falls back to a JSON-safe copy. */
export const safePost = (target: { postMessage(m: unknown): void }, message: unknown): void => {
  try {
    target.postMessage(message)
  } catch {
    target.postMessage(toCloneable(message))
  }
}
