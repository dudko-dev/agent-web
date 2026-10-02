import { jsonSchema, tool, type ToolSet } from 'ai'
import { clip } from './llm/util.js'

/**
 * Skills — reusable instruction bundles in the agentskills.io shape
 * (`SKILL.md` with `name`/`description` frontmatter, a markdown body, optional
 * bundled text files). Progressive disclosure: only the one-line index sits in
 * the prompts; a skill's full instructions enter the context when the planner
 * selects it or the executor loads it with `load_skill`.
 */
export interface Skill {
  /** Stable id: lowercase letters, digits and dashes, 1–64 chars. */
  name: string
  /** When to use it — the only part always shown to the model. */
  description: string
  /** Full instructions (the markdown body of SKILL.md). */
  content: string
  /** Bundled text resources, addressed by skill-relative POSIX paths. */
  files?: { path: string; content: string }[]
}

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Names of the built-in skill tools (reserved when skills are configured). */
export const SKILL_TOOL_NAMES = ['load_skill', 'read_skill_file'] as const

/** Validate a skill definition and return it (throws a precise error). */
export const defineSkill = (skill: Skill): Skill => {
  if (!skill || typeof skill !== 'object') throw new Error('skill must be an object')
  if (typeof skill.name !== 'string' || !SKILL_NAME_RE.test(skill.name)) {
    throw new Error(
      `skill name ${JSON.stringify(skill.name)} is invalid: use 1-64 lowercase letters, digits and dashes`,
    )
  }
  if (typeof skill.description !== 'string' || !skill.description.trim()) {
    throw new Error(`skill "${skill.name}" needs a description`)
  }
  if (typeof skill.content !== 'string') {
    throw new Error(`skill "${skill.name}" needs a content string`)
  }
  for (const f of skill.files ?? []) {
    if (typeof f?.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.includes('..')) {
      throw new Error(`skill "${skill.name}": invalid file path ${JSON.stringify(f?.path)}`)
    }
  }
  return skill
}

const unquote = (v: string): string => {
  const t = v.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'")
  }
  return t
}

/**
 * Parse the small YAML subset SKILL.md frontmatter uses: `key: value` pairs,
 * single/double-quoted values, and `>` / `|` block scalars. Unknown keys are
 * kept (as strings) but ignored by the agent.
 */
const parseFrontmatter = (block: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const [, key, rest] = m
    if (rest === '>' || rest === '|' || rest === '>-' || rest === '|-') {
      const body: string[] = []
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1] === '')) {
        body.push(lines[i + 1].trim())
        i += 1
      }
      out[key] = rest.startsWith('>') ? body.filter(Boolean).join(' ') : body.join('\n').trim()
      continue
    }
    out[key] = unquote(rest)
  }
  return out
}

/**
 * Parse a SKILL.md document into a {@link Skill}. Frontmatter must provide
 * `name` and `description`; the markdown body becomes `content`.
 */
export const parseSkillMarkdown = (
  markdown: string,
  files?: { path: string; content: string }[],
): Skill => {
  const text = (markdown ?? '').replace(/^﻿/, '')
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) throw new Error('SKILL.md must start with a --- frontmatter block (name, description)')
  const meta = parseFrontmatter(m[1])
  return defineSkill({
    name: meta.name ?? '',
    description: meta.description ?? '',
    content: m[2].trim(),
    ...(files?.length ? { files } : {}),
  })
}

export interface LoadSkillOptions {
  /** Bundled files to fetch, relative to the SKILL.md URL. */
  files?: string[]
  fetch?: typeof fetch
}

/** Fetch a SKILL.md (and optionally its bundled files) over HTTP. */
export const loadSkillFromUrl = async (
  url: string,
  opts: LoadSkillOptions = {},
): Promise<Skill> => {
  const fetchFn = opts.fetch ?? globalThis.fetch
  const res = await fetchFn(url)
  if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status}`)
  const markdown = await res.text()
  const files: { path: string; content: string }[] = []
  for (const path of opts.files ?? []) {
    const r = await fetchFn(new URL(path, url).toString())
    if (!r.ok) throw new Error(`could not fetch skill file ${path}: HTTP ${r.status}`)
    files.push({ path, content: await r.text() })
  }
  return parseSkillMarkdown(markdown, files)
}

/** "- name: description" lines for the prompts. */
export const renderSkillIndex = (skills: Skill[]): string =>
  skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`).join('\n')

const ACTIVE_SKILLS_BUDGET = 24_000

/** The full instructions of the active skills, within a total character budget. */
export const renderActiveSkills = (skills: Skill[]): string => {
  let budget = ACTIVE_SKILLS_BUDGET
  const parts: string[] = []
  for (const s of skills) {
    if (budget <= 0) break
    const files = s.files?.length
      ? `\n(bundled files, read with read_skill_file: ${s.files.map((f) => f.path).join(', ')})`
      : ''
    const block = clip(`### Skill: ${s.name}\n${s.content}${files}`, budget)
    budget -= block.length
    parts.push(block)
  }
  return parts.join('\n\n')
}

/**
 * The built-in `load_skill` / `read_skill_file` tools. `onLoad` fires when a
 * skill is loaded so the runner can keep it active for later steps.
 */
export const createSkillTools = (skills: Skill[], onLoad?: (skill: Skill) => void): ToolSet => {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const known = skills.map((s) => s.name).join(', ')
  const loadSkill = tool({
    description:
      'Load the full instructions of a skill from the SKILLS list before doing work it covers.',
    inputSchema: jsonSchema<{ name: string }>({
      type: 'object',
      properties: { name: { type: 'string', description: 'The skill name' } },
      required: ['name'],
      additionalProperties: false,
    }),
    execute: async ({ name }) => {
      const skill = byName.get(name)
      if (!skill) throw new Error(`unknown skill "${name}"; available: ${known}`)
      onLoad?.(skill)
      return {
        name: skill.name,
        content: skill.content,
        files: (skill.files ?? []).map((f) => f.path),
      }
    },
  })
  const readFile = tool({
    description: "Read one of a skill's bundled files (paths are listed by load_skill).",
    inputSchema: jsonSchema<{ name: string; path: string }>({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill name' },
        path: { type: 'string', description: 'The file path, relative to the skill' },
      },
      required: ['name', 'path'],
      additionalProperties: false,
    }),
    execute: async ({ name, path }) => {
      const skill = byName.get(name)
      if (!skill) throw new Error(`unknown skill "${name}"; available: ${known}`)
      const file = skill.files?.find((f) => f.path === path)
      if (!file) {
        const listed = (skill.files ?? []).map((f) => f.path).join(', ') || 'none'
        throw new Error(`skill "${name}" has no file "${path}"; files: ${listed}`)
      }
      return file.content
    },
  })
  for (const t of [loadSkill, readFile]) {
    ;(t as { readOnly?: boolean }).readOnly = true
    ;(t as { promptHint?: string }).promptHint =
      t === loadSkill ? '{ name: string }' : '{ name: string, path: string }'
  }
  return { load_skill: loadSkill, read_skill_file: readFile }
}
