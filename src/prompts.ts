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
 * Layout matters for prompt caching: the SYSTEM part holds only what is stable
 * for a whole run (role, skills, the planner's tool catalogue), the user
 * prompt holds everything that changes (goal, state, history, progress), so a
 * provider's prefix cache can reuse the system part across calls.
 *
 * The agent is autonomous by design: it plans tool use for anything the tools
 * can do or look up, never asks the user for confirmation (consent is the
 * host's `toolApproval` policy), and states assumptions instead of asking.
 *
 * Override any builder via `BrowserAgentConfig.prompts`.
 */

import { clip } from './llm/util.js'

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
  /** "- name: description" index of the configured skills, when any. */
  skills?: string
  /** The catalogue is condensed and the executor can search the rest (large catalogues). */
  searchMode?: boolean
}
export interface ExecutorPromptContext {
  goal: string
  state?: string
  step: string
  index: number
  total: number
  toolCatalog: string
  /** Earlier steps of this run, each with its outcome and key data. */
  done: string[]
  mode: ToolCallMode
  /** "- name: description" index of the configured skills, when any. */
  skills?: string
  /** Full instructions of the skills active in this run. */
  activeSkills?: string
  /** The executor can call find_tools to activate more tools. */
  searchMode?: boolean
}
export interface ReplannerPromptContext {
  goal: string
  state?: string
  done: string[]
  remaining: string[]
  mode: ToolCallMode
  activeSkills?: string
}
export interface SynthesizerPromptContext {
  goal: string
  state?: string
  done: string[]
  /** Excerpts of what the tools returned, for answering with real data. */
  findings?: string[]
  activeSkills?: string
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

// The last few session messages, capped so a long transcript can't crowd out
// the goal (memory compression keeps the full story in a summary message).
const historyBlock = (history?: { role: string; content: string }[]): string => {
  if (!history || history.length === 0) return ''
  const lines = history.slice(-8).map((m) => `${m.role}: ${clip(m.content, 400)}`)
  return `\n\nCONVERSATION SO FAR:\n${lines.join('\n')}`
}

const section = (title: string, body?: string): string =>
  body && body.trim() ? `\n\n${title}:\n${body.trim()}` : ''

// --- planner ---------------------------------------------------------------

const PLANNER_RULES = `- Act autonomously: whenever the TOOLS can do the work or look up the answer, plan the steps — a question that needs data, a lookup or a check is a real goal too.
- Never plan a step that asks the user something. If the request is ambiguous, pick the most reasonable interpretation and say which one you chose.
- Plan realistic steps the available TOOLS can perform, grounded in the current STATE.
- If a CONVERSATION SO FAR section is present, use it to resolve references to earlier turns.
- Never repeat or pad steps.`

const PLANNER_NATIVE = `You are the PLANNER of an autonomous tool-using agent that works step by step.
Produce a brief "thought" and an ordered "steps" list (1–6 DISTINCT, self-contained steps).
Return an EMPTY steps list ONLY for a pure greeting, thanks or small talk, or a question you can answer completely from the STATE and general knowledge without any tool — then put the answer itself in "thought".
${PLANNER_RULES}`

const PLANNER_PROMPTED = `You are the PLANNER of an autonomous tool-using agent that works step by step.

Reply with a single JSON object, nothing else:
{ "reply": string, "plan": string[], "skills": string[] }
- For a real goal: "reply" is one short sentence; "plan" is 1–6 DISTINCT, self-contained steps.
- Set "plan": [] ONLY for a pure greeting, thanks or small talk, or a question you can answer completely from the STATE and general knowledge without any tool — then put the answer itself in "reply".
${PLANNER_RULES}`

const PLANNER_SKILLS = `\nIf a SKILLS list is present, list the names of the skills that apply to this goal in "skills" (or leave it empty).`

const PLANNER_SEARCH = `\nThe TOOLS list may be abbreviated: the executor can search the full catalogue, so describe WHAT to do; name tools only when you see them listed.`

// --- executor --------------------------------------------------------------

const EXECUTOR_RULES = `- Work autonomously: never ask the user questions or for confirmation. Look things up with the tools, choose sensible defaults, and state any assumption in your reply. Permission to run tools is handled by the system, not by you.
- Build on the current STATE and on the results of earlier steps — do not repeat work that is already done.`

const EXECUTOR_NATIVE = `You are the EXECUTOR of an autonomous tool-using agent. Carry out ONLY the current step by calling the provided tools.
${EXECUTOR_RULES}
- When the step is done, reply with a short factual summary of what you did and found, including the concrete data (names, ids, numbers, values) later steps or the final answer need. No JSON.
- If you truly CANNOT complete the step (a needed tool is missing or was denied, credentials or data are unavailable), explain why in one sentence and include the token [BLOCKER].`

const EXECUTOR_PROMPTED = `You are the EXECUTOR of an autonomous tool-using agent. Carry out ONLY the current step by emitting tool calls.

Reply with a single JSON object, nothing else:
{ "reply": string, "actions": [ { "tool": string, "args": object } ] }
- "actions" are the tool calls for THIS step ([] if none are needed). Use ONLY tools from the TOOLS list; "args" must match the tool's parameters.
${EXECUTOR_RULES}
- "reply" is a short factual summary (no JSON) of what you did and found, with the concrete data later steps need.
- After your actions run you will see their TOOL RESULTS and may continue the same step; finish with "actions": [] once it is done.
- If you truly CANNOT complete the step, set "actions": [] and put the token [BLOCKER] in "reply" with a short reason.`

const EXECUTOR_SEARCH = `\n- If a tool you need is not in your current tool list, call find_tools with keywords; the tools it returns become callable right after.`

const EXECUTOR_SKILLS = `\n- If a skill from the SKILLS list covers this step, call load_skill to read it first (read_skill_file for its bundled files).`

// --- replanner -------------------------------------------------------------

const REPLANNER_RULES = `Judge from the current STATE and the progress vs the goal. Prefer "continue".
After a failure, prefer revising around it (another tool, another approach) over giving up; never add a step that asks the user something.`

const REPLANNER_NATIVE = `You are the REPLANNER of an autonomous agent. After an executed step, decide whether to keep going, revise the remaining steps, or finish.
"continue": the remaining steps still fit. "revise": provide a better "plan" for the REMAINING work (never repeat done work). "finish": the goal is already met.
${REPLANNER_RULES}`

const REPLANNER_PROMPTED = `You are the REPLANNER of an autonomous agent. After each executed step you decide whether to keep going, revise the remaining steps, or finish.

Reply with a single JSON object, nothing else:
{ "decision": "continue" | "revise" | "finish", "reason": string, "plan": string[] }
- "continue": remaining steps still fit — proceed (omit "plan").
- "revise": replace the REMAINING steps with a better list in "plan"; never repeat done work.
- "finish": the goal is already met — stop (omit "plan").
${REPLANNER_RULES}`

const SYNTHESIZER_SYSTEM = `You are the SYNTHESIZER. Answer the user's goal from what the agent did and found.
- Lead with the result: the concrete data, from the FINDINGS verbatim when accuracy matters (names, numbers, ids), then — briefly — what was changed.
- Mention any assumption the agent made. If something could not be done, say so plainly and why.
- Do not ask follow-up questions unless the goal genuinely cannot be completed without the user.
- Be concise and friendly. Plain text (light markdown is fine) — no JSON, no code.`

export const defaultPrompts: Prompts = {
  planner: (ctx) => ({
    system:
      (ctx.mode === 'prompted' ? PLANNER_PROMPTED : PLANNER_NATIVE) +
      (ctx.skills ? PLANNER_SKILLS : '') +
      (ctx.searchMode ? PLANNER_SEARCH : '') +
      section('SKILLS', ctx.skills) +
      `\n\nTOOLS:\n${ctx.toolCatalog}`,
    prompt: `GOAL: ${ctx.goal}${historyBlock(ctx.history)}${stateBlock(ctx.state)}`,
  }),
  executor: (ctx) => ({
    system:
      (ctx.mode === 'prompted' ? EXECUTOR_PROMPTED : EXECUTOR_NATIVE) +
      (ctx.searchMode ? EXECUTOR_SEARCH : '') +
      (ctx.skills ? EXECUTOR_SKILLS : '') +
      section('SKILLS', ctx.skills) +
      section('ACTIVE SKILL INSTRUCTIONS', ctx.activeSkills),
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
    system:
      (ctx.mode === 'prompted' ? REPLANNER_PROMPTED : REPLANNER_NATIVE) +
      section('ACTIVE SKILL INSTRUCTIONS', ctx.activeSkills),
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
    system: SYNTHESIZER_SYSTEM + section('ACTIVE SKILL INSTRUCTIONS', ctx.activeSkills),
    prompt: [
      `GOAL: ${ctx.goal}`,
      stateBlock(ctx.state).trimStart(),
      `What was done:\n${numbered(ctx.done, '(no changes)')}`,
      ctx.findings?.length ? `FINDINGS (tool results):\n${ctx.findings.join('\n')}` : '',
      'Write the final answer for the user.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  }),
}

/** Prepend a host-supplied systemPrompt to a phase system prompt, if present. */
export const withSystem = (base: string, extra?: string): string =>
  extra && extra.trim() ? `${extra.trim()}\n\n${base}` : base
