import type { ImagePart } from 'ai'

/** An image handed to a run (pasted, attached, or produced by the host). */
export interface RunImage {
  /** Base64 (no prefix), a data URL ("data:image/png;base64,…"), or raw bytes. */
  data: string | Uint8Array
  /** e.g. "image/png" — read from a data URL when omitted. */
  mediaType?: string
  /** Shown in the transcript and in errors. */
  name?: string
}

/** Raised when images are sent to a model that cannot take them. */
export class ImagesNotSupportedError extends Error {
  constructor(model: string, detail?: string) {
    super(
      `The model "${model}" can't take images${detail ? ` (${detail})` : ''}. Remove the image, or switch to a vision-capable model such as Gemini, Claude or GPT-4o/GPT-5.`,
    )
    this.name = 'ImagesNotSupportedError'
  }

  toJSON(): string {
    return this.message
  }
}

/** An AI SDK image part from a RunImage (data URLs are split into base64 + media type). */
export const toImagePart = (img: RunImage): ImagePart => {
  if (typeof img.data === 'string') {
    const m = /^data:([^;,]+)?;base64,(.*)$/s.exec(img.data)
    if (m) return { type: 'image', image: m[2], mediaType: img.mediaType ?? m[1] }
  }
  return { type: 'image', image: img.data, ...(img.mediaType ? { mediaType: img.mediaType } : {}) }
}

/** A short, human label of a model for messages. */
export const modelLabel = (model: unknown): string => {
  if (typeof model === 'string') return model
  const m = model as { provider?: string; modelId?: string } | undefined
  return m?.modelId ? `${m.modelId}${m.provider ? ` (${m.provider})` : ''}` : 'this model'
}

const IMAGE_ERROR_RE =
  /image|vision|multimodal|multi-modal|media type|mediatype|unsupported (file|content|part)|does not support (file|content)|invalid content type|image_url|inline_?data/i

/** Does a provider error look like a refusal of image input? */
export const isImageRefusal = (err: unknown): boolean =>
  IMAGE_ERROR_RE.test(err instanceof Error ? `${err.name} ${err.message}` : String(err))
