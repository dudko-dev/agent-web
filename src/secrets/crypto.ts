import { KEYS_STORE, openAgentWebDB } from '../storage/db.js'

const KEY_ID = 'vault-key-v1'

const webcrypto = (): Crypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (!c?.subtle || !c.getRandomValues) {
    throw new Error('WebCrypto (crypto.subtle) is unavailable in this environment')
  }
  return c
}

/**
 * Fetch (or lazily create) the vault's AES-GCM key. The key is generated
 * NON-EXTRACTABLE and stored as a live `CryptoKey` in IndexedDB — a CryptoKey
 * is structured-cloneable, so it persists across reloads WITHOUT its raw bytes
 * ever being exposed to JavaScript. Not even in-page script can read it out; it
 * can only be used to encrypt / decrypt. That is what makes at-rest storage of
 * the secrets meaningful (see IndexedDBVault's threat model).
 */
export const getOrCreateVaultKey = async (dbName?: string): Promise<CryptoKey> => {
  const db = await openAgentWebDB({ dbName })
  const existing = (await db.get(KEYS_STORE, KEY_ID)) as CryptoKey | undefined
  if (existing) return existing
  const key = await webcrypto().subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  )
  await db.put(KEYS_STORE, key, KEY_ID)
  return key
}

export interface EncryptedBlob {
  /** 96-bit random IV, fresh per write. */
  iv: Uint8Array
  ciphertext: ArrayBuffer
}

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Encrypt a JSON-serialisable value with a fresh 96-bit IV (AES-GCM). */
export const encryptJSON = async (key: CryptoKey, value: unknown): Promise<EncryptedBlob> => {
  const c = webcrypto()
  const iv = c.getRandomValues(new Uint8Array(12))
  const data = textEncoder.encode(JSON.stringify(value))
  const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, data)
  return { iv, ciphertext }
}

/** Decrypt a blob produced by encryptJSON. Throws if the key or blob don't match. */
export const decryptJSON = async <T = unknown>(key: CryptoKey, blob: EncryptedBlob): Promise<T> => {
  // Copy the IV into a fresh ArrayBuffer-backed view: after a round-trip through
  // IndexedDB its element buffer is typed as ArrayBufferLike, which no longer
  // satisfies BufferSource under TS's stricter typed-array generics.
  const iv = new Uint8Array(blob.iv)
  const plain = await webcrypto().subtle.decrypt({ name: 'AES-GCM', iv }, key, blob.ciphertext)
  return JSON.parse(textDecoder.decode(plain)) as T
}
