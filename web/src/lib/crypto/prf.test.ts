import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveKey, enrollPrf, isPrfSupported } from './prf'

const RP_ID = 'localhost'

interface FakeCred {
  id: string
  getClientExtensionResults(): unknown
}

/**
 * Stand up a fake `navigator.credentials` for each test. PRF support is
 * signalled by returning `{ prf: { enabled: true, results: { first: <bytes> } } }`
 * from `getClientExtensionResults()`. The "authenticator" returns a
 * deterministic 32-byte derivation seeded by the salt so wrong-salt / wrong-PRF
 * cases can be asserted.
 *
 * WebAuthn API shape: `navigator.credentials.create({ publicKey: ... })` and
 * `.get({ publicKey: ... })` — the inner `publicKey` carries the extensions.
 *
 * `createEvaluatesPrf` (default `true`) controls whether the fake authenticator
 * returns `prf.results.first` during `create()` — the common case on modern
 * authenticators that lets `enroll()` skip the follow-up `get()`.
 */
function installFakeCredentials(
  opts: {
    create?: (opts: CredentialCreationOptions) => Promise<FakeCred>
    get?: (opts: CredentialRequestOptions) => Promise<FakeCred>
    prfDerivation?: (salt: Uint8Array) => Uint8Array
    createEvaluatesPrf?: boolean
  } = {},
): void {
  const defaultDerivation = (salt: Uint8Array): Uint8Array => {
    const out = new Uint8Array(32)
    for (let i = 0; i < 32; i++) out[i] = (salt[i % salt.byteLength] ?? 0) ^ i
    return out
  }
  const derive = opts.prfDerivation ?? defaultDerivation
  const evalDuringCreate = opts.createEvaluatesPrf ?? true

  const mkFake = (results: unknown): FakeCred => ({
    id: 'cred-1',
    getClientExtensionResults: () => results,
  })

  const readPrfSalt = (
    ext: AuthenticationExtensionsClientInputs | undefined,
  ): Uint8Array | undefined =>
    (ext?.['prf'] as { eval?: { first?: Uint8Array } } | undefined)?.eval?.first

  const credentials = {
    create: vi.fn(async (o: CredentialCreationOptions) => {
      if (opts.create) return opts.create(o)
      const salt = readPrfSalt(o.publicKey?.extensions)
      if (salt && evalDuringCreate) {
        return mkFake({ prf: { enabled: true, results: { first: derive(salt) } } })
      }
      return mkFake({ prf: { enabled: Boolean(salt) } })
    }),
    get: vi.fn(async (o: CredentialRequestOptions) => {
      if (opts.get) return opts.get(o)
      const prfInput = readPrfSalt(o.publicKey?.extensions)
      return mkFake({
        prf: {
          enabled: Boolean(prfInput),
          results: prfInput ? { first: derive(prfInput) } : {},
        },
      })
    }),
  }
  Object.defineProperty(navigator, 'credentials', { value: credentials, configurable: true })
}

describe('isPrfSupported', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'credentials', { value: undefined, configurable: true })
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      value: undefined,
      configurable: true,
      writable: true,
    })
  })

  it('returns false when navigator.credentials is missing (jsdom, old browsers)', async () => {
    expect(await isPrfSupported()).toBe(false)
  })

  it('returns false when PublicKeyCredential is undefined', async () => {
    installFakeCredentials()
    expect(await isPrfSupported()).toBe(false)
  })

  it('returns true when the WebAuthn API surface is present (prompt-free)', async () => {
    installFakeCredentials()
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      value: class PublicKeyCredential {},
      configurable: true,
      writable: true,
    })
    expect(await isPrfSupported()).toBe(true)
  })

  it('returns true without calling navigator.credentials.create (no passkey prompt)', async () => {
    installFakeCredentials()
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      value: class PublicKeyCredential {},
      configurable: true,
      writable: true,
    })
    await isPrfSupported()
    // The bug this guards against: probing used to call create(), which
    // triggered a passkey prompt on every BiometricKeyringSection mount.
    const creds = navigator.credentials as unknown as { create: { mock?: { calls: unknown[] } } }
    expect(creds.create.mock?.calls.length ?? 0).toBe(0)
  })
})

describe('enrollPrf', () => {
  beforeEach(() => installFakeCredentials())
  afterEach(() => vi.restoreAllMocks())

  it('returns the credential id and signals support', async () => {
    const result = await enrollPrf(RP_ID)
    expect(result.credentialId).toBe('cred-1')
    expect(result.supported).toBe(true)
  })

  it('returns prfOutput when the authenticator evaluates PRF during create()', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(32))
    const result = await enrollPrf(RP_ID, salt)
    expect(result.prfOutput).toBeDefined()
    expect(result.prfOutput).toHaveLength(32)
  })

  it('omits prfOutput when the authenticator does not evaluate during create()', async () => {
    installFakeCredentials({ createEvaluatesPrf: false })
    const result = await enrollPrf(RP_ID, crypto.getRandomValues(new Uint8Array(32)))
    expect(result.supported).toBe(true)
    expect(result.prfOutput).toBeUndefined()
  })

  it('uses the provided salt as the PRF eval input during create()', async () => {
    const create = vi.fn(async (_o: CredentialCreationOptions) => ({
      id: 'cred-x',
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
    }))
    installFakeCredentials({ create: async (o) => create(o) })
    const salt = new Uint8Array(32).fill(77)
    await enrollPrf(RP_ID, salt)
    const arg = create.mock.calls[0]?.[0] as CredentialCreationOptions
    const pk = arg.publicKey as PublicKeyCredentialCreationOptions
    const prf = pk.extensions?.['prf'] as { eval?: { first?: Uint8Array } }
    expect(Array.from(prf.eval?.first ?? [])).toEqual(Array.from(salt))
  })

  it('passes the PRF extension and rp.id in the create options', async () => {
    const create = vi.fn(async (_o: CredentialCreationOptions) => ({
      id: 'cred-x',
      getClientExtensionResults: () => ({ prf: { enabled: true } }),
    }))
    installFakeCredentials({ create: async (o) => create(o) })
    await enrollPrf(RP_ID)
    expect(create).toHaveBeenCalled()
    const arg = create.mock.calls[0]?.[0]
    const pk = (arg as CredentialCreationOptions).publicKey as PublicKeyCredentialCreationOptions
    expect(pk.extensions?.['prf']).toBeDefined()
    expect(pk.rp.id).toBe(RP_ID)
    expect(pk.user.id).toBeInstanceOf(Uint8Array)
  })

  it('returns supported:false if the authenticator did not enable PRF', async () => {
    installFakeCredentials({
      create: async () => ({
        id: 'c',
        getClientExtensionResults: () => ({ prf: { enabled: false } }),
      }),
    })
    const result = await enrollPrf(RP_ID)
    expect(result.supported).toBe(false)
    expect(result.credentialId).toBe('c')
    expect(result.prfOutput).toBeUndefined()
  })

  it('propagates user-cancel as a thrown error', async () => {
    installFakeCredentials({
      create: async () => {
        throw new DOMException('User cancelled', 'AbortError')
      },
    })
    await expect(enrollPrf(RP_ID)).rejects.toThrow()
  })
})

describe('deriveKey', () => {
  beforeEach(() => installFakeCredentials())
  afterEach(() => vi.restoreAllMocks())

  it('returns 32 bytes derived from the salt', async () => {
    const salt = new Uint8Array(32).fill(42)
    const out = await deriveKey({ rpId: RP_ID, credentialId: 'cred-1', salt })
    expect(out).toHaveLength(32)
  })

  it('is deterministic for the same salt (mocked authenticator)', async () => {
    const salt = new Uint8Array(32).fill(7)
    const a = await deriveKey({ rpId: RP_ID, credentialId: 'cred-1', salt })
    const b = await deriveKey({ rpId: RP_ID, credentialId: 'cred-1', salt })
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('differs for different salts', async () => {
    const a = await deriveKey({
      rpId: RP_ID,
      credentialId: 'cred-1',
      salt: new Uint8Array(32).fill(1),
    })
    const b = await deriveKey({
      rpId: RP_ID,
      credentialId: 'cred-1',
      salt: new Uint8Array(32).fill(2),
    })
    expect(Array.from(a)).not.toEqual(Array.from(b))
  })

  it('passes the salt as the PRF eval input', async () => {
    const get = vi.fn(async (o: CredentialRequestOptions) => {
      const salt =
        (o.publicKey?.extensions?.['prf'] as { eval?: { first?: Uint8Array } })?.eval?.first ??
        new Uint8Array(0)
      const out = new Uint8Array(32)
      for (let i = 0; i < 32; i++) out[i] = salt[i % salt.byteLength] ?? 0
      return {
        id: 'cred-1',
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: out } } }),
      }
    })
    installFakeCredentials({ get: async (o) => get(o) })
    const salt = new Uint8Array(32).fill(99)
    await deriveKey({ rpId: RP_ID, credentialId: 'cred-1', salt })
    const arg = get.mock.calls[0]?.[0] as CredentialRequestOptions
    const pk = arg.publicKey as PublicKeyCredentialRequestOptions
    const prf = pk.extensions?.['prf'] as { eval?: { first?: Uint8Array } }
    expect(Array.from(prf.eval?.first ?? [])).toEqual(Array.from(salt))
  })

  it('scopes the request to the stored credential via allowCredentials', async () => {
    const get = vi.fn(async (o: CredentialRequestOptions) => {
      const pk = o.publicKey as PublicKeyCredentialRequestOptions
      const ext = pk.extensions?.['prf'] as { eval: { first: Uint8Array } } | undefined
      const salt = ext?.eval?.first
      const out = new Uint8Array(32).fill(salt?.[0] ?? 0)
      return {
        id: 'cred-1',
        getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: out } } }),
      }
    })
    installFakeCredentials({ get: async (o) => get(o) })
    await deriveKey({ rpId: RP_ID, credentialId: 'cred-xyz', salt: new Uint8Array(32).fill(1) })
    const arg = get.mock.calls[0]?.[0]
    const pk = (arg as CredentialRequestOptions).publicKey as PublicKeyCredentialRequestOptions
    const cred = pk.allowCredentials?.[0]
    expect(cred).toBeDefined()
    // credentialId is decoded from base64url back to bytes for allowCredentials.
    expect(cred?.id).toBeInstanceOf(Uint8Array)
    // transports intentionally omitted — let the browser pick the right transport.
    // Hard-coding 'internal' breaks on Linux/hybrid authenticators.
    expect(cred?.transports ?? []).toHaveLength(0)
  })

  it('throws if the authenticator omits results.first', async () => {
    installFakeCredentials({
      get: async () => ({
        id: 'c',
        getClientExtensionResults: () => ({ prf: { enabled: true, results: {} } }),
      }),
    })
    await expect(
      deriveKey({ rpId: RP_ID, credentialId: 'c', salt: new Uint8Array(32) }),
    ).rejects.toThrow()
  })

  it('throws on user-cancel', async () => {
    installFakeCredentials({
      get: async () => {
        throw new DOMException('cancelled', 'AbortError')
      },
    })
    await expect(
      deriveKey({ rpId: RP_ID, credentialId: 'c', salt: new Uint8Array(32) }),
    ).rejects.toThrow()
  })
})
