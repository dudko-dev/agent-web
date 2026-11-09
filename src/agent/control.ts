import type { AgentEvent } from '../events.js'

/**
 * Steering a run that is already going.
 *
 * `run()` takes one goal and returns when the run is over, so a host that wants to
 * say something mid-run — "actually use the staging database" — or stop one
 * subagent out of several has nothing to call. A `RunControl` is the handle: create
 * one, pass it as `run(goal, { control })`, and use it from anywhere while the run
 * is in flight.
 *
 * A message is not interrupt. The run never cuts a tool call short (it may be a
 * write): the message is held until the next boundary — the next tool-calling round
 * inside a step, or the end of the step — and is then shown to the model. At a step
 * boundary it also forces the replanner to look at the plan again, because a plan
 * made before the user spoke may no longer be the right one.
 */

/** One running subagent, as the host sees it. */
export interface SubagentInfo {
  id: string
  /** The subagent tool's `name`. */
  name: string
  task: string
  /** The profile the parent chose for this call, when it chose one. */
  profile?: string
  startedAt: number
}

export interface RunControl {
  /**
   * Queue a message for the run. `false` when there is nothing to deliver it to — the text
   * is empty, or the run has already finished (send it as a new run instead).
   *
   * Accepted does not mean delivered: a message that arrives after the last boundary
   * (while the answer is being written) comes back in `RunResult.undelivered`, so the
   * host can send it next.
   */
  send(text: string): boolean
  /**
   * Messages sent and not yet delivered. Once the run is over: the ones it never got to show
   * the model (the same list as `RunResult.undelivered`, which a run that threw cannot return).
   */
  pending(): string[]
  /** The subagents running under this run right now (a snapshot; `subagent.*` events are the stream). */
  subagents(): SubagentInfo[]
  /**
   * Stop ONE running subagent. Its delegation fails with a message the parent model can
   * route around, and the run carries on — unlike aborting the run, which stops everything.
   * `false` when no subagent with that id is running.
   */
  stopSubagent(id: string): boolean
}

export interface QueuedMessage {
  id: string
  text: string
}

/** What the runner and the subagent tool use; deliberately not part of the public surface. */
export interface RunControlPort {
  /** The run starts reading: from now on `send` announces itself. */
  attach(emit: (event: AgentEvent) => void): void
  /**
   * The run is over: whatever is still queued is returned, for the host to send as a
   * follow-up. It stays readable through `pending()` until the control serves another run.
   */
  detach(): string[]
  /** Take every queued message, oldest first. */
  drain(): QueuedMessage[]
  /** A subagent started under this run; returns what unregisters it. */
  registerSubagent(info: SubagentInfo, stop: () => void): () => void
}

const ports = new WeakMap<RunControl, RunControlPort>()

/**
 * The internals of a control. Only ones made by `createRunControl()` have any: a hand-rolled
 * object that merely has the right methods would silently never be read, so it is refused.
 */
export const portOf = (control: RunControl | undefined): RunControlPort | undefined => {
  if (!control) return undefined
  const port = ports.get(control)
  if (!port) throw new TypeError('`control` must be created with createRunControl()')
  return port
}

export const createRunControl = (): RunControl => {
  let seq = 0
  let queue: QueuedMessage[] = []
  let emit: ((event: AgentEvent) => void) | undefined
  // Set when the run that read this control is over; a new run clears it.
  let ended = false
  const children = new Map<string, { info: SubagentInfo; stop: () => void }>()

  const control: RunControl = {
    send(text) {
      const clean = typeof text === 'string' ? text.trim() : ''
      if (!clean || ended) return false
      const message = { id: `msg-${(seq += 1)}`, text: clean }
      queue.push(message)
      emit?.({ type: 'message.queued', id: message.id, text: message.text })
      return true
    },
    pending: () => queue.map((m) => m.text),
    subagents: () =>
      [...children.values()].map((c) => c.info).sort((a, b) => a.startedAt - b.startedAt),
    stopSubagent(id) {
      const child = children.get(id)
      if (!child) return false
      child.stop()
      return true
    },
  }

  ports.set(control, {
    attach(next) {
      // A control that already served a run starts clean: what that run never delivered went
      // back to the host, and must not be announced again for this one.
      if (ended) {
        queue = []
        children.clear()
      }
      emit = next
      ended = false
      // Said before the run started reading: announce them now, in order.
      for (const m of queue) next({ type: 'message.queued', id: m.id, text: m.text })
    },
    detach() {
      emit = undefined
      ended = true
      children.clear()
      return queue.map((m) => m.text)
    },
    drain() {
      const out = queue
      queue = []
      return out
    },
    registerSubagent(info, stop) {
      children.set(info.id, { info, stop })
      return () => {
        children.delete(info.id)
      }
    },
  })
  return control
}
