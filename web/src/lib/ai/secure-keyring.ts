/**
 * Biometric-gated key caching orchestrator (ADR-0007).
 *
 * Adds an **opt-in** tier on top of ADR-0004's in-memory default: when the user
 * enables "Remember with biometric", the current `keyring.ts` snapshot is
 * encrypted with a random DEK, the DEK is wrapped with a KEK derived from the
 * user's passkey via the WebAuthn PRF extension, and both blobs are written to
 * the `secureKeyring` IndexedDB store. On the next session, one biometric tap
 * re-derives the KEK, unwraps the DEK, decrypts the blob, and pushes the keys
 * back into `keyring.ts` — exactly where the engines already read them.
 *
 * The wrapped-DEK pattern (not PRF-output-as-key) is deliberate: passkey
 * rotation invalidates the wrapped DEK but not the encrypted keys blob, so
 * re-enrollment with a new passkey + the same plaintext re-wraps cleanly.
 *
 * State machine:
 *   not-enrolled ──enroll()──► enrolled-unlocked (DEK cached)
 *   enrolled-locked ──unlock()──► enrolled-unlocked
 *   any ──forget()──► not-enrolled (IDB record + cached DEK + keyring cleared)
 *
 * The cached DEK lives in a module-scoped variable and dies on tab close,
 * mirroring `keyring.ts`'s lifecycle. CSP `connect-src` remains the primary
 * exfiltration defence (ADR-0004) — once unlocked, the plaintext keys sit in
 * the same `keyring.ts` module any same-origin JS could read; PRF only adds a
 * gate on *recovering* them after a tab close, not on *reading* them during a
 * live session.
 */
import { decryptWithRawKey, encryptWithRawKey, generateKeyMaterial } from '../crypto/aes'
import { deriveKey, enrollPrf } from '../crypto/prf'
import { getDB, type SecureKeyringRecord } from '../db'
import { clearAllKeys, setApiKey, snapshotKeys } from './keyring'

const RECORD_KEY = 'current' as const
const RECORD_VERSION = 1

/** Module-scoped cached DEK. Dies on tab close. `null` when locked or unenrolled. */
let cachedDek: Uint8Array | null = null

export interface SecureKeyringSnapshot {
  enrolled: boolean
  unlocked: boolean
}

/** True if a `secureKeyring` record exists in IndexedDB. */
export async function isEnrolled(): Promise<boolean> {
  return (await readRecord()) !== undefined
}

/** Current state — used by Settings UI to render the toggle + unlock prompt. */
export async function getSnapshot(): Promise<SecureKeyringSnapshot> {
  const enrolled = (await readRecord()) !== undefined
  return { enrolled, unlocked: cachedDek !== null }
}

export interface EnrollOptions {
  rpId?: string
  /** Override the keys to cache (defaults to the current `keyring` snapshot). */
  keys?: Record<string, string>
}

/**
 * Encrypt the current in-memory keys and write the wrapped-DEK blob to IDB.
 *
 * Calls `enrollPrf` (biometric) which — on most modern authenticators — also
 * evaluates the PRF in the same ceremony, so `enroll()` is a **single
 * biometric prompt**. If the authenticator doesn't evaluate PRF during
 * `create()`, falls back to a follow-up `deriveKey()` (second prompt).
 *
 * Leaves the session **unlocked** (DEK cached) so subsequent `saveCurrentKeys`
 * calls don't need biometric. Overwrites any prior enrollment.
 */
export async function enroll(opts: EnrollOptions = {}): Promise<void> {
  const keys = opts.keys ?? snapshotKeys()
  if (Object.keys(keys).length === 0) {
    throw new Error('Cannot enroll with no keys in memory.')
  }

  const dek = generateKeyMaterial()
  const encryptedKeys = await encryptWithRawKey(dek, encodeKeys(keys))

  const salt = generateKeyMaterial()
  const { credentialId, supported, prfOutput } = await enrollPrf(opts.rpId, salt)
  if (!supported) {
    throw new Error('Authenticator did not enable PRF — cannot cache keys biometrically.')
  }

  let kek: Uint8Array
  if (prfOutput) {
    kek = prfOutput
  } else {
    kek = await deriveKey({ rpId: opts.rpId, credentialId, salt })
  }
  const wrappedDek = await encryptWithRawKey(kek, dek)

  const record: SecureKeyringRecord = {
    key: RECORD_KEY,
    salt,
    credentialId,
    wrappedDek,
    encryptedKeys,
    version: RECORD_VERSION,
    createdAt: Date.now(),
  }
  await writeRecord(record)

  cachedDek = dek
}

export interface UnlockOptions {
  rpId?: string
}

export interface UnlockResult {
  /** Number of keys pushed back into `keyring.ts`. 0 if not enrolled. */
  keysLoaded: number
}

/**
 * Recover the DEK via PRF (biometric prompt), decrypt the keys blob, and push
 * every entry into `keyring.setApiKey`. Idempotent within a session: subsequent
 * calls reuse the cached DEK without prompting.
 *
 * Throws on user cancel or tamper. On failure the session stays locked — the
 * caller falls back to the in-memory tier.
 */
export async function unlock(opts: UnlockOptions = {}): Promise<UnlockResult> {
  if (cachedDek) return rehydrateFromDek(cachedDek)
  const rec = await readRecord()
  if (!rec) return { keysLoaded: 0 }

  const kek = await deriveKey({ rpId: opts.rpId, credentialId: rec.credentialId, salt: rec.salt })
  const dek = await decryptWithRawKey(kek, rec.wrappedDek)
  cachedDek = dek
  return rehydrateFromDek(dek)
}

/**
 * Re-encrypt the current `keyring` snapshot under the cached DEK and overwrite
 * the IDB blob. Requires `enroll` or `unlock` to have run this session (DEK in
 * memory). Does **not** prompt for biometric.
 */
export async function saveCurrentKeys(): Promise<void> {
  const rec = await readRecord()
  if (!rec) throw new Error('Not enrolled.')
  if (!cachedDek) throw new Error('Cannot save keys before unlock() — no DEK in memory.')
  const encrypted = await encryptWithRawKey(cachedDek, encodeKeys(snapshotKeys()))
  await writeRecord({ ...rec, encryptedKeys: encrypted })
}

/**
 * Delete the IDB record, drop the cached DEK, and clear `keyring`. Safe to call
 * when not enrolled. After this, the app behaves identically to the ADR-0004
 * in-memory default.
 */
export async function forget(): Promise<void> {
  cachedDek = null
  const db = await getDB()
  await db.delete('secureKeyring', RECORD_KEY)
  clearAllKeys()
}

/** Test-only escape hatch for module state. Call between `_clearDBForTests`. */
export function _resetForTests(): void {
  cachedDek = null
}

async function rehydrateFromDek(dek: Uint8Array): Promise<UnlockResult> {
  const rec = await readRecord()
  if (!rec) return { keysLoaded: 0 }
  const plain = await decryptWithRawKey(dek, rec.encryptedKeys)
  const keys = decodeKeys(plain)
  let n = 0
  for (const [id, key] of Object.entries(keys)) {
    setApiKey(id, key)
    n++
  }
  return { keysLoaded: n }
}

async function readRecord(): Promise<SecureKeyringRecord | undefined> {
  const db = await getDB()
  return (await db.get('secureKeyring', RECORD_KEY)) ?? undefined
}

async function writeRecord(rec: SecureKeyringRecord): Promise<void> {
  const db = await getDB()
  await db.put('secureKeyring', rec)
}

function encodeKeys(keys: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(keys))
}

function decodeKeys(bytes: Uint8Array): Record<string, string> {
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, string>
}
