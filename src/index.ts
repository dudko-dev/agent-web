// ── Agent ──────────────────────────────────────────────────────────────────
export { createAgent } from './agent/runner.js'
export type { Agent, RunOptions, RunResult } from './agent/runner.js'
export type { IPlan, IPlanStep, IStepResult, IToolCall, IUsage } from './agent/loop-types.js'
export { PlanSchema, PlanStepSchema, ReplanSchema } from './agent/schemas.js'
export type { PlanShape, ReplanShape } from './agent/schemas.js'
// Phase functions + helpers, for hosts building a custom loop.
export { createPlan } from './agent/planner.js'
export { executeStep, shouldReplan, splitBlocker } from './agent/executor.js'
export { decideReplan } from './agent/replanner.js'
export { synthesizeAnswer } from './agent/synthesizer.js'
export type { AgentContext } from './agent/internal.js'

// ── Config ───────────────────────────────────────────────────────────────────
export { resolveConfig } from './config.js'
export type {
  BrowserAgentConfig,
  ResolvedConfig,
  PhaseBudgets,
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
export { openAgentWebDB, KEYS_STORE, SECRETS_STORE, SESSIONS_STORE } from './storage/db.js'
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

// ── Memory ───────────────────────────────────────────────────────────────────
export { MemoryStore } from './memory/store.js'
export type { ContextStore, StoredMessage } from './memory/store.js'
export { IndexedDBStore } from './memory/sessions.js'
export type { IndexedDBStoreOptions } from './memory/sessions.js'
export { compressHistory } from './memory/compress.js'
export type { CompressOptions } from './memory/compress.js'

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
export type { AgentEvent, AgentEventHandler, ReplanMode, Phase } from './events.js'

// ── Logging ──────────────────────────────────────────────────────────────────
export { createLogger } from './logger.js'
export type { AgentLogger, AgentLoggerSink, LogLevel } from './logger.js'
