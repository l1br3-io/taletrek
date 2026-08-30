# ADR-0004: API key threat model — in-memory only

- **Status:** Accepted (default tier). **Augmented** by [`0007-biometric-key-caching.md`](./0007-biometric-key-caching.md) — an opt-in biometric-caching tier was added in M6.1. The in-memory default, the CSP allowlist as primary defence, and the threat-model framing below all remain authoritative. *(Historical — the key-handling feature this guards was removed from the SPA by the native pivot, [`0015-native-pivot-rust-kernel-and-native-apps.md`](./0015-native-pivot-rust-kernel-and-native-apps.md).)*
- **Date:** 2026-07-12
- **Companion:** [`0003-ai-transform-architecture.md`](./0003-ai-transform-architecture.md), [`0007-biometric-key-caching.md`](./0007-biometric-key-caching.md)

## Context

The M6 cloud backend (`ADR-0003`) requires an API key for the user's chosen OpenAI-compatible provider. The key is the user's own — TaleTrek never brokers requests server-side — but if the key leaks, an attacker can spend the user's meter and read their provider-side data. The user's question that opened this ADR was direct: *"is it safe to upload the API key since it's local?"*

The honest answer is that **no client-side credential is ever "safe"** in an absolute sense. The JS that uses the key runs in the same origin as any other JS, so anything that can run TaleTrek's JS can read the key. The right framing is not "make it safe" (impossible) but **"drive the practical risk down to the level of any other client-side credential flow, and no further than the user's actual threat tolerance justifies."**

## Threat model

| Threat                                  | Likelihood | Impact                             | TaleTrek controls                                                                                |
| --------------------------------------- | ---------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| **XSS in TaleTrek's own code**            | Low        | Key read, exfiltrated              | Strict CSP `connect-src` allowlist (primary mitigation — see below); minimal external scripts; no `dangerouslySetInnerHTML` on untrusted text; audit deps. |
| **Malicious browser extension**           | Medium     | Key read from page context         | None possible — user's machine, user's extensions. Warned in UI copy.                            |
| **Compromised third-party script**        | Low–Med    | Key read, exfiltrated              | TaleTrek loads almost nothing external today. New external scripts are reviewed under M0 boundaries. |
| **Other local malware with profile access** | User-dependent | Key read from disk if persisted  | **Mitigated by never persisting the key.** In-memory only — nothing on disk to read.             |
| **Phishing-style UI mimicry**             | Very Low   | User pastes key into wrong field   | Key input is single clearly-labelled field in Settings; no in-reader key prompts.                 |
| **Provider-side breach**                  | Out of scope | Out of scope                     | Provider's responsibility; user should use scoped/capped keys regardless.                        |

## Decision

**In-memory only. No persistence of any kind.**

The key lives in a module-scoped variable inside `web/src/lib/ai/keyring.ts`:

```ts
let key: string | undefined

export function setApiKey(next: string): void { key = next }
export function getApiKey(): string | undefined { return key }
export function clearApiKey(): void { key = undefined }
```

- **Never** written to IndexedDB, localStorage, sessionStorage, cookies, OPFS, or any other browser-storage API.
- **Dies on tab close.** Re-opening the app the next day requires re-entering the key. This is intentional — it bounds the breach window to a single session.
- **Survives page reloads within a tab** (the module variable persists across `location` reloads within the same browsing context).
- **Explicit "Forget key" button** in Settings, in addition to the implicit tab-close clearance.

**Primary mitigation: strict CSP `connect-src` allowlist.** Even if XSS reads the key, it cannot exfiltrate it — `fetch()` to any non-allowlisted host throws at the network layer. The allowlist covers known OpenAI-compatible host patterns (`*.openai.com`, `api.anthropic.com`, `openrouter.ai`, `api.groq.com`, `api.together.xyz`, `localhost`) plus whatever `baseUrl` the user has configured for cloud. This single mitigation is more valuable than any at-rest encryption.

**Provider-side recommendation:** Settings copy nudges users toward **provider-scoped, spend-capped keys** (OpenAI projects with monthly limits; Anthropic workspace limits; throwaway keys with $5–10 caps). This bounds the blast radius regardless of any client-side mitigation.

## Consequences

- **UX cost: re-enter key per session.** Acceptable for a power-user feature. Most transforms are batch operations done in one sitting; the friction is bounded. The transformed output itself persists in `Chapter.paragraphs`, so future reads of the same book don't need the key.
- **Tab-close mid-transform loses the key but not progress.** Per-paragraph completion is checkpointed to IndexedDB (per `ai-transforms/spec.md` risks table); resuming requires only re-entering the key.
- **IndexedDB / localStorage / sessionStorage dumps show no key.** This is verifiable in browser DevTools and is part of the M6 acceptance criteria (Success Criterion #3).
- **CSP allowlist must be maintained.** New providers require a Settings-driven extension to the allowlist for the user's session. User-configured `baseUrl` is automatically allowlisted for that session.
- **Tier-2 (IndexedDB at-rest) and Tier-3 (master-passphrase encryption)** are explicitly **not** built. They would add UX friction (master password) without adding real security (the JS still decrypts). Revisit only if power users explicitly request "remember key" and accept the documented risk.

## Alternatives considered

1. **IndexedDB at-rest (Tier-2)** — convenient (key survives tab close), but exposes the key to XSS / extensions / profile-access malware for the lifetime of the browser profile. The convenience does not justify the larger breach window for what is fundamentally a power-user feature. Rejected.

2. **Master passphrase + AES-GCM (Tier-3)** — encrypt the key in IndexedDB with a passphrase-derived key (PBKDF2 in a worker). Sounds more secure; isn't. The JS that decrypts runs in the same origin as any attacker JS, so an XSS that wants the key just waits for the user to enter the passphrase. It's obfuscation against casual `indexedDB.open()` inspection, not protection against active attack. Adds friction, doesn't add real defense. Rejected for v1.

3. **OAuth / provider token flows** — would avoid storing raw API keys. Reality: OpenAI and Anthropic don't expose OAuth for direct browser→API flows; Google Gemini does, but only for Google accounts and only via popup. Adding OAuth for one provider reintroduces per-provider code surface (rejected in ADR-0003). Defer until providers standardize a browser-native flow.

4. **sessionStorage compromise** — sessionStorage is async-accessible only but still readable by any same-origin script. Slightly better than localStorage (dies on tab close) but no real improvement over pure in-memory module scope. Rejected in favor of pure module scope, which is the strictest option.

5. **Proxy through a TaleTrek-owned backend** — would solve key-exfil (browser never sees the key) but violates the `VISION.md` "no backend, no cloud" non-goal. TaleTrek the service stays serverless. The user's relationship with their LLM provider stays direct. Rejected.

6. **Skip cloud entirely** — eliminates the threat by eliminating the feature. Rejected in ADR-0003: power users who want GPT-4o / Claude / Gemini quality should be able to opt in without abandoning TaleTrek, and the all-client-side cost of including the cloud path is low.
