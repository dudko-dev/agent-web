import { asSchema, jsonSchema, tool, type Tool, type ToolSet } from 'ai'
import type { AgentTool, AgentToolSet } from '../tools/types.js'

/**
 * WebMCP — the browser's tool API for pages (https://webmachinelearning.github.io/webmcp/).
 *
 * A page registers named, typed tools with `document.modelContext.registerTool(tool, { signal })`
 * and a browser's agent (Chrome's origin trial, Edge, an extension, an in-page agent) can discover
 * and call them. This module bridges that API and an agent's `ToolSet`, in both directions:
 *
 *  - {@link registerWebMcpTools} PUBLISHES a ToolSet to the page's model context, so the tools
 *    an in-page agent uses can also be driven by any agent of the browser — one definition, two
 *    consumers.
 *  - {@link connectWebMcp} CONSUMES the tools a page has registered (its own, or another
 *    script's) as an agent ToolSet.
 *
 * Browser-only, no extra dependency, and a no-op where the browser has no WebMCP. Two API
 * generations are handled: the current one on `document.modelContext` (registration returns a
 * promise, a tool is withdrawn by aborting its signal) and Chrome's early preview on
 * `navigator.modelContext` (`unregisterTool(name)`).
 */

/** What WebMCP registers: a tool a browser agent can call. */
export interface WebMcpToolDefinition {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean; consequentialHint?: boolean }
  execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>
}

/** What a page's `getTools()` returns for one tool. */
export interface RegisteredWebMcpTool {
  name: string
  description?: string
  /** The specification stringifies it; an object is accepted too. */
  inputSchema?: string | Record<string, unknown>
  annotations?: { readOnlyHint?: boolean }
}

/** The parts of `ModelContext` this module uses. */
export interface ModelContextLike {
  registerTool: (tool: WebMcpToolDefinition, options?: { signal?: AbortSignal }) => unknown
  unregisterTool?: (name: string) => unknown
  getTools?: (options?: unknown) => Promise<RegisteredWebMcpTool[]>
  executeTool?: (
    tool: RegisteredWebMcpTool,
    input?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>
  addEventListener?: (type: string, listener: () => void) => void
  removeEventListener?: (type: string, listener: () => void) => void
}

/** The page's model context, wherever this browser puts it; undefined when there is none. */
export const findModelContext = (
  doc: { modelContext?: unknown } | undefined = typeof document !== 'undefined'
    ? (document as unknown as { modelContext?: unknown })
    : undefined,
): ModelContextLike | undefined => {
  const nav =
    typeof navigator !== 'undefined' ? (navigator as { modelContext?: unknown }) : undefined
  return [doc?.modelContext, nav?.modelContext].find(
    (c): c is ModelContextLike =>
      !!c && typeof (c as { registerTool?: unknown }).registerTool === 'function',
  )
}

export const isWebMcpAvailable = (): boolean => findModelContext() !== undefined

export interface WebMcpPublishOptions {
  /**
   * Prepended to every tool name. WebMCP tools of a page share one namespace with whatever else
   * the page (or an extension) registers, so a prefix such as `myapp_` avoids collisions. Names may
   * contain ASCII letters, digits, `_`, `-` and `.`, at most 128 characters.
   */
  prefix?: string
  /** Publish only these tools (by their name in the ToolSet). */
  only?: string[]
  /** Never publish these tools. */
  except?: string[]
  /** Tools whose effect is significant or hard to reverse: annotated `consequentialHint`. */
  consequential?: string[]
  /** Register on this context instead of the page's. */
  context?: ModelContextLike
  /** Aborting withdraws every tool this call registered. */
  signal?: AbortSignal
}

export interface WebMcpRegistration {
  /** The tool names that were registered. */
  names: string[]
  /** Withdraw the tools. Safe to call twice. */
  unregister: () => void
}

const NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** A tool's result in the shape WebMCP clients read: text content, structured results as JSON. */
const asContent = (result: unknown) => ({
  content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
})

/** AI SDK 7 lets a tool's description depend on the run's context; WebMCP needs a plain string. */
const describe = (t: Tool): string => {
  const d = t.description as unknown
  return typeof d === 'function'
    ? String((d as (o: { context: undefined }) => string)({ context: undefined }))
    : (d as string) || ''
}

const inputSchemaOf = async (t: Tool): Promise<Record<string, unknown>> => {
  if (!t.inputSchema) return { type: 'object', properties: {} }
  const schema = (await asSchema(t.inputSchema as never).jsonSchema) as Record<string, unknown>
  const { $schema: _ignored, ...rest } = schema
  return rest
}

/**
 * The WebMCP definitions of a ToolSet, without registering them. A tool without an `execute`
 * (the model's side of a client tool) is left out, as are names WebMCP does not allow.
 */
export const toWebMcpTools = async (
  tools: ToolSet,
  options: Pick<WebMcpPublishOptions, 'prefix' | 'only' | 'except' | 'consequential'> = {},
): Promise<WebMcpToolDefinition[]> => {
  const out: WebMcpToolDefinition[] = []
  for (const [key, t] of Object.entries(tools)) {
    if (options.only && !options.only.includes(key)) continue
    if (options.except?.includes(key)) continue
    const name = `${options.prefix ?? ''}${key}`
    if (!NAME.test(name) || typeof t.execute !== 'function') continue
    const execute = t.execute
    out.push({
      name,
      title: key.replace(/[_-]+/g, ' '),
      description: describe(t) || key,
      inputSchema: await inputSchemaOf(t),
      annotations: {
        readOnlyHint: (t as AgentTool).readOnly === true,
        ...(options.consequential?.includes(key) ? { consequentialHint: true } : {}),
      },
      // WebMCP calls execute with a signal; the SDK's tools want the SDK's call options.
      execute: async (input, opts) =>
        asContent(
          await (execute as (i: unknown, o: unknown) => unknown)(input, {
            toolCallId: `webmcp-${name}`,
            messages: [],
            abortSignal: opts?.signal,
            context: undefined,
          }),
        ),
    })
  }
  return out
}

/**
 * Publish a ToolSet to the page's WebMCP model context. Resolves to undefined where the browser
 * has no WebMCP. A tool the browser refuses (a name already taken, a permissions policy) is
 * skipped, not thrown, and never leaves an unhandled rejection.
 *
 * @example
 *   const reg = await registerWebMcpTools(editorTools, { prefix: 'editor_', signal })
 *   // later: reg?.unregister()
 */
export const registerWebMcpTools = async (
  tools: ToolSet,
  options: WebMcpPublishOptions = {},
): Promise<WebMcpRegistration | undefined> => {
  const context = options.context ?? findModelContext()
  if (!context) return undefined
  const controller = new AbortController()
  const names: string[] = []
  for (const def of await toWebMcpTools(tools, options)) {
    try {
      const result = context.registerTool(def, { signal: controller.signal })
      // current API: a promise that rejects for a duplicate name or a refused policy
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        ;(result as Promise<unknown>).catch(() => undefined)
      }
      names.push(def.name)
    } catch {
      /* skip this tool */
    }
  }
  let done = false
  const unregister = () => {
    if (done) return
    done = true
    controller.abort()
    // the early-preview API has no signal: withdraw by name
    if (typeof context.unregisterTool === 'function') {
      for (const name of names) {
        try {
          context.unregisterTool(name)
        } catch {
          /* already gone */
        }
      }
    }
  }
  options.signal?.addEventListener('abort', unregister, { once: true })
  if (options.signal?.aborted) unregister()
  return { names, unregister }
}

export interface ConnectWebMcpOptions {
  /** Read tools from this context instead of the page's. */
  context?: ModelContextLike
  /** Skip tools whose name this returns false for (e.g. the ones the page itself publishes from this agent's ToolSet). */
  filter?: (tool: RegisteredWebMcpTool) => boolean
  /** Called when the page's tool list changes (`toolchange`); `refresh()` has already run. */
  onToolsChanged?: (tools: AgentToolSet) => void
}

export interface ConnectedWebMcp {
  /** The page's tools as an agent ToolSet. Mutated in place by `refresh()`, so an agent that holds it sees changes. */
  tools: AgentToolSet
  /** Read the page's tool list again. */
  refresh: () => Promise<void>
  /** Stop listening for changes. */
  close: () => void
}

const parseSchema = (s: RegisteredWebMcpTool['inputSchema']): Record<string, unknown> => {
  if (!s) return { type: 'object', properties: {} }
  if (typeof s !== 'string') return s
  try {
    const parsed = JSON.parse(s)
    return parsed && typeof parsed === 'object' ? parsed : { type: 'object', properties: {} }
  } catch {
    return { type: 'object', properties: {} }
  }
}

/** A WebMCP result is stringified JSON text, or MCP-style content; hand the model something readable. */
const readResult = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw
  try {
    const parsed = JSON.parse(raw)
    const content = (parsed as { content?: { type?: string; text?: string }[] })?.content
    if (Array.isArray(content) && content.every((c) => c?.type === 'text')) {
      const text = content.map((c) => c.text ?? '').join('\n')
      try {
        return JSON.parse(text)
      } catch {
        return text
      }
    }
    return parsed
  } catch {
    return raw
  }
}

/**
 * Use the tools a page has registered as an agent's tools: `getTools()` once, then
 * `executeTool()` for each call. Resolves to undefined where the browser has no WebMCP (or no
 * `getTools`).
 *
 * @example
 *   const web = await connectWebMcp()
 *   const agent = await createAgent({ model, tools: { ...myTools, ...web?.tools } })
 */
export const connectWebMcp = async (
  options: ConnectWebMcpOptions = {},
): Promise<ConnectedWebMcp | undefined> => {
  const context = options.context ?? findModelContext()
  if (
    !context ||
    typeof context.getTools !== 'function' ||
    typeof context.executeTool !== 'function'
  ) {
    return undefined
  }
  const tools: AgentToolSet = {}
  const refresh = async () => {
    const registered = await context.getTools!()
    for (const key of Object.keys(tools)) delete tools[key]
    for (const rt of registered) {
      if (options.filter && !options.filter(rt)) continue
      const t = tool({
        description: rt.description || rt.name,
        inputSchema: jsonSchema<Record<string, unknown>>(parseSchema(rt.inputSchema) as never),
        execute: async (input, opts) =>
          readResult(await context.executeTool!(rt, input, { signal: opts?.abortSignal })),
      }) as AgentTool
      if (rt.annotations?.readOnlyHint) t.readOnly = true
      tools[rt.name] = t
    }
  }
  await refresh()
  const onChange = () => {
    void refresh().then(() => options.onToolsChanged?.(tools))
  }
  context.addEventListener?.('toolchange', onChange)
  return {
    tools,
    refresh,
    close: () => context.removeEventListener?.('toolchange', onChange),
  }
}
