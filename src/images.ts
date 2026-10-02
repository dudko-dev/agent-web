import type { FilePart } from 'ai'

/**
 * Attachments sent with a run: images, PDFs and other files the provider can
 * read, given as bytes / base64 / a data URL — or as an http(s) URL, which
 * providers that accept links (Gemini, Claude, OpenAI) fetch themselves and the
 * AI SDK downloads for the rest (from the browser: subject to CORS).
 */
export interface RunFile {
  /** Base64 (no prefix), a data URL ("data:image/png;base64,…"), raw bytes, or an http(s) URL. */
  data: string | Uint8Array | URL
  /** e.g. "image/png", "application/pdf" — read from a data URL when omitted. */
  mediaType?: string
  /** Shown in the transcript, in memory and in errors. */
  name?: string
}

/** An image attachment (same shape; kept as its own name for clarity). */
export type RunImage = RunFile

/** The kinds of attachment the agent reasons about separately. */
export type AttachmentKind = 'image' | 'pdf' | 'file'

const DATA_URL_RE = /^data:([^;,]+)?;base64,(.*)$/s
const HTTP_RE = /^https?:\/\//i

/** The media type of an attachment (declared, from a data URL, or from a URL's extension). */
export const mediaTypeOf = (f: RunFile): string | undefined => {
  if (f.mediaType) return f.mediaType
  if (typeof f.data === 'string') {
    const m = DATA_URL_RE.exec(f.data)
    if (m?.[1]) return m[1]
  }
  const url = f.data instanceof URL ? f.data.href : typeof f.data === 'string' ? f.data : ''
  if (HTTP_RE.test(url) || f.name) {
    const ext = (f.name ?? new URL(url, 'http://x').pathname).split('.').pop()?.toLowerCase()
    if (ext === 'pdf') return 'application/pdf'
    if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      return `image/${ext === 'jpg' ? 'jpeg' : ext}`
    }
  }
  return undefined
}

export const attachmentKind = (f: RunFile): AttachmentKind => {
  const mt = mediaTypeOf(f) ?? ''
  if (mt.startsWith('image/')) return 'image'
  if (mt === 'application/pdf') return 'pdf'
  return 'file'
}

const KIND_LABEL: Record<AttachmentKind, string> = {
  image: 'images',
  pdf: 'PDF files',
  file: 'file attachments',
}

const KIND_HINT: Record<AttachmentKind, string> = {
  image:
    'Remove the image, or switch to a vision-capable model such as Gemini, Claude or GPT-4o/GPT-5.',
  pdf: 'Convert the PDF to text first (e.g. PDF → Markdown), or switch to a model that reads PDFs such as Gemini, Claude or GPT-4o/GPT-5.',
  file: 'Paste its text instead, or switch to a model that accepts this file type.',
}

/** Raised when attachments are sent to a model that cannot take them. */
export class AttachmentsNotSupportedError extends Error {
  readonly kind: AttachmentKind
  constructor(model: string, kind: AttachmentKind, detail?: string) {
    super(
      `The model "${model}" can't take ${KIND_LABEL[kind]}${detail ? ` (${detail})` : ''}. ${KIND_HINT[kind]}`,
    )
    this.name = 'AttachmentsNotSupportedError'
    this.kind = kind
  }

  toJSON(): string {
    return this.message
  }
}

/** The image flavour of {@link AttachmentsNotSupportedError}. */
export class ImagesNotSupportedError extends AttachmentsNotSupportedError {
  constructor(model: string, detail?: string) {
    super(model, 'image', detail)
    this.name = 'ImagesNotSupportedError'
  }
}

/** The error for a kind: images get the dedicated class. */
export const unsupportedAttachment = (
  model: string,
  kind: AttachmentKind,
  detail?: string,
): AttachmentsNotSupportedError =>
  kind === 'image'
    ? new ImagesNotSupportedError(model, detail)
    : new AttachmentsNotSupportedError(model, kind, detail)

const dataOf = (f: RunFile): string | Uint8Array | URL => {
  if (typeof f.data === 'string') {
    const m = DATA_URL_RE.exec(f.data)
    if (m) return m[2]
    if (HTTP_RE.test(f.data)) return new URL(f.data)
  }
  return f.data
}

/**
 * An AI SDK file part (images included — the v7 SDK deprecates the separate
 * image part). An http(s) URL is passed as a URL: providers that accept links
 * fetch it themselves, and the SDK downloads it for the rest.
 */
export const toFilePart = (f: RunFile): FilePart => {
  const kind = attachmentKind(f)
  const mediaType = mediaTypeOf(f) ?? (kind === 'image' ? 'image' : 'application/octet-stream')
  return {
    type: 'file',
    data: dataOf(f),
    mediaType,
    ...(f.name ? { filename: f.name } : {}),
  }
}

/** Back-compat name. */
export const toImagePart = toFilePart

/** A short, human label of a model for messages. */
export const modelLabel = (model: unknown): string => {
  if (typeof model === 'string') return model
  const m = model as { provider?: string; modelId?: string } | undefined
  return m?.modelId ? `${m.modelId}${m.provider ? ` (${m.provider})` : ''}` : 'this model'
}

const REFUSAL_RE =
  /image|vision|multimodal|multi-modal|media type|mediatype|pdf|document|unsupported (file|content|part|mime)|does not support (file|content)|invalid content type|image_url|inline_?data|file_?data/i

/** Does a provider error look like a refusal of attachment input? */
export const isAttachmentRefusal = (err: unknown): boolean =>
  REFUSAL_RE.test(err instanceof Error ? `${err.name} ${err.message}` : String(err))

/** Back-compat name. */
export const isImageRefusal = isAttachmentRefusal
