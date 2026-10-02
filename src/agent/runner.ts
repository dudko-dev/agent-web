import type { LanguageModel, ToolSet } from 'ai'
import { resolveCaching } from '../caching.js'
import type { BrowserAgentConfig } from '../config.js'
import { resolveConfig } from '../config.js'
import type { AgentEvent, AgentEventHandler, UsagePhase } from '../events.js'
import { checkLimits, type LimitBreach } from '../limits.js'
import { clip } from '../llm/util.js'
import {
  compactSteps,
  compressHistory,
  estimateMessagesTokens,
  estimateTokens,
} from '../memory/compress.js'
import type { StoredMessage } from '../memory/store.js'
import { buildModelFromStage, resolveStage } from '../providers/registry.js'
import { defaultPrompts, type Prompts } from '../prompts.js'
import { createSkillTools, defineSkill, SKILL_TOOL_NAMES, type Skill } from '../skills.js'
import {
  createApprovalState,
  type ToolApprovalMode,
  TOOL_APPROVAL_MODES,
} from '../tools/approval.js'
import { selectToolMode } from '../tools/mode.js'
import { renderCatalog } from '../tools/prompted.js'
import {
  createFindToolsTool,
  FIND_TOOLS_NAME,
  renderSearchCatalog,
  toolCatalogOf,
  type ToolCatalogEntry,
} from '../tools/search.js'
import type { AgentToolSet } from '../tools/types.js'
import { createCallCounter, schemaHintOf, wrapToolsForRun } from '../tools/wrap.js'
import { executeStep, replanWanted } from './executor.js'
import type { AgentContext, EffectiveToolStrategy } from './internal.js'
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
import { createLogger } from '../logger.js'

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
  /** Skills whose instructions were active in this run. */
  skills: string[]
  /** The limit that stopped the run early, if any. */
  budgetExceeded?: LimitBreach
}

export interface CompactOptions {
  /** Session to compact (default: the config's sessionId). */
  sessionId?: string
  signal?: AbortSignal
  /** Compact even when below the threshold (default true for a manual call). */
  force?: boolean
}

export interface CompactResult {
  compacted: boolean
  beforeTokens: number
  afterTokens: number
  usage: IUsage
}

export interface Agent {
  run(goal: string, opts?: RunOptions): Promise<RunResult>
  /** Summarise the stored transcript (needs `memory`); returns the before/after size. */
  compact(opts?: CompactOptions): Promise<CompactResult>
  /** Switch the consent policy — e.g. the "autopilot" toggle. Applies to the next tool call. */
  setToolApprovalMode(mode: ToolApprovalMode): void
  readonly toolApprovalMode: ToolApprovalMode
  /** The tool catalogue (host + MCP tools after filtering). */
  listTools(): ToolCatalogEntry[]
  /** The effective tool selection ('auto' resolved by catalogue size). */
  readonly toolStrategy: EffectiveToolStrategy
  /** Configured skills (name + description). */
  readonly skills: { name: string; description: string }[]
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

const asJson = (v: unknown): string => {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// Budget of the tool-result excerpts the synthesizer answers from.
const FINDING_CHARS = 600
const FINDINGS_BUDGET = 6_000

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
  const baseTools: AgentToolSet = filterTools(
    config.tools ?? {},
    config.availableTools,
    config.excludedTools,
  )

  const skills: Skill[] = (config.skills ?? []).map(defineSkill)
  const skillNames = new Set<string>()
  for (const s of skills) {
    if (skillNames.has(s.name)) throw new Error(`duplicate skill name "${s.name}"`)
    skillNames.add(s.name)
  }

  const catalog = toolCatalogOf(baseTools)
  const strategy: EffectiveToolStrategy =
    cfg.toolSelectionStrategy === 'auto'
      ? catalog.length > cfg.toolSearchThreshold
        ? 'search'
        : 'all'
      : cfg.toolSelectionStrategy

  const reserved = [
    ...(skills.length ? SKILL_TOOL_NAMES : []),
    ...(strategy === 'search' ? [FIND_TOOLS_NAME] : []),
  ]
  for (const name of reserved) {
    if (Object.hasOwn(baseTools, name)) {
      throw new Error(
        `tool name "${name}" is reserved by the agent's built-in tools; rename your tool`,
      )
    }
  }
  const builtinTools = new Set<string>(reserved)

  // Parameter hints for prompted catalogues, derived once from the schemas.
  const hints = new Map<string, string>()
  await Promise.all(
    Object.entries(baseTools).map(async ([name, t]) => {
      const hint = await schemaHintOf(t)
      if (hint) hints.set(name, hint)
    }),
  )
  const toolHint = (name: string): string | undefined => hints.get(name)

  const plannerCatalog =
    strategy === 'search' ? renderSearchCatalog(catalog) : renderCatalog(baseTools, toolHint)
  const prompts: Prompts = { ...defaultPrompts, ...config.prompts }
  const caching = resolveCaching(config.promptCaching)
  const approval = createApprovalState(config.toolApproval)
  const log = createLogger(cfg.logLevel, config.logger)
  log.info(
    `agent ready — ${catalog.length} tool(s) (${strategy}), skills: [${[...skillNames].join(', ') || 'none'}], planner mode: ${plannerMode}, executor mode: ${executorMode}, approval: ${approval.mode}`,
  )

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
      skills: [],
    }
    if (!text) return result

    const state = async (): Promise<string | undefined> =>
      config.describeState ? config.describeState() : undefined
    const isAborted = (): boolean => opts.signal?.aborted === true
    const bumpUsage = (u: IUsage, phase: UsagePhase): void => {
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

    // ── per-run tool state: skills, discovered tools, call budget, current step
    const activeSkillNames = new Set<string>()
    const activateSkill = (name: string, by: 'plan' | 'tool'): void => {
      if (activeSkillNames.has(name) || !skillNames.has(name)) return
      activeSkillNames.add(name)
      result.skills = [...activeSkillNames]
      emit({ type: 'skill.activated', name, by })
    }
    const discovered: string[] = []
    let currentStep: IPlanStep | undefined
    const counter = createCallCounter(cfg.maxToolCalls)
    const builtins: ToolSet = {}
    if (skills.length) {
      Object.assign(
        builtins,
        createSkillTools(skills, (s) => activateSkill(s.name, 'tool')),
      )
    }
    if (strategy === 'search') {
      builtins[FIND_TOOLS_NAME] = createFindToolsTool(
        () => catalog,
        (query, names) => {
          for (const n of names) {
            const i = discovered.indexOf(n)
            if (i >= 0) discovered.splice(i, 1)
            discovered.push(n)
          }
          emit({ type: 'tools.discovered', step: currentStep, query, names })
        },
        toolHint,
      )
    }
    const tools = wrapToolsForRun(
      { ...baseTools, ...builtins },
      {
        approval,
        builtins: builtinTools,
        emit,
        step: () => currentStep,
        signal: opts.signal,
        addUsage: (u) => bumpUsage(u, 'subagent'),
        countCall: counter.count,
        maxToolOutputChars: cfg.compaction.maxToolOutputChars,
      },
    )

    let budgetExceeded: LimitBreach | undefined
    const breach = (extra?: IUsage): LimitBreach | undefined => {
      const b = checkLimits(extra ? addUsage(usage, extra) : usage, cfg.limits)
      if (b) return b
      if (counter.exhausted)
        return { kind: 'tool-calls', tokens: counter.calls, cap: cfg.maxToolCalls }
      return undefined
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
    // Auto-compaction of a long transcript BEFORE planning, so the run starts
    // within the window (configured `compaction` only; the legacy
    // compressAfterChars path compacts after the run, as it always did).
    if (config.memory && config.compaction && cfg.compaction.auto && history.length > 0) {
      const before = estimateMessagesTokens(history)
      if (before > cfg.compaction.thresholdTokens) {
        const compacted = await compressHistory(history, synthesizerModel, {
          thresholdTokens: cfg.compaction.thresholdTokens,
          keepRecent: cfg.compaction.keepRecentTurns,
          summaryMaxTokens: cfg.budgets.compaction,
          timeoutMs: cfg.chatTimeoutMs,
          abortSignal: opts.signal,
          onUsage: (u) => bumpUsage(u, 'compact'),
        })
        if (compacted !== history) {
          history = compacted
          await config.memory.replace(sessionId, compacted).catch(() => {})
          emit({
            type: 'context.compacted',
            scope: 'history',
            beforeTokens: before,
            afterTokens: estimateMessagesTokens(compacted),
          })
        }
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
      toolCatalog: plannerCatalog,
      prompts,
      emit,
      log,
      signal: opts.signal,
      state,
      history,
      strategy,
      caching,
      skills,
      activeSkills: () => skills.filter((s) => activeSkillNames.has(s.name)),
      discovered: () => discovered,
      builtinTools,
      toolHint,
      usageSoFar: () => usage,
      overBudget: (extra) => breach(extra) !== undefined,
      setCurrentStep: (step) => {
        currentStep = step
      },
    }
    await remember({ role: 'user', content: text })
    log.info('run:', text)

    const stop = (): RunResult => {
      emit({ type: 'stopped' })
      result.stopped = true
      return result
    }

    try {
      // 1) PLAN
      let planned = await createPlan(ctx, text)
      bumpUsage(planned.usage, 'plan')
      if (isAborted()) return stop()

      // Small models sometimes return an empty plan for a clearly actionable
      // goal — and put a hallucinated "done!" into the thought, so the run
      // would claim success while never touching a tool. Give the planner one
      // nudged retry before treating the turn as conversational.
      if (planned.plan.steps.length === 0 && text.split(/\s+/).length > 2) {
        log.warn(
          'planner returned no steps for a multi-word goal — retrying with a nudge. thought:',
          planned.plan.thought,
        )
        const retried = await createPlan(
          ctx,
          text,
          'NOTE: If the message above asks to build, add, change, clear, delete, find, check or look up ANYTHING the tools can do, you MUST output 1-6 concrete steps. Output an empty plan ONLY for a pure greeting or small talk.',
        )
        bumpUsage(retried.usage, 'plan')
        if (retried.plan.steps.length > 0) planned = retried
      }
      result.plan = planned.plan
      if (isAborted()) return stop()

      // Greeting / small talk → answer directly, run no tools.
      if (planned.plan.steps.length === 0) {
        log.info('no plan — answering directly (no tools will run)')
        const answer = planned.plan.thought.trim() || "Tell me what you'd like to do."
        emit({ type: 'final', text: answer })
        await remember({ role: 'assistant', content: answer })
        result.final = answer
        return result
      }
      log.info(
        `plan (${planned.plan.steps.length} steps):`,
        planned.plan.steps.map((s) => s.description),
      )
      emit({ type: 'plan.created', plan: planned.plan })
      planned.plan.steps.forEach((step, index) => emit({ type: 'plan.step-added', step, index }))
      for (const name of planned.skills) activateSkill(name, 'plan')

      // 2) EXECUTE → REPLAN
      let done: string[] = []
      const findings: string[] = []
      let remaining: IPlanStep[] = [...planned.plan.steps]
      let iter = 0
      let revisions = 0
      while (remaining.length > 0 && iter < cfg.maxIterations) {
        if (isAborted()) return stop()
        const hit = breach()
        if (hit) {
          budgetExceeded = hit
          result.budgetExceeded = hit
          log.warn(`${hit.kind} limit reached (${hit.tokens}/${hit.cap}) — writing the answer now`)
          emit({ type: 'budget.exceeded', ...hit })
          break
        }
        iter += 1
        const step = remaining.shift() as IPlanStep
        const stepNo = result.trace.length + 1
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
          if (isAborted()) return stop()
          emit({ type: 'error', phase: 'execute', error: errMessage(err) })
          stepResult = { step, summary: errMessage(err), toolCalls: [], blocked: true }
        } finally {
          currentStep = undefined
        }

        result.trace.push(stepResult)
        const applied = stepResult.toolCalls.filter((c) => c.ok).length
        const failed = stepResult.toolCalls.length - applied
        result.applied += applied
        result.steps = stepNo
        log.info(
          `step ${stepNo}/${total} "${step.description}" — ${stepResult.toolCalls.length} tool call(s), ${applied} ok${failed ? `, ${failed} FAILED` : ''}${stepResult.blocked ? ', BLOCKED' : ''}`,
        )
        if (stepResult.toolCalls.length === 0) {
          log.warn(`step ${stepNo} made no tool calls — nothing changed in this step`)
        }
        stepResult.toolCalls
          .filter((c) => !c.ok)
          .forEach((c) => log.warn(`tool ${c.name} failed:`, c.output))
        log.debug(`step ${stepNo} detail:`, stepResult)
        emit({ type: 'step.complete', step, result: stepResult })
        // The step's own summary carries the data later steps and the answer
        // need ("found 3 open issues: #12, #15, #19") — not just a count.
        const counts = stepResult.toolCalls.length
          ? ` [${applied} tool call(s) ok${failed ? `, ${failed} failed` : ''}]`
          : ''
        done.push(
          `${step.description} — ${clip(stepResult.summary, FINDING_CHARS)}${counts}${stepResult.blocked ? ' [blocked]' : ''}`,
        )
        for (const c of stepResult.toolCalls) {
          if (!c.ok || builtinTools.has(c.name)) continue
          findings.push(`- ${c.name}: ${clip(asJson(c.output), FINDING_CHARS)}`)
        }
        while (findings.join('\n').length > FINDINGS_BUDGET && findings.length > 1) findings.shift()

        // Auto-compaction of the run's step log when it outgrows the threshold.
        if (cfg.compaction.auto) {
          const before = estimateTokens(done.join('\n'))
          if (before > cfg.compaction.thresholdTokens) {
            const compacted = await compactSteps(done, synthesizerModel, {
              thresholdTokens: cfg.compaction.thresholdTokens,
              keepRecent: cfg.compaction.keepRecentSteps,
              summaryMaxTokens: cfg.budgets.compaction,
              timeoutMs: cfg.chatTimeoutMs,
              abortSignal: opts.signal,
              onUsage: (u) => bumpUsage(u, 'compact'),
            })
            if (compacted !== done) {
              done = compacted
              emit({
                type: 'context.compacted',
                scope: 'trace',
                beforeTokens: before,
                afterTokens: estimateTokens(done.join('\n')),
              })
            }
          }
        }

        // 2b) REPLAN — by default after a blocked / failed step; `replanAfter`
        // can widen the trigger ('always', or a host predicate reacting to
        // e.g. issues surfaced through describeState). Also runs when the
        // triggering step was the last one — 'revise' can add remedial steps.
        // A host predicate is watchdog- and abort-bounded; re-check abort after
        // it (it may await slow state) before spending a replanner call.
        const wantReplan =
          cfg.replan &&
          iter < cfg.maxIterations &&
          revisions < cfg.maxRevisions &&
          !isAborted() &&
          !breach() &&
          (await replanWanted(cfg.replanAfter, stepResult, {
            signal: ctx.signal,
            timeoutMs: cfg.chatTimeoutMs,
            onError: (err) => log.warn('replanAfter predicate threw — using the failure rule', err),
          }))
        if (wantReplan && !isAborted()) {
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
              .slice(0, Math.min(cfg.maxPlanSteps, cfg.maxIterations - iter))
              .map((description, i) => ({ id: `r${iter}-${i + 1}`, description }))
            emit({
              type: 'plan.revised',
              plan: { thought: planned.plan.thought, steps: remaining },
              reason: decision.reason,
            })
          }
        }
      }
      // A limit reached on the very last step is still worth reporting.
      if (!budgetExceeded && remaining.length > 0) {
        const hit = breach()
        if (hit) {
          budgetExceeded = hit
          result.budgetExceeded = hit
          emit({ type: 'budget.exceeded', ...hit })
        }
      }

      if (isAborted()) return stop()

      // 3) SYNTHESIZE
      let summary = 'Done — the changes have been applied.'
      if (cfg.synthesize) {
        try {
          const synth = await synthesizeAnswer(ctx, text, done, findings)
          bumpUsage(synth.usage, 'synthesize')
          if (synth.text) summary = synth.text
        } catch {
          if (isAborted()) return stop()
          /* keep the default */
        }
      }
      log.info(`done — ${result.applied} tool call(s) applied over ${result.steps} step(s)`)
      emit({ type: 'final', text: summary })
      await remember({ role: 'assistant', content: summary })
      result.final = summary

      // 4) COMPACT persisted history (legacy chars threshold, or the configured
      // compaction's token threshold).
      if (config.memory && (config.compaction ? cfg.compaction.auto : cfg.compressAfterChars > 0)) {
        try {
          const transcript = await config.memory.load(sessionId)
          const before = estimateMessagesTokens(transcript)
          const compacted = await compressHistory(transcript, synthesizerModel, {
            ...(config.compaction
              ? {
                  thresholdTokens: cfg.compaction.thresholdTokens,
                  keepRecent: cfg.compaction.keepRecentTurns,
                  summaryMaxTokens: cfg.budgets.compaction,
                }
              : { maxChars: cfg.compressAfterChars }),
            timeoutMs: cfg.chatTimeoutMs,
            abortSignal: opts.signal,
            onUsage: (u) => bumpUsage(u, 'compact'),
          })
          if (compacted !== transcript) {
            await config.memory.replace(sessionId, compacted)
            emit({
              type: 'context.compacted',
              scope: 'history',
              beforeTokens: before,
              afterTokens: estimateMessagesTokens(compacted),
            })
          }
        } catch {
          /* best-effort */
        }
      }
      return result
    } catch (err) {
      if (isAborted()) return stop()
      emit({ type: 'error', phase: 'run', error: errMessage(err) })
      result.final = errMessage(err)
      return result
    }
  }

  const compact = async (o: CompactOptions = {}): Promise<CompactResult> => {
    const empty: CompactResult = {
      compacted: false,
      beforeTokens: 0,
      afterTokens: 0,
      usage: emptyUsage(),
    }
    if (!config.memory) return empty
    const sessionId = o.sessionId ?? cfg.sessionId
    const transcript = await config.memory.load(sessionId)
    const beforeTokens = estimateMessagesTokens(transcript)
    let usage = emptyUsage()
    const compacted = await compressHistory(transcript, synthesizerModel, {
      thresholdTokens: cfg.compaction.thresholdTokens,
      keepRecent: cfg.compaction.keepRecentTurns,
      summaryMaxTokens: cfg.budgets.compaction,
      force: o.force ?? true,
      timeoutMs: cfg.chatTimeoutMs,
      abortSignal: o.signal,
      onUsage: (u) => {
        usage = addUsage(usage, u)
      },
    })
    if (compacted === transcript)
      return { ...empty, beforeTokens, afterTokens: beforeTokens, usage }
    await config.memory.replace(sessionId, compacted)
    return { compacted: true, beforeTokens, afterTokens: estimateMessagesTokens(compacted), usage }
  }

  return {
    run,
    compact,
    setToolApprovalMode: (mode: ToolApprovalMode) => {
      if (!TOOL_APPROVAL_MODES.includes(mode)) {
        throw new Error(`unknown tool approval mode "${mode}" (${TOOL_APPROVAL_MODES.join(' | ')})`)
      }
      approval.mode = mode
      log.info(`tool approval mode → ${mode}`)
    },
    get toolApprovalMode() {
      return approval.mode
    },
    listTools: () => catalog.map((e) => ({ ...e })),
    toolStrategy: strategy,
    skills: skills.map((s) => ({ name: s.name, description: s.description })),
    models: { planner: plannerModel, executor: executorModel, synthesizer: synthesizerModel },
  }
}
