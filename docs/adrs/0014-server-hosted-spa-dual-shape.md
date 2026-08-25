# ADR-0014: Server-hosted SPA — one build, two shapes

- **Status:** Accepted
- **Date:** 2026-08-25
- **Supersedes:** the "live SPA↔server connection (cloud sync)" rejection (alternative #2) in [`0013-off-device-synth-and-portable-bundles.md`](./0013-off-device-synth-and-portable-bundles.md) — *narrowly, that alternative only.* Everything else in ADR-0013 stands.
- **Companion:** [`../specs/server-hosted-spa/spec.md`](../specs/server-hosted-spa/spec.md)

## Context

Effort 4 shipped the personal server: library storage, inline Piper synth, a job queue with progress, and single-token auth (cookie for browsers, bearer for API). But the SPA reaches it only through manual bundle export → upload → download → import. Two apps with the same job: the offline-first PWA where the user lives, and a server with an operator-grade askama panel.

ADR-0013 rejected a live SPA↔server connection for v1 because it "adds auth, real-time progress, conflict resolution, and weakens offline-first." As of effort 4, each concern has an answer:

- **Auth** — shipped: single token, cookie or bearer, single user per instance.
- **Real-time progress** — job polling shipped; SSE/WebSocket remain a follow-up, not a prerequisite.
- **Conflict resolution** — designed away: hosted mode is online-only with last-write-wins progress (`PATCH …/progress` on `updatedAt`). There is no offline cache to reconcile and no cross-mode sync.
- **Offline-first** — preserved by separation: the standalone shape is untouched, and hosted mode deliberately forgoes offline rather than weakening the guarantee.

## Decision

The personal server hosts the **same SPA build** as the standalone PWA, making it a live, same-origin, cookie-authed API client of the server. One app, two deployment shapes; Tier 3 completes.

### The dual-shape contract

- **One build, two shapes.** A single `web/dist`; no env-specific build. A `datasource/` facade in the SPA (`LibraryDatasource` + `SynthPipeline`) is the only seam; UI never touches `lib/db` or `fetch` directly.
- **Boot-time mode resolution.** The app probes same-origin `GET /api/session` at boot. Authed 200 → server mode; unreachable → local mode (today's PWA, byte-identical behavior); 401 → redirect to `/ui/login`.
- **Same-origin only in v1.** The server serves the SPA; there is no "remote server URL" setting and no CORS surface. (A remote mode for the standalone PWA stays a follow-on.)
- **Online-only hosted mode.** The service worker is network-only for `/api`; offline remains the standalone PWA's job. No cache/reconciliation layer.
- **Client-side AI keys.** Keys stay in the local secure keyring (ADR-0007); the server never holds LLM keys. Transform-then-synth: transform in the browser before the first POST; re-transform = idempotent re-POST + resynth.

### ADR-0013 invariants that survive

- **Parsing stays browser-side.** Hosted upload = parse in Web Workers → in-memory text-only bundle → `POST /api/books`. No Rust PDF/EPUB/MOBI parsers.
- **On-device Piper stays** — in the standalone shape. When hosted, synthesis is server-side only; on-device Piper, whole-book mobile encode, and voice OPFS downloads do not run.
- **File-based interchange stays.** `.taletrek` bundles remain the desktop/Tier-2 bridge and the export/import surface; they are not deprecated by the live connection.
- **Self-hosted, single-user trust model stays.** Auth is unchanged from effort 4; no accounts, no multi-user.

## Consequences

- **Positive:** `docker run` → login → the full TaleTrek UX from the server origin, with synthesis that survives tab close. The askama operator panel is deleted once the hosted SPA reaches parity (the no-JS `/ui/login` cookie gate stays).
- **Positive:** the standalone PWA is fenced by the existing test suite — the datasource refactor is pure, so "identical behavior" is enforceable, not aspirational.
- **Cost:** the server gains a JS-app serving surface — SPA fallback static serving, a tightened CSP, and a multi-stage Docker build (pnpm → dist → server image).
- **Cost:** two datasource implementations to keep in parity; mitigated by the facade and per-impl tests (mocked `fetch` for `ServerDatasource`).
- **Negative:** hosted users have no offline. Deliberate and documented; the offline guarantee lives entirely in the standalone shape.
- **Risk:** hosted playback leans on `decodeAudioData`/`<audio>` opus handling (Safari) — already exercised by the effort-3 import path; verify on real hardware early (spec risk R2).

## Alternatives considered

1. **Keep bundles-only interchange (status quo after effort 4).** Rejected — the manual export/import round-trip is the exact friction users feel; the server already has everything the SPA needs behind its JSON API.
2. **Remote-server mode for the standalone PWA** (server-URL setting + CORS + token in settings). Rejected for v1 — CORS config, a token field in storage, and a weaker cookie story, all to avoid hosting a static dir. Same-origin hosting is simpler on every axis; remains a follow-on.
3. **A separate hosted SPA build** (env-specific). Rejected — two builds drift apart; one build with runtime resolution keeps parity real and the test matrix single.
4. **Supersede ADR-0013 wholesale.** Rejected — the amendment is narrow: alt-2's rejection flips for the *server-hosted shape*. Tiers, file interchange, and the surviving invariants are untouched.

## Open questions (deferred to follow-on efforts)

- Offline-capable hosted mode / cross-mode sync (would reopen conflict resolution for real).
- SSE/WebSocket live progress; job-list pagination.
- Global content-addressed audio store + Range streaming (replaces per-book audio endpoint).
- Remote-server mode for the standalone PWA (CORS + token in settings).
- Multi-user.
