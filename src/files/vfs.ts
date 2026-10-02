import { FILES_STORE, openAgentWebDB } from '../storage/db.js'

/**
 * A small virtual file system for the browser — the agent's (and the user's)
 * workspace: attachments the user drops in, reports the agent writes, images
 * pasted into the chat. Persistent in IndexedDB by default, in-memory on
 * request (tests, private mode). Paths are POSIX-like and always absolute
 * ("/notes/todo.md"); there are no real directories — a "directory" is a path
 * prefix.
 */
export interface VirtualFile {
  path: string
  /** Text, or base64 for binary content (see `encoding`). */
  content: string
  encoding: 'utf8' | 'base64'
  mimeType: string
  /** Size of the decoded content in bytes. */
  size: number
  updatedAt: number
}

/** A listing entry (no content). */
export type VirtualFileInfo = Omit<VirtualFile, 'content'>

export interface VirtualFileSystemOptions {
  /** Keep files in memory only (default false: IndexedDB). */
  memory?: boolean
  /** IndexedDB database name, forwarded to the shared owner (default 'agent-web'). */
  dbName?: string
  /** Isolates several file systems in one database (default 'default'). */
  namespace?: string
  /** Refuse a single file larger than this many bytes (default 10 MB). */
  maxFileBytes?: number
}

export type VfsListener = (change: { type: 'write' | 'delete'; path: string }) => void

const MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
}

/** A best-effort MIME type from a file name. */
export const mimeFromPath = (path: string): string =>
  MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'

/** True for MIME types the agent can read as text. */
export const isTextMime = (mime: string): boolean =>
  /^text\/|json|xml|yaml|javascript|typescript|svg/.test(mime)

/**
 * Normalise a path: absolute, forward slashes, no "." / ".." / empty segments.
 * Throws on a path that escapes the root.
 */
export const normalizePath = (input: string): string => {
  const parts: string[] = []
  for (const seg of String(input ?? '')
    .replace(/\\/g, '/')
    .split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) throw new Error(`path "${input}" escapes the root`)
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  if (parts.length === 0) throw new Error('a file path is required')
  return `/${parts.join('/')}`
}

const byteLength = (content: string, encoding: VirtualFile['encoding']): number =>
  encoding === 'base64'
    ? Math.floor((content.replace(/=+$/, '').length * 3) / 4)
    : new TextEncoder().encode(content).length

/** Base64 of bytes, chunked so a large file can't blow the call stack. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

export class VirtualFileSystem {
  private readonly memory?: Map<string, VirtualFile>
  private readonly dbName?: string
  private readonly ns: string
  private readonly maxFileBytes: number
  private readonly listeners = new Set<VfsListener>()

  constructor(opts: VirtualFileSystemOptions = {}) {
    if (opts.memory) this.memory = new Map()
    this.dbName = opts.dbName
    this.ns = opts.namespace ?? 'default'
    this.maxFileBytes = opts.maxFileBytes ?? 10 * 1024 * 1024
  }

  private key(path: string): string {
    return `${this.ns}:${path}`
  }

  /** Subscribe to writes and deletes (e.g. to refresh a file list). Returns an unsubscribe. */
  onChange(listener: VfsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(type: 'write' | 'delete', path: string): void {
    for (const l of this.listeners) {
      try {
        l({ type, path })
      } catch {
        /* a bad listener must not break a write */
      }
    }
  }

  async write(
    path: string,
    content: string | Uint8Array,
    opts: { mimeType?: string; encoding?: VirtualFile['encoding'] } = {},
  ): Promise<VirtualFileInfo> {
    const p = normalizePath(path)
    const binary = content instanceof Uint8Array
    const encoding = binary ? 'base64' : (opts.encoding ?? 'utf8')
    const text = binary ? bytesToBase64(content) : content
    const size = binary ? content.length : byteLength(text, encoding)
    if (size > this.maxFileBytes) {
      throw new Error(`"${p}" is ${size} bytes; the limit is ${this.maxFileBytes}`)
    }
    const file: VirtualFile = {
      path: p,
      content: text,
      encoding,
      mimeType: opts.mimeType ?? mimeFromPath(p),
      size,
      updatedAt: Date.now(),
    }
    if (this.memory) this.memory.set(p, file)
    else {
      const db = await openAgentWebDB({ dbName: this.dbName })
      await db.put(FILES_STORE, file, this.key(p))
    }
    this.notify('write', p)
    const { content: _drop, ...info } = file
    return info
  }

  /** Store a data URL ("data:image/png;base64,…") as a file. */
  async writeDataUrl(path: string, dataUrl: string): Promise<VirtualFileInfo> {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl)
    if (!m) throw new Error('not a data URL')
    const mimeType = m[1] ?? 'application/octet-stream'
    return m[2]
      ? this.write(path, m[3], { mimeType, encoding: 'base64' })
      : this.write(path, decodeURIComponent(m[3]), { mimeType })
  }

  async read(path: string): Promise<VirtualFile | undefined> {
    const p = normalizePath(path)
    if (this.memory) return this.memory.get(p)
    const db = await openAgentWebDB({ dbName: this.dbName })
    return (await db.get(FILES_STORE, this.key(p))) as VirtualFile | undefined
  }

  /** The file as a data URL (for <img src>, downloads). */
  async readDataUrl(path: string): Promise<string | undefined> {
    const f = await this.read(path)
    if (!f) return undefined
    return f.encoding === 'base64'
      ? `data:${f.mimeType};base64,${f.content}`
      : `data:${f.mimeType};charset=utf-8,${encodeURIComponent(f.content)}`
  }

  async delete(path: string): Promise<boolean> {
    const p = normalizePath(path)
    let existed: boolean
    if (this.memory) existed = this.memory.delete(p)
    else {
      const db = await openAgentWebDB({ dbName: this.dbName })
      existed = (await db.get(FILES_STORE, this.key(p))) !== undefined
      await db.delete(FILES_STORE, this.key(p))
    }
    if (existed) this.notify('delete', p)
    return existed
  }

  /** Files under a prefix ("/" = all), sorted by path. */
  async list(prefix = '/'): Promise<VirtualFileInfo[]> {
    const dir = prefix === '/' ? '/' : `${normalizePath(prefix)}/`
    let files: VirtualFile[]
    if (this.memory) files = [...this.memory.values()]
    else {
      const db = await openAgentWebDB({ dbName: this.dbName })
      const range = IDBKeyRange.bound(`${this.ns}:`, `${this.ns}:￿`)
      files = (await db.getAll(FILES_STORE, range)) as VirtualFile[]
    }
    return files
      .filter((f) => dir === '/' || f.path.startsWith(dir))
      .map(({ content: _drop, ...info }) => info)
      .sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Remove every file (of this namespace). */
  async clear(): Promise<void> {
    for (const f of await this.list()) await this.delete(f.path)
  }
}
