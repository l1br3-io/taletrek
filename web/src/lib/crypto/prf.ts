/**
 * Thin wrapper around the WebAuthn PRF (Pseudo-Random Function) extension.
 *
 * PRF lets a passkey / platform authenticator (Touch ID, Face ID, Windows
 * Hello, YubiKey) derive a stable 32-byte secret from `(privateKey, salt)`
 * without ever exposing the private key. We use the derived bytes as the
 * AES-256 KEK that wraps the data-encryption key for the cached API keys
 * (`secure-keyring.ts`, ADR-0007).
 *
 * The PRF output is gated by user verification (biometric / PIN) — an attacker
 * script that lands in the page cannot trigger it silently; the browser
 * enforces a user gesture + authenticator presence. The authenticator is also
 * origin-bound: a phishing page on a lookalike domain cannot request a PRF
 * output for this RP ID.
 *
 * All functions throw on user-cancel / unsupported authenticator; callers are
 * expected to catch and fall back to the in-memory tier (ADR-0004 default).
 *
 * Spec: w3c/webauthn L3 §10.4 (PRF extension). The extension id is the string
 * `'prf'`; negotiation is via `extensions.prf` on both create and get.
 */

/** WebAuthn extension id for the PRF extension. */
const PRF_EXTENSION_ID = 'prf'

/**
 * Decode a base64url credential id (as returned by `PublicKeyCredential.id`)
 * back into raw bytes for `allowCredentials[].id`, which expects `BufferSource`.
 * base64url differs from base64 only in `+→-`, `/→_`, and no padding.
 */
function decodeCredentialId(id: string): Uint8Array {
  const padded = id.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** The RP ID for the credential store. Defaults to `location.hostname`. */
function rpIdOrDefault(explicit?: string): string {
  return explicit ?? globalThis.location?.hostname ?? 'localhost'
}

function hasCredentialsApi(): boolean {
  return typeof navigator !== 'undefined' && navigator.credentials != null
}

/**
 * Probe whether the platform exposes the WebAuthn surface needed for PRF.
 * **Prompt-free** — never calls `navigator.credentials.create()` (which would
 * pop a passkey prompt on every mount of `BiometricKeyringSection`).
 *
 * The actual PRF-support signal (`getClientExtensionResults().prf.enabled`)
 * only appears after a real `create()`, so this function is intentionally
 * permissive: it returns `true` whenever the WebAuthn API surface is present.
 * The truth is learned when the user clicks Enable — if their authenticator
 * doesn't support PRF, `enroll()` throws with a clear error and the UI falls
 * back to the in-memory tier.
 */
export async function isPrfSupported(): Promise<boolean> {
  return (
    hasCredentialsApi() &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials.create === 'function'
  )
}

export interface EnrollResult {
  /** Credential id (base64url string) — stored so future get() calls can scope to it. */
  credentialId: string
  /** True only if the authenticator confirmed PRF support. */
  supported: boolean
  /**
   * PRF output (32 bytes) if the authenticator evaluated the PRF during
   * `create()`. Most modern authenticators do, which lets `enroll()` skip the
   * follow-up `get()` entirely — **one prompt instead of two**. Absent on
   * older authenticators; the caller must fall back to `deriveKey()`.
   */
  prfOutput?: Uint8Array
}

/**
 * Create a discoverable WebAuthn credential that signals PRF support, and —
 * when the authenticator cooperates — evaluate the PRF in the same ceremony.
 *
 * Pass the **real KEK salt** (not a throwaway probe salt) so that when the
 * authenticator returns `prf.results.first`, the caller can use it directly as
 * the KEK without a second `get()` prompt.
 *
 * Throws on user cancel; the caller should fall back to the in-memory tier.
 */
export async function enrollPrf(rpId?: string, salt?: Uint8Array): Promise<EnrollResult> {
  if (!hasCredentialsApi()) {
    throw new Error('WebAuthn is unavailable in this environment.')
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const userId = crypto.getRandomValues(new Uint8Array(16))
  const evalSalt = salt ?? crypto.getRandomValues(new Uint8Array(32))

  const publicKey: PublicKeyCredentialCreationOptions = {
    challenge,
    rp: { id: rpIdOrDefault(rpId), name: 'TaleTrek' },
    user: {
      id: userId,
      name: 'taletrek-keyring',
      displayName: 'TaleTrek keyring',
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 }, // ES256
      { type: 'public-key', alg: -257 }, // RS256
    ],
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    extensions: {
      [PRF_EXTENSION_ID]: { eval: { first: evalSalt } },
    } as AuthenticationExtensionsClientInputs,
  }

  const credential = (await navigator.credentials.create({ publicKey })) as
    | (PublicKeyCredential & { getClientExtensionResults(): AuthenticationExtensionsClientOutputs })
    | null
  if (!credential) throw new Error('WebAuthn create() returned no credential.')

  const ext = credential.getClientExtensionResults() as unknown as {
    prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } }
  }

  let prfOutput: Uint8Array | undefined
  const first = ext.prf?.results?.first
  if (first) {
    prfOutput = first instanceof Uint8Array ? first : new Uint8Array(first)
    if (prfOutput.byteLength !== 32) {
      throw new Error(`PRF output must be 32 bytes (got ${prfOutput.byteLength}).`)
    }
  }

  return {
    credentialId: credential.id,
    supported: ext.prf?.enabled === true,
    prfOutput,
  }
}

export interface DeriveOptions {
  rpId?: string
  /** Credential id from {@link enrollPrf}. Scopes the request so the picker is skipped. */
  credentialId?: string
  /** Salt passed to the PRF. Same salt + same credential → same 32 output bytes. */
  salt: Uint8Array
}

/**
 * Trigger user verification + derive 32 raw bytes from `(credential, salt)`.
 * The user sees a biometric prompt; on success, returns the deterministic PRF
 * output to use as a KEK.
 *
 * Throws on cancel, missing results, or PRF-not-enabled. Callers fall back to
 * the in-memory tier.
 */
export async function deriveKey(opts: DeriveOptions): Promise<Uint8Array> {
  if (!hasCredentialsApi()) {
    throw new Error('WebAuthn is unavailable in this environment.')
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32))
  const publicKey: PublicKeyCredentialRequestOptions = {
    challenge,
    rpId: rpIdOrDefault(opts.rpId),
    userVerification: 'required',
    extensions: {
      [PRF_EXTENSION_ID]: { eval: { first: opts.salt } },
    } as AuthenticationExtensionsClientInputs,
  }
  if (opts.credentialId) {
    publicKey.allowCredentials = [
      {
        id: decodeCredentialId(opts.credentialId) as BufferSource,
        type: 'public-key',
      },
    ]
  }

  const assertion = (await navigator.credentials.get({ publicKey })) as
    | (PublicKeyCredential & { getClientExtensionResults(): AuthenticationExtensionsClientOutputs })
    | null
  if (!assertion) throw new Error('WebAuthn get() returned no assertion.')

  const ext = assertion.getClientExtensionResults() as unknown as {
    prf?: { results?: { first?: ArrayBuffer | Uint8Array } }
  }
  const first = ext.prf?.results?.first
  if (!first) {
    throw new Error('PRF derivation returned no output. Is the credential a PRF-capable one?')
  }
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first)
  if (bytes.byteLength !== 32) {
    throw new Error(`PRF output must be 32 bytes (got ${bytes.byteLength}).`)
  }
  return bytes
}
