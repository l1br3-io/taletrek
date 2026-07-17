import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _clearDBForTests, _resetDBForTests } from '../db'
import { clearAllKeys, getApiKey, setApiKey, snapshotKeys } from './keyring'
import {
  _resetForTests,
  enroll,
  forget,
  getSnapshot,
  isEnrolled,
  saveCurrentKeys,
  unlock,
} from './secure-keyring'

// Mock the PRF wrapper — we control biometric success/failure here. AES + IDB
// run for real so the end-to-end crypto round-trip is verified. `vi.mock` is
// hoisted by vitest above the imports above, so it intercepts secure-keyring's
// `import { ... } from '../crypto/prf'`.
const prfState = {
  enrolledCredentialId: 'cred-test' as string,
  enrolledSalt: null as Uint8Array | null,
  shouldFail: false,
  /** When `true`, simulate an authenticator that doesn't evaluate PRF during
   * `create()` — forces the two-prompt fallback path. */
  skipPrfInCreate: false,
  derivation: (salt: Uint8Array): Uint8Array => {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = (salt[i % salt.byteLength] ?? 0) ^ 0x5a
    return out
  },
}

vi.mock('../crypto/prf', () => ({
  enrollPrf: vi.fn(async (_rpId?: string, salt?: Uint8Array) => {
    if (salt && !prfState.skipPrfInCreate) {
      return {
        credentialId: prfState.enrolledCredentialId,
        supported: true,
        prfOutput: prfState.derivation(salt),
      }
    }
    return {
      credentialId: prfState.enrolledCredentialId,
      supported: true,
    }
  }),
  deriveKey: vi.fn(async (opts: { salt: Uint8Array }) => {
    if (prfState.shouldFail) {
      throw new DOMException('User cancelled', 'AbortError')
    }
    return prfState.derivation(opts.salt)
  }),
  isPrfSupported: vi.fn(async () => true),
}))

const PLAINTEXT_KEY_OPENROUTER = 'sk-or-plaintext-must-never-touch-disk'
const PLAINTEXT_KEY_OPENAI = 'sk-openai-plaintext'

beforeEach(async () => {
  _resetForTests()
  _resetDBForTests()
  await _clearDBForTests()
  clearAllKeys()
  prfState.enrolledCredentialId = 'cred-test'
  prfState.enrolledSalt = null
  prfState.shouldFail = false
  prfState.skipPrfInCreate = false
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('isEnrolled / getSnapshot', () => {
  it('reports not-enrolled + locked on a fresh install', async () => {
    expect(await isEnrolled()).toBe(false)
    expect(await getSnapshot()).toEqual({ enrolled: false, unlocked: false })
  })
})

describe('enroll', () => {
  it('persists an encrypted record and leaves the session unlocked', async () => {
    setApiKey('openrouter', PLAINTEXT_KEY_OPENROUTER)
    await enroll({ keys: snapshotKeys() })

    expect(await isEnrolled()).toBe(true)
    expect(await getSnapshot()).toEqual({ enrolled: true, unlocked: true })
  })

  it('refuses to enroll with an empty key map', async () => {
    await expect(enroll({ keys: {} })).rejects.toThrow(/no keys/i)
  })

  it('throws if the authenticator did not enable PRF', async () => {
    const prf = await import('../crypto/prf')
    vi.mocked(prf.enrollPrf).mockResolvedValueOnce({ credentialId: 'c', supported: false })
    setApiKey('p1', 'sk-x')
    await expect(enroll({ keys: snapshotKeys() })).rejects.toThrow(/PRF/i)
  })

  it('uses a single biometric prompt when create() returns prfOutput (no deriveKey)', async () => {
    setApiKey('p1', 'sk-x')
    const prf = await import('../crypto/prf')
    vi.mocked(prf.deriveKey).mockClear()
    await enroll({ keys: snapshotKeys() })
    // Default mock returns prfOutput from enrollPrf → deriveKey NOT called.
    expect(vi.mocked(prf.deriveKey)).not.toHaveBeenCalled()
  })

  it('falls back to deriveKey (second prompt) when create() omits prfOutput', async () => {
    prfState.skipPrfInCreate = true
    setApiKey('p1', 'sk-x')
    const prf = await import('../crypto/prf')
    vi.mocked(prf.deriveKey).mockClear()
    await enroll({ keys: snapshotKeys() })
    expect(vi.mocked(prf.deriveKey)).toHaveBeenCalledTimes(1)
    prfState.skipPrfInCreate = false
  })

  it('never writes plaintext to IndexedDB (only ciphertext + salts + cred id)', async () => {
    setApiKey('openrouter', PLAINTEXT_KEY_OPENROUTER)
    setApiKey('openai', PLAINTEXT_KEY_OPENAI)
    await enroll({ keys: snapshotKeys() })

    const { getDB } = await import('../db')
    const db = await getDB()
    const rec = await db.get('secureKeyring', 'current')
    expect(rec).toBeDefined()
    const serialized = JSON.stringify(rec)
    expect(serialized).not.toContain(PLAINTEXT_KEY_OPENROUTER)
    expect(serialized).not.toContain(PLAINTEXT_KEY_OPENAI)
    // The provider ids (which are not secret) are also encrypted — only salts +
    // credential id + version + createdAt appear in cleartext.
    expect(serialized).not.toContain('openrouter')
  })

  it('overwrites a previous enrollment (re-wraps the DEK)', async () => {
    setApiKey('p1', 'first')
    await enroll({ keys: snapshotKeys() })
    const { getDB } = await import('../db')
    const db = await getDB()
    const first = await db.get('secureKeyring', 'current')
    expect(first).toBeDefined()

    setApiKey('p1', 'second')
    _resetForTests() // forget the cached DEK so enroll generates a new one
    await enroll({ keys: snapshotKeys() })
    const second = await db.get('secureKeyring', 'current')
    expect(second).toBeDefined()
    expect(second!.createdAt).toBeGreaterThanOrEqual(first!.createdAt)
    // New DEK → new ciphertext for the same plaintext would differ anyway, but
    // check the wrapped DEK differs too.
    expect(Array.from(second!.wrappedDek.ciphertext)).not.toEqual(
      Array.from(first!.wrappedDek.ciphertext),
    )
  })
})

describe('unlock', () => {
  it('restores every cached key into the keyring after a session restart', async () => {
    setApiKey('openrouter', PLAINTEXT_KEY_OPENROUTER)
    setApiKey('openai', PLAINTEXT_KEY_OPENAI)
    await enroll({ keys: snapshotKeys() })

    // Simulate tab close: in-memory state gone.
    clearAllKeys()
    _resetForTests()

    expect(getApiKey('openrouter')).toBeUndefined()
    const result = await unlock()
    expect(result.keysLoaded).toBe(2)
    expect(getApiKey('openrouter')).toBe(PLAINTEXT_KEY_OPENROUTER)
    expect(getApiKey('openai')).toBe(PLAINTEXT_KEY_OPENAI)
    expect(await getSnapshot()).toEqual({ enrolled: true, unlocked: true })
  })

  it('is a no-op when not enrolled', async () => {
    const result = await unlock()
    expect(result.keysLoaded).toBe(0)
  })

  it('reuses the cached DEK on repeated calls in the same session', async () => {
    setApiKey('p1', 'sk-x')
    await enroll({ keys: snapshotKeys() })
    clearAllKeys()

    const prf = await import('../crypto/prf')
    vi.mocked(prf.deriveKey).mockClear()
    await unlock()
    await unlock()
    // deriveKey should have been called at most once (the first unlock caches
    // the DEK; the second reuses it).
    expect(vi.mocked(prf.deriveKey).mock.calls.length).toBeLessThanOrEqual(1)
  })

  it('throws on user cancel and leaves the session locked', async () => {
    setApiKey('p1', 'sk-x')
    await enroll({ keys: snapshotKeys() })
    clearAllKeys()
    _resetForTests()

    prfState.shouldFail = true
    await expect(unlock()).rejects.toThrow()
    prfState.shouldFail = false
    expect(await getSnapshot()).toEqual({ enrolled: true, unlocked: false })
    expect(getApiKey('p1')).toBeUndefined()
  })

  it('fails decryption cleanly if the stored salt is corrupted (auth tag)', async () => {
    setApiKey('p1', 'sk-x')
    await enroll({ keys: snapshotKeys() })
    clearAllKeys()
    _resetForTests()

    // Corrupt the salt — derived KEK will differ, DEK unwrap fails (GCM auth).
    const { getDB } = await import('../db')
    const db = await getDB()
    const rec = await db.get('secureKeyring', 'current')
    expect(rec).toBeDefined()
    rec!.salt = new Uint8Array(32).fill(0xff)
    await db.put('secureKeyring', rec!)

    await expect(unlock()).rejects.toThrow()
    expect(getApiKey('p1')).toBeUndefined()
  })
})

describe('saveCurrentKeys', () => {
  it('re-encrypts the blob with the in-memory DEK (no biometric)', async () => {
    setApiKey('p1', 'first')
    await enroll({ keys: snapshotKeys() })
    const prf = await import('../crypto/prf')
    vi.mocked(prf.deriveKey).mockClear()

    setApiKey('p2', 'second')
    await saveCurrentKeys()

    // No additional PRF derivations during save (DEK already cached).
    expect(vi.mocked(prf.deriveKey)).not.toHaveBeenCalled()

    // Round-trip: simulate restart, unlock, check both keys restored.
    clearAllKeys()
    _resetForTests()
    const result = await unlock()
    expect(result.keysLoaded).toBe(2)
    expect(getApiKey('p1')).toBe('first')
    expect(getApiKey('p2')).toBe('second')
  })

  it('throws if called before unlock (no DEK in memory)', async () => {
    setApiKey('p1', 'first')
    await enroll({ keys: snapshotKeys() })
    _resetForTests()
    await expect(saveCurrentKeys()).rejects.toThrow(/unlock/i)
  })

  it('throws if not enrolled', async () => {
    _resetForTests()
    setApiKey('p1', 'x')
    await expect(saveCurrentKeys()).rejects.toThrow(/enrolled/i)
  })
})

describe('forget', () => {
  it('deletes the IDB record, the cached DEK, and clears the keyring', async () => {
    setApiKey('p1', 'sk-x')
    await enroll({ keys: snapshotKeys() })

    await forget()

    expect(await isEnrolled()).toBe(false)
    expect(await getSnapshot()).toEqual({ enrolled: false, unlocked: false })
    expect(getApiKey('p1')).toBeUndefined()

    const { getDB } = await import('../db')
    const db = await getDB()
    expect(await db.get('secureKeyring', 'current')).toBeUndefined()
  })

  it('is safe to call when not enrolled', async () => {
    await expect(forget()).resolves.toBeUndefined()
  })
})
