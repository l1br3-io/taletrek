# M6.1 — Biometric Key Caching (WebAuthn PRF) · Plan

> Decision: [`docs/adr/0007-biometric-key-caching.md`](../docs/adr/0007-biometric-key-caching.md).
> Augments (does not supersede) [`docs/adr/0004-api-key-threat-model.md`](../docs/adr/0004-api-key-threat-model.md) — in-memory stays the default and fallback.

## Goal

Cut per-session API-key friction for power users by adding an **opt-in** tier that
caches encrypted keys in IndexedDB, gated behind a WebAuthn PRF-derived key. One
biometric tap per session instead of paste-per-session. Default behaviour unchanged.

## Non-goals

- OAuth flows (deferred per ADR-0007; provider-fragmented in 2026).
- Master passphrase tier (rejected again — weaker than PRF where supported).
- Cross-device key sync (no backend per `VISION.md`).
- Changing `keyring.ts` API — engines keep calling `getApiKey(providerId)`.

## Architecture (from ADR-0007)

```
ENROLLMENT                       UNLOCK                        FORGET
──────────                       ─────                        ──────
DEK (random)                     PRF(salt) → KEK               delete IDB record
DEK → enc blob  ──► IDB          KEK → DEK                     keyring.clearAllKeys()
PRF(salt) → KEK                  DEK → blob
KEK → wrapped DEK ──► IDB        keyring.setApiKey(×N)
salt + credId + version ──► IDB
```

The wrapped DEK pattern (not PRF-as-key) lets us re-wrap on passkey rotation
without touching the ciphertext (per Tim Cappalli, W3C WebAuthn L3).

## Module map

| File (new)                                | Responsibility                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `web/src/lib/crypto/aes.ts`               | Pure AES-GCM `encrypt`/`decrypt`/`wrapKey`/`unwrapKey` over `crypto.subtle`. No DOM. |
| `web/src/lib/crypto/aes.test.ts`          | Round-trips, tamper detection (GCM auth), wrong-key rejection.        |
| `web/src/lib/crypto/prf.ts`               | Thin WebAuthn wrapper: `isPrfSupported`, `enrollPrf`, `deriveKey`. Mockable. |
| `web/src/lib/crypto/prf.test.ts`          | Mocked `navigator.credentials` — extension presence, RP-ID, salt flow. |
| `web/src/lib/ai/secure-keyring.ts`        | Orchestrator: `enroll`, `unlock`, `forget`, `isEnrolled`. Reads/writes IDB + keyring. |
| `web/src/lib/ai/secure-keyring.test.ts`   | Full flow with mocked PRF + real AES + fake-indexeddb.                |

| File (modified)                           | Change                                                                 |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| `web/src/lib/db/connection.ts`            | v5 → v6: add `secureKeyring` store (single record, key `'current'`).   |
| `web/src/lib/ai/types.ts`                 | `AiSettings.cloud.biometricUnlock?: boolean` (opt-in flag).            |
| `web/src/context/settings.tsx`            | Migrate the new field; on hydrate, attempt `secure-keyring.unlock()` when flag is on. |
| `web/src/routes/settings/ai-settings/CloudProvidersSection.tsx` | "Remember with biometric" toggle + unlock prompt + forget. |
| `web/src/routes/settings/clearAllData.ts` | Wipe `secureKeyring` (already covered by `clearAllStores`).            |
| `web/src/lib/ai/keyring.ts`               | **No changes.** Maybe expose `getAllKeys()` for serialization.         |

## Task ordering (TDD per slice)

```
S1 aes.ts           ──► S2 prf.ts          ──► S3 db v6
                                                  │
                                                  ▼
                       S4 secure-keyring.ts ──► S5 AiSettings flag + migration
                                                  │
                                                  ▼
                       S6 Settings UI        ──► S7 clearAllData wiring
                                                  │
                                                  ▼
                                  S8 browser-verify (Chrome DevTools MCP)
                                                  │
                                                  ▼
                                          S9 pnpm verify + docs
```

Each slice ships with tests written first (RED) → impl (GREEN) → biome/tsc (REFACTOR).

## Acceptance criteria

1. `pnpm verify` green (lint + typecheck + test + build).
2. With PRF unsupported (jsdom, old browsers), the toggle is hidden; app behaves identically to today.
3. With PRF supported: toggle enrollment → reload page → biometric prompt → keys restored to `keyring` (verifiable via a test-only inspector).
4. IndexedDB `secureKeyring` record contains **only** ciphertext + salts + credential id — never plaintext (grep assertion in test).
5. "Forget keys" wipes the IDB record and clears `keyring`.
6. Clear-all-data wipes the `secureKeyring` store alongside the others.
7. CSP allowlist unchanged and still primary exfiltration defence.
8. AGENTS.md status table updated; tasks/todo.md gets the M6.1 entry.
