import type { LanguageModel, ModelMessage, SystemModelMessage } from 'ai'
import { cachedInstructions, cachingProviderOptions, type ResolvedCaching } from '../caching.js'
import type { BrowserAgentConfig, ResolvedConfig } from '../config.js'
import type { AgentEvent } from '../events.js'
import type { StoredMessage } from '../memory/store.js'
import type { Prompts, ToolCallMode } from '../prompts.js'
import { withSystem } from '../prompts.js'
import type { Skill } from '../skills.js'
import {
  mergeProviderOptions,
  resolveThinking,
  thinkingFor,
  type ProviderOptionsMap,
  type ThinkingLevel,
  type ThinkingStage,
} from '../thinking.js'
import type { AgentToolSet } from '../tools/types.js'
import type { AgentLogger } from '../logger.js'
import {
  AttachmentsNotSupportedError,
  attachmentKind,
  isAttachmentRefusal,
  modelLabel,
  toFilePart,
  unsupportedAttachment,
  type RunFile,
} from '../images.js'
import type { IPlanStep, IUsage } from './loop-types.js'

/** The effective tool-selection strategy of a run ('auto' already resolved). */
export type EffectiveToolStrategy = 'all' | 'plan-narrowed' | 'search'

/** Everything the phase functions (planner/executor/replanner/synthesizer) share. */
export interface AgentContext {
  config: ResolvedConfig
  raw: BrowserAgentConfig
  plannerModel: LanguageModel
  executorModel: LanguageModel
  synthesizerModel: LanguageModel
  /** Tool-mode for the planner/replanner (from the planner model). */
  plannerMode: ToolCallMode
  /** Tool-mode for the executor (from the executor model). */
  executorMode: ToolCallMode
  /** The run's tools (host + MCP + built-ins), already wrapped by the consent gate. */
  tools: AgentToolSet
  /** The catalogue as the planner sees it (condensed in search mode). */
  toolCatalog: string
  prompts: Prompts
  emit: (event: AgentEvent) => void
  /** Leveled logger (config.logLevel over config.logger ?? console). */
  log: AgentLogger
  signal?: AbortSignal
  /** Current world state for grounding, or undefined when no describeState is configured. */
  state: () => Promise<string | undefined>
  /** Session transcript loaded from memory BEFORE this run's goal was appended. */
  history?: StoredMessage[]

  /** Effective tool selection for this run. */
  strategy?: EffectiveToolStrategy
  /** Prompt caching, resolved. */
  caching?: ResolvedCaching
  /** All configured skills. */
  skills?: Skill[]
  /** Skills whose instructions are in play for this run. */
  activeSkills?: () => Skill[]
  /** Tools find_tools activated during this run (search mode). */
  discovered?: () => string[]
  /** Built-in tool names (find_tools, skill tools) — always callable. */
  builtinTools?: ReadonlySet<string>
  /** Parameter hint of a tool, for prompted catalogues. */
  toolHint?: (name: string) => string | undefined
  /** Run usage so far (for in-step budget checks). */
  usageSoFar?: () => IUsage
  /** True when the run's limits are reached given extra usage spent inside the current call. */
  overBudget?: (extra: IUsage) => boolean
  /** Tracks the step being executed (tools read it via their run context). */
  setCurrentStep?: (step: IPlanStep | undefined) => void
  /** Images / PDFs / files the user sent with this run's goal. */
  images?: RunFile[]
}

/**
 * The prompt of a stage call: plain text, or — when the run carries images — a
 * user message with the text and the images, so the model can see them.
 */
export const promptFor = (
  ctx: AgentContext,
  prompt: string,
): { prompt: string } | { messages: ModelMessage[] } =>
  ctx.images?.length
    ? {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt }, ...ctx.images.map(toFilePart)],
          },
        ],
      }
    : { prompt }

/**
 * When a run carries attachments and a model call failed in a way that reads
 * like a refusal of them, the clear error to raise instead (else undefined).
 */
export const imageRefusal = (
  ctx: AgentContext,
  err: unknown,
  model: LanguageModel,
): AttachmentsNotSupportedError | undefined => {
  if (
    !ctx.images?.length ||
    err instanceof AttachmentsNotSupportedError ||
    !isAttachmentRefusal(err)
  ) {
    return undefined
  }
  const kinds = new Set(ctx.images.map(attachmentKind))
  const kind = kinds.size === 1 ? [...kinds][0] : 'file'
  const detail = err instanceof Error ? err.message.slice(0, 160) : undefined
  return unsupportedAttachment(modelLabel(model), kind, detail && `the provider said: ${detail}`)
}

/** Prepend the host's systemPrompt to a phase system prompt. */
export const systemFor = (ctx: AgentContext, base: string): string =>
  withSystem(base, ctx.raw.systemPrompt)

export const aborted = (ctx: AgentContext): boolean => ctx.signal?.aborted === true

export interface StageCallOptions {
  system: string | SystemModelMessage
  reasoning?: ThinkingLevel
  providerOptions?: ProviderOptionsMap
}

/**
 * The per-stage call settings: the host systemPrompt + the phase system prompt
 * (as a cacheable message when prompt caching is on), the stage's thinking
 * level, and the merged provider options (thinking, caching).
 */
export const stageCall = (
  ctx: AgentContext,
  stage: ThinkingStage,
  baseSystem: string,
): StageCallOptions => {
  const system = systemFor(ctx, baseSystem)
  const thinking = resolveThinking(thinkingFor(stage, ctx.raw.thinking, ctx.raw.stageThinking))
  const caching = ctx.caching ?? { enabled: false }
  const providerOptions = mergeProviderOptions(
    cachingProviderOptions(caching, ctx.config.clientName, stage),
    thinking.providerOptions,
  )
  return {
    system: cachedInstructions(system, caching),
    ...(thinking.reasoning ? { reasoning: thinking.reasoning } : {}),
    ...(providerOptions ? { providerOptions } : {}),
  }
}
