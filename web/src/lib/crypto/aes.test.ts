import { describe, expect, it } from 'vitest'
import { type AesEnvelope, decryptWithRawKey, encryptWithRawKey, generateKeyMaterial } from './aes'

const KEY_32 = new Uint8Array(32).fill(7)

describe('generateKeyMaterial', () => {
  it('produces 32 random bytes (AES-256)', () => {
    const a = generateKeyMaterial()
    const b = generateKeyMaterial()
    expect(a).toHaveLength(32)
    expect(b).toHaveLength(32)
    expect(a).not.toEqual(b)
  })
})

describe('encryptWithRawKey / decryptWithRawKey', () => {
  it('round-trips arbitrary bytes', async () => {
    const plaintext = new TextEncoder().encode('sk-or-secret-key-12345')
    const env = await encryptWithRawKey(KEY_32, plaintext)
    const out = await decryptWithRawKey(KEY_32, env)
    expect(Array.from(out)).toEqual(Array.from(plaintext))
  })

  it('uses a fresh 12-byte IV per call (GCM nonce uniqueness)', async () => {
    const plaintext = new TextEncoder().encode('same input')
    const a = await encryptWithRawKey(KEY_32, plaintext)
    const b = await encryptWithRawKey(KEY_32, plaintext)
    expect(a.iv).toHaveLength(12)
    expect(b.iv).toHaveLength(12)
    expect(Array.from(a.iv)).not.toEqual(Array.from(b.iv))
    expect(Array.from(a.ciphertext)).not.toEqual(Array.from(b.ciphertext))
  })

  it('envelope shape is { iv: u8[12], ciphertext: u8[] }', async () => {
    const env = await encryptWithRawKey(KEY_32, new TextEncoder().encode('x'))
    expect(env.iv instanceof Uint8Array).toBe(true)
    expect(env.ciphertext instanceof Uint8Array).toBe(true)
  })

  it('rejects when ciphertext is tampered (GCM auth tag)', async () => {
    const env = await encryptWithRawKey(KEY_32, new TextEncoder().encode('secret'))
    const tampered: AesEnvelope = {
      iv: env.iv,
      ciphertext: new Uint8Array(env.ciphertext).map((b, i) => (i === 0 ? b ^ 1 : b)),
    }
    await expect(decryptWithRawKey(KEY_32, tampered)).rejects.toThrow()
  })

  it('rejects with the wrong key', async () => {
    const env = await encryptWithRawKey(KEY_32, new TextEncoder().encode('secret'))
    const wrongKey = new Uint8Array(32).fill(99)
    await expect(decryptWithRawKey(wrongKey, env)).rejects.toThrow()
  })

  it('rejects a truncated IV', async () => {
    const env = await encryptWithRawKey(KEY_32, new TextEncoder().encode('x'))
    const bad: AesEnvelope = { iv: new Uint8Array(11), ciphertext: env.ciphertext }
    await expect(decryptWithRawKey(KEY_32, bad)).rejects.toThrow()
  })

  it('handles empty plaintext', async () => {
    const env = await encryptWithRawKey(KEY_32, new Uint8Array(0))
    const out = await decryptWithRawKey(KEY_32, env)
    expect(Array.from(out)).toEqual([])
  })

  it('round-trips a large payload (~64 KB)', async () => {
    const plaintext = new Uint8Array(64 * 1024).map((_, i) => i % 256)
    const env = await encryptWithRawKey(KEY_32, plaintext)
    const out = await decryptWithRawKey(KEY_32, env)
    expect(Array.from(out)).toEqual(Array.from(plaintext))
  })
})
