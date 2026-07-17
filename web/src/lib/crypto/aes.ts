/**
 * AES-GCM primitives over raw 32-byte key material.
 *
 * Operates on raw bytes (not `CryptoKey` handles) so PRF-derived material drops
 * in directly — the PRF extension yields 32 opaque bytes which become the AES
 * key, no separate key-wrapping dance required. All functions are pure w.r.t.
 * their inputs; no module state, no DOM, no storage.
 *
 * Used by `secure-keyring.ts` (ADR-0007) to wrap the DEK and encrypt the
 * API-key blob. Authenticated encryption (GCM auth tag) detects tampering and
 * rejects wrong keys — there is no "partial decrypt"; a single bit flip in the
 * ciphertext or IV throws.
 */
const AES_KEY_BITS = 256
const AES_IV_BYTES = 12

/** Ciphertext envelope: a 12-byte GCM nonce + the authenticated ciphertext. */
export interface AesEnvelope {
  iv: Uint8Array
  ciphertext: Uint8Array
}

/** 32 random bytes via the platform CSPRNG. Used for both DEK and KEK. */
export function generateKeyMaterial(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_KEY_BITS / 8))
}

/** Fresh 12-byte GCM nonce. Must never repeat under the same key. */
function freshIv(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(AES_IV_BYTES))
}

async function importAesKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== AES_KEY_BITS / 8) {
    throw new Error(`AES-256 key must be 32 bytes (got ${rawKey.byteLength}).`)
  }
  return crypto.subtle.importKey('raw', rawKey as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ])
}

/** Encrypt `plaintext` under `rawKey`. Returns a fresh envelope each call. */
export async function encryptWithRawKey(
  rawKey: Uint8Array,
  plaintext: Uint8Array,
): Promise<AesEnvelope> {
  const key = await importAesKey(rawKey)
  const iv = freshIv()
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      plaintext as BufferSource,
    ),
  )
  return { iv, ciphertext }
}

/** Decrypt `envelope` under `rawKey`. Throws on tamper or wrong key. */
export async function decryptWithRawKey(
  rawKey: Uint8Array,
  envelope: AesEnvelope,
): Promise<Uint8Array> {
  if (envelope.iv.byteLength !== AES_IV_BYTES) {
    throw new Error(`AES-GCM IV must be 12 bytes (got ${envelope.iv.byteLength}).`)
  }
  const key = await importAesKey(rawKey)
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: envelope.iv as BufferSource },
      key,
      envelope.ciphertext as BufferSource,
    ),
  )
}
