/**
 * Default phase prompts. Each builder returns `{ system, prompt }` strings.
 * Because the agent runs in two tool-modes, the builders switch on `ctx.mode`:
 *
 * - `native`   — the model calls tools / emits schema-constrained JSON via the
 *   AI SDK, so the prompts describe the task and let the SDK enforce structure.
 * - `prompted` — weak local models can't do that reliably, so the prompts spell
 *   out an exact JSON shape and (for the executor) include a tool catalogue;
 *   the output is salvaged by parse.ts.
 *
 * Override any builder via `BrowserAgentConfig.prompts`.
 */

export type ToolCallMode = 'native' | 'prompted'

export interface PromptParts {
  system: string
  prompt: string
}

export interface PlannerPromptContext {
  goal: string
  state?: string
  toolCatalog: string
  mode: ToolCallMode
  /** Prior session messages (oldest first), for resolving references to earlier turns. */
  history?: { role: string; content: string }[]
}
export interface ExecutorPromptContext {
  goal: string
  state?: string
  step: string
  index: number
  total: number
  toolCatalog: string
  done: string[]
  mode: ToolCallMode
}
export interface ReplannerPromptContext {
  goal: string
  state?: string
  done: string[]
  remaining: string[]
  mode: ToolCallMode
}
export interface SynthesizerPromptContext {
  goal: string
  state?: string
  done: string[]
}

export interface Prompts {
  planner(ctx: PlannerPromptContext): PromptParts
  executor(ctx: ExecutorPromptContext): PromptParts
  replanner(ctx: ReplannerPromptContext): PromptParts
  synthesizer(ctx: SynthesizerPromptContext): PromptParts
}

const numbered = (items: string[], empty: string): string =>
  items.length ? items.map((s, i) => `${i + 1}. ${s}`).join('\n') : empty

const stateBlock = (state?: string): string => (state && state.trim() ? `\n\nSTATE:\n${state}` : '')

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// The last few session messages, capped so a long transcript can't crowd out
// the goal (memory compression keeps the full story in a summary message).
const historyBlock = (history?: { role: string; content: string }[]): string => {
  if (!history || history.length === 0) return ''
  const lines = history.slice(-8).map((m) => `${m.role}: ${clip(m.content, 400)}`)
  return `\n\nCONVERSATION SO FAR:\n${lines.join('\n')}`
}

// --- planner ---------------------------------------------------------------

const PLANNER_NATIVE = `You are the PLANNER of a tool-using agent that changes a workspace step by step.
Produce a brief "thought" and an ordered "steps" list (1–6 DISTINCT, self-contained steps) grounded in the current STATE and the available TOOLS.
If the user only greets, thanks, makes small talk, asks a question, or is unclear: return an EMPTY steps list and put a short, friendly answer in "thought".
If a CONVERSATION SO FAR section is present, use it to resolve references to earlier turns.
Never repeat or pad steps.`

const PLANNER_PROMPTED = `You are the PLANNER of a tool-using agent that changes a workspace step by step.

Reply with a single JSON object, nothing else:
{ "reply": string, "plan": string[] }
- Only produce a "plan" when the user CLEARLY asks to build, do, or change something. For a greeting, small talk, thanks, a question, or an unclear/empty request: set "plan": [] and put a short, friendly "reply".
- For a real goal: "reply" is one short sentence; "plan" is 1–6 DISTINCT, self-contained steps. Never repeat or pad steps.
- Plan realistic steps the available TOOLS can perform, grounded in the current STATE.
- If a CONVERSATION SO FAR section is present, use it to resolve references to earlier turns.`

// --- executor --------------------------------------------------------------

const EXECUTOR_NATIVE = `You are the EXECUTOR of a tool-using agent. Carry out ONLY the current step by calling the provided tools.
Build on the current STATE — do not repeat work that is already there.
When the step is done, reply with one short human sentence describing what you did (no JSON).
If you CANNOT complete the step (a needed tool is missing or an input is unavailable), explain why in one sentence and include the token [BLOCKER].`

const EXECUTOR_PROMPTED = `You are the EXECUTOR of a tool-using agent. Carry out ONLY the current step by emitting tool calls.

Reply with a single JSON object, nothing else:
{ "reply": string, "actions": [ { "tool": string, "args": object } ] }
- "actions" are the tool calls for THIS step ([] if none are needed). Use ONLY tools from the TOOLS list; "args" must match the tool's parameters.
- Build on the current STATE — do not repeat work that is already there.
- "reply" is one short human sentence (no JSON) describing what you did.
- If you CANNOT complete the step, set "actions": [] and put the token [BLOCKER] in "reply" with a short reason.`

// --- replanner -------------------------------------------------------------

const REPLANNER_NATIVE = `You are the REPLANNER. After a step that was blocked or had a failed tool call, decide whether to keep going, revise the remaining steps, or finish.
"continue": the remaining steps still fit. "revise": provide a better "plan" for the REMAINING work (never repeat done work). "finish": the goal is already met.
Judge from the current STATE vs the goal. Prefer "continue".`

const REPLANNER_PROMPTED = `You are the REPLANNER. After each executed step you decide whether to keep going, revise the remaining steps, or finish.

Reply with a single JSON object, nothing else:
{ "decision": "continue" | "revise" | "finish", "reason": string, "plan": string[] }
- "continue": remaining steps still fit — proceed (omit "plan").
- "revise": replace the REMAINING steps with a better list in "plan"; never repeat done work.
- "finish": the goal is already met — stop (omit "plan").
Judge from the current STATE vs the goal. Prefer "continue".`

const SYNTHESIZER_SYSTEM = `You are the SYNTHESIZER. In 1–3 short, friendly sentences, tell the user what was done to meet their goal. Be concrete. Output plain text only — no JSON, no code.`

export const defaultPrompts: Prompts = {
  planner: (ctx) => ({
    system: ctx.mode === 'prompted' ? PLANNER_PROMPTED : PLANNER_NATIVE,
    prompt: `GOAL: ${ctx.goal}${historyBlock(ctx.history)}${stateBlock(ctx.state)}\n\nTOOLS:\n${ctx.toolCatalog}`,
  }),
  executor: (ctx) => ({
    system: ctx.mode === 'prompted' ? EXECUTOR_PROMPTED : EXECUTOR_NATIVE,
    prompt: [
      `GOAL: ${ctx.goal}`,
      stateBlock(ctx.state).trimStart(),
      ctx.mode === 'prompted' ? `TOOLS:\n${ctx.toolCatalog}` : '',
      ctx.done.length ? `Already done:\n${numbered(ctx.done, '')}` : '',
      `STEP ${ctx.index}/${ctx.total}: ${ctx.step}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  replanner: (ctx) => ({
    system: ctx.mode === 'prompted' ? REPLANNER_PROMPTED : REPLANNER_NATIVE,
    prompt: [
      `GOAL: ${ctx.goal}`,
      stateBlock(ctx.state).trimStart(),
      `Already done:\n${numbered(ctx.done, '(nothing yet)')}`,
      `Remaining plan:\n${numbered(ctx.remaining, '(none)')}`,
      'Decide: continue, revise, or finish.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
  synthesizer: (ctx) => ({
    system: SYNTHESIZER_SYSTEM,
    prompt: [
      `GOAL: ${ctx.goal}`,
      stateBlock(ctx.state).trimStart(),
      `What was done:\n${numbered(ctx.done, '(no changes)')}`,
      'Write the final summary for the user.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
}

/** Prepend a host-supplied systemPrompt to a phase system prompt, if present. */
export const withSystem = (base: string, extra?: string): string =>
  extra && extra.trim() ? `${extra.trim()}\n\n${base}` : base
