import { z } from 'zod'
import type { VirtualFileSystem } from './files/vfs.js'
import {
  defineSkill,
  parseSkillMarkdown,
  SKILL_NAME_RE,
  type Skill,
  type SkillOrigin,
} from './skills.js'
import { defineTool } from './tools/define.js'
import type { AgentToolSet } from './tools/types.js'
import { toolRunContextOf } from './tools/wrap.js'

// The agent keeps a notebook that outlives a task. The browser sibling of `learning.ts` in
// @dudko.dev/agent - same names, same guards.
//
// When it hits a problem and finds the way around it - a tool error it resolved, a wrong
// assumption it corrected, a procedure it had to look up - it writes the lesson down as a SKILL
// (the same agentskills.io shape as the host's own), and from then on that skill is in the SKILLS
// index of the planner and the executor, loadable with load_skill, for the rest of the open
// session (and across sessions if the store persists).
//
// What it may change is knowledge, never policy. A lesson is text the model reads later: it
// cannot alter the approval mode, the egress policy, the tool set or any limit, and every tool it
// is advised to call still goes through the same gates. And because a lesson may have been
// written after reading a web page, it is treated as what it is - a hint from experience, not an
// instruction from the user:
//
//  - saving goes through the approval gate like any write (ask-writes asks the human);
//  - nothing that looks like a credential is stored; size and count are capped;
//  - a host's skill is never overwritten; only the agent's own can be updated or forgotten;
//  - each lesson records where it came from: the run, the sources the model named, and - not
//    chosen by the model - every page web_fetch read during that run;
//  - when loaded, a lesson is introduced as a note of the agent's own, subordinate to the user.

export const SAVE_SKILL_TOOL = 'save_skill'
export const FORGET_SKILL_TOOL = 'forget_skill'
export const DEFAULT_MAX_LEARNED_SKILLS = 50
export const DEFAULT_MAX_SKILL_CHARS = 6_000
const MAX_DESCRIPTION_CHARS = 300
const MIN_INSTRUCTIONS_CHARS = 20

/** Where learned skills are kept. {@link MemorySkillStore} and {@link VfsSkillStore} are provided. */
export interface SkillStore {
  list(): Skill[] | Promise<Skill[]>
  save(skill: Skill): void | Promise<void>
  /** false when there was nothing to remove. */
  remove(name: string): boolean | Promise<boolean>
}

export interface LearningConfig {
  /** Where lessons are kept. Default: in memory, for the life of the agent (the open session). */
  store?: SkillStore
  /** At most this many lessons (default 50). */
  maxSkills?: number
  /** At most this many characters of instructions per lesson (default 6000). */
  maxSkillChars?: number
  /** false keeps the tools but drops the executor guidance to write lessons down (default true). */
  nudge?: boolean
}

// Credentials are the one thing a notebook must never keep: it is read back into prompts, shown
// in UIs and (with a persistent store) written to IndexedDB.
const SECRET_PATTERNS: [string, RegExp][] = [
  ['an API key (sk-...)', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
  ['a GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['an AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  [
    'a password or secret assignment',
    /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
  ],
]

/** What a credential looks like, or undefined. */
export const findSecret = (text: string): string | undefined =>
  SECRET_PATTERNS.find(([, re]) => re.test(text))?.[0]

/** "My Trick_1" -> "my-trick-1"; undefined when nothing usable is left. */
export const normalizeSkillName = (raw: string): string | undefined => {
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64)
    .replace(/-$/, '')
  return SKILL_NAME_RE.test(name) ? name : undefined
}

// A URL kept as origin + path: a query string can carry a secret.
export const plainUrl = (raw: string): string => {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return raw.slice(0, 120)
  }
}

// ── stores ───────────────────────────────────────────────────────────────────

/** Lives as long as the agent: the "open session". */
export class MemorySkillStore implements SkillStore {
  private readonly skills = new Map<string, Skill>()

  list(): Skill[] {
    return [...this.skills.values()]
  }

  save(skill: Skill): void {
    this.skills.set(skill.name, skill)
  }

  remove(name: string): boolean {
    return this.skills.delete(name)
  }
}

const ORIGIN_FILE = '.origin.json'

/**
 * `<dir>/<name>/SKILL.md` in the agent's virtual file system (IndexedDB, or memory): the user can
 * see and edit lessons in the files panel like any file. A sidecar `.origin.json` says where each
 * came from. Default dir `/skills`.
 */
export class VfsSkillStore implements SkillStore {
  private readonly vfs: VirtualFileSystem
  private readonly dir: string

  constructor(vfs: VirtualFileSystem, dir = '/skills') {
    this.vfs = vfs
    this.dir = dir.replace(/\/+$/, '') || '/skills'
  }

  async list(): Promise<Skill[]> {
    const out: Skill[] = []
    for (const info of await this.vfs.list(this.dir)) {
      const m = /^(.+)\/([^/]+)\/SKILL\.md$/.exec(info.path)
      if (!m || m[1] !== this.dir) continue
      const file = await this.vfs.read(info.path)
      if (!file) continue
      try {
        const skill = parseSkillMarkdown(file.content)
        const side = await this.vfs.read(`${this.dir}/${m[2]}/${ORIGIN_FILE}`)
        out.push(side ? { ...skill, origin: JSON.parse(side.content) as SkillOrigin } : skill)
      } catch {
        /* a file that is not a skill is not ours to judge */
      }
    }
    return out
  }

  async save(skill: Skill): Promise<void> {
    if (!SKILL_NAME_RE.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
    const folder = `${this.dir}/${skill.name}`
    const markdown = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trim()}\n`
    await this.vfs.write(`${folder}/SKILL.md`, markdown, { mimeType: 'text/markdown' })
    if (skill.origin) {
      await this.vfs.write(`${folder}/${ORIGIN_FILE}`, JSON.stringify(skill.origin, null, 2), {
        mimeType: 'application/json',
      })
    }
  }

  async remove(name: string): Promise<boolean> {
    if (!SKILL_NAME_RE.test(name)) return false
    const folder = `${this.dir}/${name}`
    const had = await this.vfs.delete(`${folder}/SKILL.md`)
    await this.vfs.delete(`${folder}/${ORIGIN_FILE}`)
    return had
  }
}

// ── learning ─────────────────────────────────────────────────────────────────

export interface Learning {
  /** The tools the model learns with (normal tools: gated, counted). */
  tools: AgentToolSet
  /** The agent's own skills (not the host's). */
  learned: () => Skill[]
  /** Forget one of them. false when there is no such learned skill. */
  forget: (
    name: string,
    emit?: (event: { type: 'skill.forgotten'; name: string }) => void,
  ) => Promise<boolean>
}

export interface SaveSkillInput {
  name: string
  description: string
  instructions: string
  sources?: string[]
}

/**
 * Wires learning to the agent's LIVE skill list (`skills` is mutated in place, so every prompt
 * that renders the index sees a new lesson at once).
 */
export const createLearning = async (
  cfg: LearningConfig,
  skills: Skill[],
  warn: (message: string) => void,
): Promise<Learning> => {
  const store = cfg.store ?? new MemorySkillStore()
  const maxSkills = Math.max(1, cfg.maxSkills ?? DEFAULT_MAX_LEARNED_SKILLS)
  const maxChars = Math.max(MIN_INSTRUCTIONS_CHARS, cfg.maxSkillChars ?? DEFAULT_MAX_SKILL_CHARS)

  // What an earlier session wrote. The host's own skills win a name clash.
  for (const stored of await store.list()) {
    try {
      const skill = defineSkill({
        ...stored,
        origin: stored.origin ?? { kind: 'learned', at: 0, revision: 1 },
      })
      if (skills.some((s) => s.name === skill.name)) {
        warn(
          `[learning] a stored lesson named "${skill.name}" clashes with a configured skill; skipped`,
        )
        continue
      }
      skills.push(skill)
    } catch (err) {
      warn(`[learning] a stored lesson was skipped: ${(err as Error).message}`)
    }
  }

  const learned = (): Skill[] => skills.filter((s) => s.origin?.kind === 'learned')

  const save = async (
    input: SaveSkillInput,
    options: unknown,
  ): Promise<{ saved: true; name: string; update: boolean }> => {
    const name = normalizeSkillName(input.name)
    if (!name) {
      throw new Error(
        `"${input.name}" is not a usable skill name - use a few lower-case words with dashes, like "retry-on-429"`,
      )
    }
    const description = input.description.replace(/\s+/g, ' ').trim()
    if (!description) {
      throw new Error(
        'say in `description` WHEN this lesson applies - it is what you will search by later',
      )
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      throw new Error(`keep \`description\` under ${MAX_DESCRIPTION_CHARS} characters`)
    }
    const content = input.instructions.trim()
    if (content.length < MIN_INSTRUCTIONS_CHARS) {
      throw new Error('write the steps that worked in `instructions` - a line is not a lesson')
    }
    if (content.length > maxChars) {
      throw new Error(
        `\`instructions\` is ${content.length} characters; keep it under ${maxChars} - distil it`,
      )
    }
    const sources = (input.sources ?? []).slice(0, 5).map((s) => plainUrl(s))
    // Scanned as given, before the query strings are cut off: a key in one is worth refusing.
    const secret = findSecret([name, description, content, ...(input.sources ?? [])].join('\n'))
    if (secret) {
      throw new Error(
        `refused: this looks like it contains ${secret}. Save the procedure, never the secret - describe where to find it instead`,
      )
    }
    const existing = skills.find((s) => s.name === name)
    if (existing && existing.origin?.kind !== 'learned') {
      throw new Error(
        `"${name}" is a skill the host configured and cannot be changed - pick another name`,
      )
    }
    if (!existing && learned().length >= maxSkills) {
      throw new Error(
        `the notebook is full (${maxSkills} lessons) - update one of your own or forget_skill an outdated one first`,
      )
    }
    const run = toolRunContextOf(options)
    const fetched = [...new Set(run?.fetched ?? [])].slice(0, 10)
    const skill = defineSkill({
      name,
      description,
      content,
      origin: {
        kind: 'learned',
        at: Date.now(),
        revision: (existing?.origin?.revision ?? 0) + 1,
        ...(run?.runId ? { runId: run.runId } : {}),
        ...(sources.length ? { sources } : {}),
        ...(fetched.length ? { fetched } : {}),
      },
    })
    await store.save(skill)
    const at = skills.findIndex((s) => s.name === name)
    if (at >= 0) skills[at] = skill
    else skills.push(skill)
    run?.emit({
      type: 'skill.learned',
      name,
      description,
      update: Boolean(existing),
      chars: content.length,
      sources: [...sources, ...fetched],
    })
    return { saved: true, name, update: Boolean(existing) }
  }

  const forget: Learning['forget'] = async (rawName, emit) => {
    const at = skills.findIndex((s) => s.name === rawName && s.origin?.kind === 'learned')
    if (at < 0) return false
    await store.remove(rawName)
    skills.splice(at, 1)
    emit?.({ type: 'skill.forgotten', name: rawName })
    return true
  }

  const tools: AgentToolSet = {
    [SAVE_SKILL_TOOL]: defineTool({
      description:
        'Write down a lesson so you can reuse it later in this session: what you did when you got stuck and what worked. ' +
        'Call it once you have SOLVED a problem that was not obvious - a tool error you worked around, an assumption you had wrong, a procedure you had to look up. ' +
        'Write it for your future self at the START of the same kind of task: begin with what to do from the very first call so the problem never happens, and mention the approach that failed only as what to avoid. Do not retell what happened. ' +
        'It becomes a skill in the SKILLS list; load_skill reads it back. Never put secrets, keys or personal data in it. ' +
        'Saving the same name again updates your earlier lesson.',
      inputSchema: z.object({
        name: z.string().describe('A few lower-case words with dashes, e.g. "retry-on-429"'),
        description: z
          .string()
          .describe(
            `WHEN to use this lesson, in one sentence (under ${MAX_DESCRIPTION_CHARS} characters)`,
          ),
        instructions: z
          .string()
          .describe(
            'What to do NEXT TIME, in order, starting from the approach that works (e.g. `Pass format "jpg"`). The approach that failed goes last, as what to avoid. Short markdown, not a story of what happened.',
          ),
        sources: z
          .array(z.string())
          .max(5)
          .optional()
          .describe('Where the solution came from (URLs, doc names), if you looked it up'),
      }),
      promptHint: '{ name: string, description: string, instructions: string, sources?: string[] }',
      execute: async (input: SaveSkillInput, options: unknown) => save(input, options),
    }),
    [FORGET_SKILL_TOOL]: defineTool({
      description:
        'Delete a lesson YOU wrote earlier that turned out wrong or outdated. Skills the host configured cannot be deleted.',
      inputSchema: z.object({ name: z.string().describe('The name of your own skill') }),
      promptHint: '{ name: string }',
      execute: async ({ name }: { name: string }, options: unknown) => {
        if (!(await forget(name, toolRunContextOf(options)?.emit))) {
          throw new Error(
            `there is no lesson of yours named "${name}" (yours: ${
              learned()
                .map((s) => s.name)
                .join(', ') || 'none'
            })`,
          )
        }
        return { forgotten: true, name }
      },
    }),
  }

  return { tools, learned, forget }
}
