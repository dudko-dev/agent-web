// ── Agent ──────────────────────────────────────────────────────────────────
export { createAgent } from './agent/runner.js'
export type { Agent, CompactOptions, CompactResult, RunOptions, RunResult } from './agent/runner.js'
export type { IPlan, IPlanStep, IStepResult, IToolCall, IUsage } from './agent/loop-types.js'
export { PlanSchema, PlanStepSchema, ReplanSchema } from './agent/schemas.js'
export type { PlanShape, ReplanShape } from './agent/schemas.js'
// Phase functions + helpers, for hosts building a custom loop.
export { createPlan } from './agent/planner.js'
export { executeStep, replanWanted, shouldReplan, splitBlocker } from './agent/executor.js'
export { decideReplan } from './agent/replanner.js'
export { synthesizeAnswer } from './agent/synthesizer.js'
export type { AgentContext, EffectiveToolStrategy } from './agent/internal.js'

// ── Subagents (in-process or Web Worker) ─────────────────────────────────────
export { createSubagentTool } from './subagent/tool.js'
export type { SubagentToolOptions, SubagentWorkerConfig } from './subagent/tool.js'
export { serveSubagentWorker } from './subagent/worker.js'
export type { ServeSubagentOptions } from './subagent/worker.js'
export type {
  MessageEndpoint,
  WorkerLike,
  ParentToWorker,
  WorkerToParent,
  ProxiedToolSpec,
} from './subagent/protocol.js'

// ── Images, files ────────────────────────────────────────────────────────────
export {
  AttachmentsNotSupportedError,
  ImagesNotSupportedError,
  attachmentKind,
  isAttachmentRefusal,
  isImageRefusal,
  mediaTypeOf,
  toFilePart,
  toImagePart,
} from './images.js'
export type { AttachmentKind, RunFile, RunImage } from './images.js'
export {
  VirtualFileSystem,
  normalizePath,
  mimeFromPath,
  isTextMime,
  bytesToBase64,
} from './files/vfs.js'
export type {
  VirtualFile,
  VirtualFileInfo,
  VirtualFileSystemOptions,
  VfsListener,
} from './files/vfs.js'
export { createFileTools } from './files/tools.js'
export type { FileToolsOptions } from './files/tools.js'

// ── Thinking, limits, caching ────────────────────────────────────────────────
export { resolveThinking, thinkingFor, mergeProviderOptions } from './thinking.js'
export type {
  ThinkingConfig,
  ThinkingLevel,
  ThinkingSetting,
  ThinkingStage,
  ResolvedThinking,
  ProviderOptionsMap,
} from './thinking.js'
export { checkLimits, ToolBudgetError } from './limits.js'
export type { TokenLimits, LimitBreach, LimitKind } from './limits.js'
export { resolveCaching } from './caching.js'
export type { PromptCachingSetting, ResolvedCaching } from './caching.js'

// ── Skills ───────────────────────────────────────────────────────────────────
export {
  defineSkill,
  parseSkillMarkdown,
  loadSkillFromUrl,
  renderSkillIndex,
  renderActiveSkills,
  createSkillTools,
  SKILL_TOOL_NAMES,
} from './skills.js'
export type { Skill, LoadSkillOptions } from './skills.js'

// ── Config ───────────────────────────────────────────────────────────────────
export { resolveConfig } from './config.js'
export type {
  BrowserAgentConfig,
  ResolvedConfig,
  PhaseBudgets,
  ReplanTrigger,
  ToolMode,
  ToolSelectionStrategy,
} from './config.js'

// ── Providers / models ───────────────────────────────────────────────────────
export { buildModelFromStage, resolveStage, resolveModel } from './providers/registry.js'
export {
  createWebLLMModel,
  preloadWebLLMModel,
  unloadWebLLMModel,
  isWebGPUAvailable,
} from './providers/webllm.js'
export type { WebLLMModelOptions } from './providers/webllm.js'
export {
  supportsNativeTools,
  supportsStructuredOutput,
  directBrowserOk,
  supportsImages,
  supportsPdf,
} from './providers/capabilities.js'
export { isDirectModel, isProviderSpec } from './providers/types.js'
export type {
  ProviderType,
  ProviderModelSpec,
  ModelInput,
  StageInput,
  StageOverride,
  ResolvedStage,
} from './providers/types.js'

// ── Secrets (encrypted token vault) ──────────────────────────────────────────
export { IndexedDBVault } from './secrets/vault.js'
export type { VaultOptions } from './secrets/vault.js'
export { VaultCredentialStore, MemoryCredentialStore } from './secrets/store.js'
export type { CredentialStore } from './secrets/store.js'
export { getOrCreateVaultKey, encryptJSON, decryptJSON } from './secrets/crypto.js'
export type { EncryptedBlob } from './secrets/crypto.js'

// ── Storage (shared IndexedDB owner) ─────────────────────────────────────────
export {
  openAgentWebDB,
  KEYS_STORE,
  SECRETS_STORE,
  SESSIONS_STORE,
  FILES_STORE,
} from './storage/db.js'
export type { AgentWebDBOptions } from './storage/db.js'

// ── Low-level LLM helpers (simple generation, tool loop) ─────────────────────
export { generate, stream, generateStructured } from './llm/generate.js'
export type { GenerateOptions } from './llm/generate.js'
export { runToolLoop } from './llm/tool-loop.js'
export type { ToolLoopOptions, ToolLoopResult, ToolLoopCallbacks } from './llm/tool-loop.js'
export { normalizeUsage } from './llm/util.js'

// ── Tools ────────────────────────────────────────────────────────────────────
export { defineTool } from './tools/define.js'
export { renderCatalog, dispatch } from './tools/prompted.js'
export { selectToolMode } from './tools/mode.js'
export { promptHintOf } from './tools/types.js'
export type { AgentTool, AgentToolSet } from './tools/types.js'
export {
  ToolDeniedError,
  markReadOnly,
  isReadOnlyTool,
  matchRule,
  decideToolPermission,
  TOOL_APPROVAL_MODES,
} from './tools/approval.js'
export type {
  ToolApprovalConfig,
  ToolApprovalDecision,
  ToolApprovalMode,
  ToolApprovalRequest,
  ToolPermission,
} from './tools/approval.js'
export {
  searchTools,
  renderSearchCatalog,
  toolCatalogOf,
  createFindToolsTool,
  tokenize,
  FIND_TOOLS_NAME,
} from './tools/search.js'
export type { ToolCatalogEntry, SearchToolsOptions } from './tools/search.js'
export { toolRunContextOf, schemaHintOf, limitModelOutput } from './tools/wrap.js'
export type { ToolRunContext } from './tools/wrap.js'

// ── Memory ───────────────────────────────────────────────────────────────────
export { MemoryStore } from './memory/store.js'
export type { ContextStore, StoredMessage } from './memory/store.js'
export { IndexedDBStore } from './memory/sessions.js'
export type { IndexedDBStoreOptions } from './memory/sessions.js'
export {
  compressHistory,
  compactHistory,
  compactSteps,
  estimateTokens,
  estimateMessagesTokens,
  resolveCompaction,
} from './memory/compress.js'
export type { CompressOptions, CompactionConfig, ResolvedCompaction } from './memory/compress.js'

// ── Prompts ──────────────────────────────────────────────────────────────────
export { defaultPrompts, withSystem } from './prompts.js'
export type {
  Prompts,
  PromptParts,
  ToolCallMode,
  PlannerPromptContext,
  ExecutorPromptContext,
  ReplannerPromptContext,
  SynthesizerPromptContext,
} from './prompts.js'

// ── Parsing (robust salvage — for custom loops / the prompted path) ──────────
export {
  parsePlannerResponse,
  parseExecutorResponse,
  parseReplannerResponse,
  parsePlainText,
  looksLikeJson,
  normalizeSteps,
} from './parse.js'
export type {
  RawAction,
  ReplanDecision,
  PlannerResult,
  ExecutorResult,
  ReplannerResult,
} from './parse.js'

// ── Events ───────────────────────────────────────────────────────────────────
export type { AgentEvent, AgentEventHandler, ReplanMode, Phase, UsagePhase } from './events.js'

// ── Logging ──────────────────────────────────────────────────────────────────
export { createLogger } from './logger.js'
export type { AgentLogger, AgentLoggerSink, LogLevel } from './logger.js'
