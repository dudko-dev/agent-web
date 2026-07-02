import type { LanguageModel } from 'ai'
import type { BrowserAgentConfig } from '../config.js'
import { resolveConfig } from '../config.js'
import type { AgentEvent, AgentEventHandler, Phase } from '../events.js'
import { compressHistory } from '../memory/compress.js'
import type { StoredMessage } from '../memory/store.js'
import { buildModelFromStage, resolveStage } from '../providers/registry.js'
import { defaultPrompts, type Prompts } from '../prompts.js'
import { selectToolMode } from '../tools/mode.js'
import { renderCatalog } from '../tools/prompted.js'
import type { AgentToolSet } from '../tools/types.js'
import { executeStep, shouldReplan } from './executor.js'
import type { AgentContext } from './internal.js'
import {
  addUsage,
  emptyUsage,
  type IPlan,
  type IPlanStep,
  type IStepResult,
  type IUsage,
} from './loop-types.js'
import { createPlan } from './planner.js'
import { decideReplan } from './replanner.js'
import { synthesizeAnswer } from './synthesizer.js'

export interface RunOptions {
  onEvent?: AgentEventHandler
  signal?: AbortSignal
  /** Override the config's sessionId for this run. */
  sessionId?: string
}

export interface RunResult {
  goal: string
  final: string
  plan: IPlan
  trace: IStepResult[]
  steps: number
  /** Total successful tool calls across the run. */
  applied: number
  stopped: boolean
  usage: IUsage
}

export interface Agent {
  run(goal: string, opts?: RunOptions): Promise<RunResult>
  /** The resolved models, for hosts that want to reuse them (e.g. warm-up). */
  readonly models: {
    planner: LanguageModel
    executor: LanguageModel
    synthesizer: LanguageModel
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Apply the config's availableTools whitelist and excludedTools blacklist. */
const filterTools = (
  all: AgentToolSet,
  available?: string[],
  excluded?: string[],
): AgentToolSet => {
  let entries = Object.entries(all)
  if (available && available.length > 0) entries = entries.filter(([n]) => available.includes(n))
  if (excluded && excluded.length > 0) entries = entries.filter(([n]) => !excluded.includes(n))
  return Object.fromEntries(entries)
}

/**
 * Create a headless plan → execute → replan → synthesize agent. Models are
 * resolved eagerly (dynamic provider imports + vault key fetch), so this is
 * async. Each `run` streams typed AgentEvents for any UI to render.
 */
export const createAgent = async (config: BrowserAgentConfig): Promise<Agent> => {
  const cfg = resolveConfig(config)
  // Build the executor once; a stage without an override reuses it instead of
  // constructing a second identical model (for web-llm that would mean loading
  // the same weights into the GPU again).
  const buildStage = (override: BrowserAgentConfig['planner'], stageName: string) =>
    buildModelFromStage(
      resolveStage(config.model, override, stageName),
      config.credentials,
      cfg.clientName,
    )
  const executorP = buildStage(undefined, 'executor')
  const [executorModel, plannerModel, synthesizerModel] = await Promise.all([
    executorP,
    config.planner === undefined ? executorP : buildStage(config.planner, 'planner'),
    config.synthesizer === undefined ? executorP : buildStage(config.synthesizer, 'synthesizer'),
  ])

  const plannerMode = selectToolMode(plannerModel, cfg.toolMode)
  const executorMode = selectToolMode(executorModel, cfg.toolMode)
  const tools: AgentToolSet = filterTools(
    config.tools ?? {},
    config.availableTools,
    config.excludedTools,
  )
  const toolCatalog = renderCatalog(tools)
  const prompts: Prompts = { ...defaultPrompts, ...config.prompts }

  const run = async (goal: string, opts: RunOptions = {}): Promise<RunResult> => {
    const emit = (event: AgentEvent): void => {
      try {
        opts.onEvent?.(event)
      } catch {
        /* a bad handler must not break the run */
      }
    }
    const text = goal.trim()
    const sessionId = opts.sessionId ?? cfg.sessionId
    let usage = emptyUsage()
    const result: RunResult = {
      goal: text,
      final: '',
      plan: { thought: '', steps: [] },
      trace: [],
      steps: 0,
      applied: 0,
      stopped: false,
      usage,
    }
    if (!text) return result

    const state = async (): Promise<string | undefined> =>
      config.describeState ? config.describeState() : undefined
    const isAborted = (): boolean => opts.signal?.aborted === true
    const bumpUsage = (u: IUsage, phase: Phase): void => {
      usage = addUsage(usage, u)
      result.usage = usage
      emit({ type: 'usage', phase, usage: u })
    }
    const remember = async (msg: StoredMessage): Promise<void> => {
      if (!config.memory) return
      try {
        await config.memory.append(sessionId, msg)
      } catch {
        /* persistence is best-effort */
      }
    }

    emit({ type: 'run.start', goal: text })
    // Read back the session transcript BEFORE appending the current goal, so
    // the planner can resolve references to earlier turns ("make it bigger").
    let history: StoredMessage[] = []
    if (config.memory) {
      try {
        history = await config.memory.load(sessionId)
      } catch {
        /* persistence is best-effort */
      }
    }
    const ctx: AgentContext = {
      config: cfg,
      raw: config,
      plannerModel,
      executorModel,
      synthesizerModel,
      plannerMode,
      executorMode,
      tools,
      toolCatalog,
      prompts,
      emit,
      signal: opts.signal,
      state,
      history,
    }
    await remember({ role: 'user', content: text })

    try {
      // 1) PLAN
      const planned = await createPlan(ctx, text)
      bumpUsage(planned.usage, 'plan')
      result.plan = planned.plan
      if (isAborted()) {
        emit({ type: 'stopped' })
        result.stopped = true
        return result
      }

      // Greeting / question / unclear → answer directly, run no tools.
      if (planned.plan.steps.length === 0) {
        const answer = planned.plan.thought.trim() || "Tell me what you'd like to do."
        emit({ type: 'final', text: answer })
        await remember({ role: 'assistant', content: answer })
        result.final = answer
        return result
      }
      emit({ type: 'plan.created', plan: planned.plan })
      planned.plan.steps.forEach((step, index) => emit({ type: 'plan.step-added', step, index }))

      // 2) EXECUTE → REPLAN
      const done: string[] = []
      let remaining: IPlanStep[] = [...planned.plan.steps]
      let iter = 0
      let revisions = 0
      while (remaining.length > 0 && iter < cfg.maxIterations) {
        if (isAborted()) {
          emit({ type: 'stopped' })
          result.stopped = true
          return result
        }
        iter += 1
        const step = remaining.shift() as IPlanStep
        const stepNo = done.length + 1
        const total = stepNo + remaining.length
        emit({ type: 'step.start', step, index: stepNo, total })

        let stepResult: IStepResult
        try {
          const out = await executeStep(ctx, text, step, stepNo, total, done)
          bumpUsage(out.usage, 'execute')
          stepResult = out.result
        } catch (err) {
          // A user abort surfaces as a thrown AbortError — that is a stop, not
          // a step failure.
          if (isAborted()) {
            emit({ type: 'stopped' })
            result.stopped = true
            return result
          }
          emit({ type: 'error', phase: 'execute', error: errMessage(err) })
          stepResult = { step, summary: errMessage(err), toolCalls: [], blocked: true }
        }

        result.trace.push(stepResult)
        const applied = stepResult.toolCalls.filter((c) => c.ok).length
        const failed = stepResult.toolCalls.length - applied
        result.applied += applied
        result.steps = stepNo
        emit({ type: 'step.complete', step, result: stepResult })
        done.push(
          `${step.description} — ${applied} applied${failed ? `, ${failed} failed` : ''}${stepResult.blocked ? ', blocked' : ''}`,
        )

        // 2b) REPLAN (only after a blocked / failed step). Also runs when the
        // FAILED step was the last one — 'revise' can then add remedial steps.
        if (
          cfg.replan &&
          iter < cfg.maxIterations &&
          revisions < cfg.maxRevisions &&
          !isAborted() &&
          shouldReplan(stepResult)
        ) {
          const decision = await decideReplan(
            ctx,
            text,
            done,
            remaining.map((s) => s.description),
          )
          bumpUsage(decision.usage, 'replan')
          emit({ type: 'replan.decision', mode: decision.decision, reason: decision.reason })
          if (decision.decision === 'finish') break
          if (decision.decision === 'revise' && decision.plan.length > 0) {
            revisions += 1
            remaining = decision.plan
              .slice(0, cfg.maxIterations - iter)
              .map((description, i) => ({ id: `r${iter}-${i + 1}`, description }))
            emit({
              type: 'plan.revised',
              plan: { thought: planned.plan.thought, steps: remaining },
              reason: decision.reason,
            })
          }
        }
      }

      if (isAborted()) {
        emit({ type: 'stopped' })
        result.stopped = true
        return result
      }

      // 3) SYNTHESIZE
      let summary = 'Done — the changes have been applied.'
      if (cfg.synthesize) {
        try {
          const synth = await synthesizeAnswer(ctx, text, done)
          bumpUsage(synth.usage, 'synthesize')
          if (synth.text) summary = synth.text
        } catch {
          /* keep the default */
        }
      }
      emit({ type: 'final', text: summary })
      await remember({ role: 'assistant', content: summary })
      result.final = summary

      // 4) COMPRESS persisted history
      if (config.memory && cfg.compressAfterChars > 0) {
        try {
          const transcript = await config.memory.load(sessionId)
          const compacted = await compressHistory(transcript, synthesizerModel, {
            maxChars: cfg.compressAfterChars,
            timeoutMs: cfg.chatTimeoutMs,
            abortSignal: opts.signal,
          })
          if (compacted !== transcript) await config.memory.replace(sessionId, compacted)
        } catch {
          /* best-effort */
        }
      }
      return result
    } catch (err) {
      emit({ type: 'error', phase: 'run', error: errMessage(err) })
      result.final = errMessage(err)
      return result
    }
  }

  return {
    run,
    models: { planner: plannerModel, executor: executorModel, synthesizer: synthesizerModel },
  }
}
