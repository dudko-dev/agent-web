import 'fake-indexeddb/auto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  VaultCredentialStore,
  IndexedDBVault,
  getOrCreateVaultKey,
  encryptJSON,
  decryptJSON,
  openAgentWebDB,
  SECRETS_STORE,
} from '../dist/index.js'

test('vault: credential round-trip via CredentialStore', async () => {
  const store = new VaultCredentialStore({ dbName: 'vault-test-creds' })
  await store.setApiKey('openai', 'sk-secret')
  assert.equal(await store.getApiKey('openai'), 'sk-secret')
  await store.deleteApiKey('openai')
  assert.equal(await store.getApiKey('openai'), undefined)
})

test('vault: secrets are encrypted at rest (no plaintext in the store)', async () => {
  const vault = new IndexedDBVault({ dbName: 'vault-test-atrest' })
  await vault.setSecret('key', 'sk-plaintext-xyz')
  const db = await openAgentWebDB({ dbName: 'vault-test-atrest' })
  const blob = (await db.get(SECRETS_STORE, 'key')) as { iv: Uint8Array; ciphertext: ArrayBuffer }
  assert.ok(blob.ciphertext instanceof ArrayBuffer)
  const raw = new TextDecoder().decode(blob.ciphertext)
  assert.doesNotMatch(raw, /sk-plaintext-xyz/)
  // And it still decrypts back:
  assert.equal(await vault.getSecret('key'), 'sk-plaintext-xyz')
})

test('crypto: AES-GCM round-trip, and tampering fails authentication', async () => {
  const key = await getOrCreateVaultKey('vault-test-crypto')
  const blob = await encryptJSON(key, { a: 1, b: 'two' })
  assert.deepEqual(await decryptJSON(key, blob), { a: 1, b: 'two' })
  blob.iv[0] ^= 0xff
  await assert.rejects(() => decryptJSON(key, blob))
})

test('vault: a non-extractable CryptoKey persists across store instances', async () => {
  const a = new IndexedDBVault({ dbName: 'vault-test-persist' })
  await a.setSecret('t', 'value')
  const b = new IndexedDBVault({ dbName: 'vault-test-persist' })
  assert.equal(await b.getSecret('t'), 'value')
})
