# ADR-0007: Biometric-gated key caching via WebAuthn PRF

- **Status:** Accepted. *(Historical — biometric key caching was removed from the SPA by the native pivot, [`0015-native-pivot-rust-kernel-and-native-apps.md`](./0015-native-pivot-rust-kernel-and-native-apps.md).)*
- **Date:** 2026-07-17
- **Companion:** [`0004-api-key-threat-model.md`](./0004-api-key-threat-model.md) (augmented, not superseded)

## Context

ADR-0004 chose **in-memory only** for cloud API keys: the key lives in a module-scoped variable, dies on tab close, and must be re-pasted every session. This is the strictest viable no-backend option and remains the right *default*. The cost is per-session friction — a power user who runs transforms daily pastes their key daily.

The user asked: *can we keep security but reduce friction without adding a backend, ideally via OAuth or "safe" key storage?*

Research findings (2026-07-17):

- **Provider OAuth is a dead end.** Anthropic actively blocked subscription OAuth tokens in third-party tools (Jan 2026); OpenAI offers no browser→API OAuth; only Google Gemini supports it. Building a Google-only path reintroduces per-provider surface (rejected in ADR-0003) for ~1 of 5 supported providers.
- **Master passphrase + AES-GCM (Tier-3, rejected in ADR-0004)** remains obfuscation-tier — an XSS just waits for the user to type the passphrase.
- **WebAuthn PRF extension** is the genuinely promising option: a passkey/platform authenticator (Touch ID, Face ID, Windows Hello, YubiKey) can derive a stable hardware-backed secret. We use that secret to wrap a random data-encryption key (DEK), which encrypts the API-key blob at rest in IndexedDB.

## Threat model delta vs ADR-0004

| Threat                                       | ADR-0004 (in-memory)      | ADR-0007 (PRF tier, opt-in)                                                            |
| -------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------- |
| Disk-only theft (stolen laptop, no device)   | ✅ nothing on disk        | ✅ encrypted blob on disk, useless without the authenticator                            |
| Passive XSS in a background tab              | ✅ key not yet in memory  | ✅ XSS cannot trigger biometric silently — WebAuthn requires user gesture + verification |
| Casual `indexedDB.open()` in DevTools          | ✅ nothing to see         | ✅ sees ciphertext only                                                                 |
| Phishing on a lookalike origin               | n/a                       | ✅ WebAuthn is origin-bound — authenticator refuses foreign RP IDs                       |
| **Active XSS during an unlocked session**        | ❌ key readable           | ❌ **same — once decrypted to memory, XSS reads it. CSP `connect-src` remains primary.**    |
| Malicious browser extension                  | ❌ readable in page scope | ❌ same                                                                                  |
| Loss of authenticator                        | n/a                       | ⚠ wrapped key unrecoverable; user re-enters API key once + re-enrolls with new passkey    |

**Net change vs the in-memory default:** the user accepts an encrypted blob on disk in exchange for one biometric tap per session instead of a paste. The XSS-during-session story is unchanged — both tiers rely on the CSP allowlist as the primary exfiltration defence.

## Decision

**Add an opt-in biometric-caching tier on top of ADR-0004's in-memory default. The default behaviour is unchanged.**

### Architecture

```
ENROLLMENT (user toggles "Remember with biometric" while ≥1 key is in memory)
  1. random DEK (32 bytes)                              ← crypto.getRandomValues
  2. DEK  --AES-GCM-->  encrypted API-key blob          ← stored in IDB secureKeyring
  3. WebAuthn PRF(salt_A) → KEK (32 bytes)              ← requires biometric
  4. KEK  --AES-GCM-->  wrapped DEK                     ← stored in IDB secureKeyring
  5. salt_A, PRF credential id, version                 ← stored in IDB secureKeyring

UNLOCK (on app mount, when biometricUnlock === true and PRF is supported)
  1. read wrapped DEK + salt_A from IDB
  2. WebAuthn PRF(salt_A) → KEK                         ← requires biometric (user gesture)
  3. KEK  --AES-GCM-->  DEK
  4. DEK  --AES-GCM-->  API-key blob
  5. for each entry: keyring.setApiKey(providerId, key) ← existing in-memory holder

FORGET (user taps "Forget keys" or disables the tier)
  1. delete IDB secureKeyring record
  2. keyring.clearAllKeys()
```

### Key choices

| Choice                                             | Rationale                                                                                                                                                |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wrap a random DEK, don't use PRF output directly** | Per Tim Cappalli (W3C WebAuthn L3 co-editor): passkey rotation would brick data encrypted directly with PRF output. Wrapping a DEK we control lets us re-wrap on re-enrollment without touching the ciphertext. |
| **AES-GCM via `crypto.subtle`**                    | Built-in, no dependency, authenticated encryption (detects tampering).                                                                                   |
| **Single DEK wraps the whole keyring map**         | One enrollment covers every provider. Simple UX ("Remember with biometric" toggle), simple recovery (one re-paste per provider on loss).                   |
| **Opt-in, not default**                            | Default behaviour is unchanged (ADR-0004 in-memory). Users who prefer the strictest tier keep it. Power users opt in explicitly after reading the honest copy. |
| **Silent fallback to in-memory**                   | PRF browser/authenticator support is not universal (Chrome/Edge yes; Safari 18+; Firefox partial; not all authenticators). Where unsupported, the toggle is hidden or disabled and the app behaves exactly like today. |
| **No OAuth for v1**                                | Provider support is fragmented and provider-hostile in 2026. Revisit when a standardised browser-native flow exists across OpenAI/Anthropic/Google.       |

### Browser support policy

- Detect PRF support at enrollment time: call `navigator.credentials.create` with `extensions.prf` and inspect `getClientExtensionResults().prf?.enabled`.
- The "Remember with biometric" UI is **only shown when support is detected**. Unsupported browsers see no change from today.
- Unlock attempts that fail (user cancels biometric, authenticator unavailable) fall back silently to the in-memory tier — the user simply pastes their key.

## Consequences

- **Positive:** Power users get one-tap-per-session instead of paste-per-session, with a hardware-backed gate that master-passphrase Tier-3 lacks.
- **Negative:** An encrypted blob now lives in IndexedDB (vs nothing today). This is the explicit trade the user accepted.
- **New module:** `web/src/lib/ai/secure-keyring.ts` (orchestrator) + `web/src/lib/crypto/{aes,prf}.ts` (primitives). The existing `keyring.ts` is unchanged — it remains the only module that holds plaintext keys in memory, and engines keep reading via `getApiKey(providerId)`.
- **DB schema bump:** v5 → v6 (additive `secureKeyring` store, single record).
- **ADR-0004 status:** Augmented, **not superseded**. The in-memory tier remains the default and the fallback; the CSP allowlist remains the primary exfiltration defence; the threat-model framing ("no client-side credential is ever 'safe' in an absolute sense") is unchanged. ADR-0007 adds a tier for users whose threat tolerance accepts an encrypted blob on disk behind a biometric gate.
- **Reversibility:** The PRF tier is fully isolated. Disabling the toggle wipes the IDB record; the in-memory tier keeps working untouched.

## Alternatives considered

1. **Reopen Tier-3 (master passphrase).** Universally supported but weak — obfuscation against casual inspection, not real defence. Rejected in favour of PRF where supported; users without PRF stay on in-memory rather than getting a false sense of security from Tier-3.
2. **Per-provider OAuth (Google-only).** Fragmented UX, one of five providers, provider-hostile in 2026. Deferred per ADR-0004's original call.
3. **Persist plaintext in IndexedDB.** Strictly worse than both tiers. Never considered.
4. **OPFS instead of IndexedDB for the blob.** Same exfiltration surface (JS-readable), no measurable benefit for ~200 bytes of ciphertext. IDB keeps it co-located with the rest of the schema and wiped by `clearAllStores`.
5. **Encrypt with a passphrase derived from the user's TaleTrek settings password.** TaleTrek has no accounts and no settings password (per `VISION.md` non-goals). Not applicable.
