# Security: the token vault & its threat model

`@dudko.dev/agent-web` can hold API keys so a browser app can call model
providers directly (bring-your-own-key). This document states **exactly** what
that protects and what it does not — read it before shipping any key to a
browser.

## How keys are stored

- A **256-bit AES-GCM `CryptoKey`** is generated with WebCrypto,
  **`extractable: false`**, and stored as a live `CryptoKey` object in
  IndexedDB. A `CryptoKey` is structured-cloneable, so it survives reloads
  **without its raw bytes ever being exposed to JavaScript** — not even in-page
  script can read it out. It can only be *used* to encrypt/decrypt.
- Each secret (an API key) is encrypted with that key using **AES-GCM with a
  fresh 96-bit IV per write**, and the resulting `{ iv, ciphertext }` is stored
  in IndexedDB. Nothing is ever written in plaintext.
- All of this lives under one IndexedDB database owned by `storage/db.ts`
  (`keys`, `secrets`, `sessions` stores).

API surface:

```ts
import { VaultCredentialStore, IndexedDBVault } from '@dudko.dev/agent-web'

const store = new VaultCredentialStore()          // the CredentialStore the agent uses
await store.setApiKey('openai', key)
await store.getApiKey('openai')
await store.deleteApiKey('openai')

const vault = new IndexedDBVault()                // lower-level: any secret
await vault.setSecret(id, value)
await vault.listSecretIds()
```

## What this PROTECTS against

- **At rest.** A dump of IndexedDB / the disk yields only ciphertext and a
  non-extractable key handle. There is no plaintext key on disk.
- **Casual inspection.** Nothing readable in DevTools → Application → IndexedDB;
  the AES key cannot be exported by script (`extractable: false`).

## What this does NOT protect against

- **Active XSS on your origin.** Any script running on your page can call
  `getSecret()` or use the live `CryptoKey` to decrypt — the same way your own
  code does. Browser storage is not a secrets manager; nothing in a browser can
  stop code that already runs on your origin.
- **A malicious/compromised user.** The user owns their machine and can read any
  key their browser can use. That is *fine for their own key*, and *unacceptable
  for yours*.

## The rule

> **BYOK, user's own key, user's own device → the vault is appropriate.**
> **Shared / app-owned key → it must NEVER reach the client.** Put it behind a
> server proxy (`ProviderModelSpec.baseURL` → your backend) or the Vercel AI
> Gateway, and keep the real key server-side.

`directBrowserOk(providerType)` and the notes in [providers.md](./providers.md)
tell you which providers even *allow* a direct browser call; use a proxy for the
rest regardless of key ownership.

## Defense-in-depth checklist

- Serve over HTTPS and set a strict **Content-Security-Policy** — your best
  defense against the XSS that would defeat the vault.
- Prefer **`credentialRef`** over inline `apiKey` (an inline key is warned about
  and lives on the config object, not the encrypted vault).
- Scope keys narrowly and prefer **short-lived** keys where the provider offers
  them.
- Offer users a **"forget my key"** action (`deleteApiKey`) and remember that
  IndexedDB persists until cleared.
