import { jsonSchema, tool, type ToolSet } from 'ai'
import { markReadOnly } from '../tools/approval.js'
import { isTextMime, type VirtualFileSystem } from './vfs.js'

export interface FileToolsOptions {
  /** Tool-name prefix (default 'fs_' → fs_list, fs_read, fs_write, fs_delete). */
  prefix?: string
  /** Mount only the read tools (default false). */
  readOnly?: boolean
  /** Cap on the text fs_read returns (default 50 000 chars; the rest is cut with a marker). */
  maxReadChars?: number
}

/**
 * Tools that give the agent the virtual file system: list, read, write and
 * delete. Listing and reading are marked read-only, so the `ask-writes`
 * consent mode lets them through and asks before writes and deletes.
 */
export const createFileTools = (vfs: VirtualFileSystem, opts: FileToolsOptions = {}): ToolSet => {
  const p = opts.prefix ?? 'fs_'
  const maxRead = opts.maxReadChars ?? 50_000
  const tools: ToolSet = {
    [`${p}list`]: markReadOnly(
      tool({
        description:
          'List the files in the workspace (attachments the user added, files you wrote). Optionally only under a directory prefix.',
        inputSchema: jsonSchema<{ prefix?: string }>({
          type: 'object',
          properties: { prefix: { type: 'string', description: 'Directory prefix, e.g. "/docs"' } },
          additionalProperties: false,
        }),
        execute: async ({ prefix }) =>
          (await vfs.list(prefix || '/')).map((f) => ({
            path: f.path,
            mimeType: f.mimeType,
            size: f.size,
          })),
      }),
    ),
    [`${p}read`]: markReadOnly(
      tool({
        description: 'Read a text file from the workspace by its path.',
        inputSchema: jsonSchema<{ path: string }>({
          type: 'object',
          properties: { path: { type: 'string', description: 'Absolute path, e.g. "/notes.md"' } },
          required: ['path'],
          additionalProperties: false,
        }),
        execute: async ({ path }) => {
          const f = await vfs.read(path)
          if (!f) {
            const known = (await vfs.list()).map((x) => x.path).slice(0, 30)
            throw new Error(`no file "${path}"; files: ${known.join(', ') || 'none'}`)
          }
          if (f.encoding === 'base64' && !isTextMime(f.mimeType)) {
            return `"${f.path}" is a binary file (${f.mimeType}, ${f.size} bytes) and cannot be read as text.`
          }
          const text = f.encoding === 'base64' ? atob(f.content) : f.content
          return text.length > maxRead
            ? `${text.slice(0, maxRead)}… [truncated ${text.length - maxRead} chars]`
            : text
        },
      }),
    ),
  }
  if (opts.readOnly) return tools
  tools[`${p}write`] = tool({
    description:
      'Write a text file to the workspace (creates or replaces it). Use it for reports, drafts, data the user should be able to open.',
    inputSchema: jsonSchema<{ path: string; content: string; mimeType?: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path, e.g. "/reports/summary.md"' },
        content: { type: 'string', description: 'The full file content' },
        mimeType: { type: 'string', description: 'Optional MIME type (guessed from the name)' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    }),
    execute: async ({ path, content, mimeType }) => {
      const info = await vfs.write(path, content, mimeType ? { mimeType } : {})
      return { written: info.path, size: info.size }
    },
  })
  tools[`${p}delete`] = tool({
    description: 'Delete a file from the workspace.',
    inputSchema: jsonSchema<{ path: string }>({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    }),
    execute: async ({ path }) => ({ deleted: await vfs.delete(path) }),
  })
  return tools
}
