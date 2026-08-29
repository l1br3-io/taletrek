---
status: active        # draft → active → shipped
started: 2026-08-25
---

# SPEC — Off-device synth track · Effort 5: Server-hosted SPA

> Track ADR: [`docs/adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
> Will be amended by **ADR-0014** (Phase 0 of this effort).
> Prior efforts (all ✅ shipped): 1. [`portable-bundle-format`](../portable-bundle-format/spec.md) · 2. [`desktop-synth-app`](../desktop-synth-app/spec.md) · 3. [`spa-bundle-import-export`](../spa-bundle-import-export/spec.md) · 4. [`personal-server`](../personal-server/spec.md).
> Tiers: (1) SPA alone ✓ · (2) SPA + Desktop ✓ · (3) + Server ✓ (bundle exchange) — **this effort makes the SPA a live client of the server (Tier 3 completion).**

## Problem

Effort 4 delivered the server: library storage, inline Piper synth, jobs, auth. But the server's UI is a no-JS askama operator panel, and the SPA reaches it only through manual bundle export/upload/download/import. Two apps with the same job. The user's intent: **one app, two deployment shapes** — the existing SPA, hosted by the personal server, backed by server-side persistence and native processing. Deploy to DigitalOcean, open the browser, get the full TaleTrek UX with none of the phone-side synth pain.

## Objective (users + success)

- **User:** the self-hoster (Jellyfin model) deploying to a VPS/Droplet, *and* the existing offline-first PWA user. Same codebase serves both.
- **Success looks like:** `docker run` → login → the real SPA loads from the server origin → upload an EPUB → browser parses → server synths (close the tab; it keeps going) → reopen → read with streamed audio. **And:** the standalone PWA build behaves identically to today — existing test suite green, zero behavior change.

## Scope (this effort only)

1. **SPA datasource seam (pure refactor):** introduce `LibraryDatasource` + `SynthPipeline` interfaces under `web/src/lib/datasource/`; `LocalDatasource` wraps the existing `lib/db` + `uploadManager`. All UI callers route through the facade. No behavior change; existing tests are the fence.
2. **Runtime mode resolution:** boot probe of same-origin `GET /api/session`. Authed 200 → server mode; anything else → local mode. Standalone PWA untouched.
3. **Server hosts the SPA:** serve `web/dist` at `/` (SPA fallback, configurable static dir, Docker multi-stage build). Tighten CSP for a JS app. **Delete the askama operator panel** once the hosted SPA covers upload/synth/jobs/voices. Keep the `/ui/login` cookie gate (no-JS, pre-SPA).
4. **Server API completion:** `GET /api/books/{id}/chapters` (explode `text.json` into SQLite at ingest), `GET /api/books/{id}/audio/{contentKey}` (per-book v1, from the stored bundle), `PATCH /api/books/{id}/progress` (last-write-wins), `GET /api/session`.
5. **ServerDatasource + hosted UX:** upload = browser parse workers → in-memory text-only bundle (existing `lib/bundle/writer`) → `POST /api/books` → `POST .../synth` → poll `GET /api/jobs/{id}` into the existing processing display. Playback fetches audio by content key and feeds the existing players (the T3 import path already proves opus-blob playback works). Voice picker lists `GET /api/voices`. Library/job/delete actions hit the JSON API.
6. **Deploy story:** multi-stage Dockerfile (pnpm → dist → server image), DigitalOcean one-command guide.

## Decisions (locked — from the specify phase)

| Area | Decision |
| --- | --- |
| Architecture | **One SPA build, two shapes.** Runtime datasource selection; no env-specific build. Standalone = local IDB (unchanged); hosted = same-origin HTTP. |
| Hosting | **Same-origin only in v1.** No "remote server URL" settings field, no CORS. The server serves the SPA. |
| Mode detection | Boot probe `GET /api/session`; authed → server mode; 401 → redirect `/ui/login`; unreachable → local mode. |
| Auth | **Unchanged:** single token, cookie (browser) or bearer (API). Single-user per instance. |
| Parsing | **Browser-side** (ADR-0013 invariant). Hosted upload = parse in workers → in-memory text-only bundle → POST. No Rust parsers. |
| Synth | **Server-side only in hosted mode.** On-device Piper + whole-book mobile encode + voice OPFS downloads do not run when hosted. The standalone path keeps them all. |
| Offline (hosted) | **Online-only.** Service worker stays network-only for `/api`; offline remains the standalone PWA's job. No cache/reconciliation layer. |
| AI transform | **Client-side, unchanged** (keys in local secure keyring per ADR-0007). Transform-then-synth: transform before first POST. Re-transform after synth = re-POST text-only bundle (idempotent upsert, same book id) + resynth. No server-held keys. |
| Audio API | `GET /api/books/{id}/audio/{contentKey}` from the stored bundle, per-book v1. Global content-addressed audio store = follow-up. |
| Progress | `PATCH /api/books/{id}/progress`, last-write-wins on `updatedAt`. No cross-mode sync. |
| Jobs | Polling (existing). SSE/WS = follow-up. |
| Migration | **None.** New app; no existing data to migrate. |
| Operator UI | **Deleted** when hosted SPA reaches parity. `/ui/login` form stays as the no-JS cookie gate. |
| Static serving | Static dir (default `./web-dist`, env-overridable) via tower-http + SPA fallback; Docker builds `web/dist` and copies. No rust-embed. |
| ADR | **ADR-0014** amends ADR-0013 alt-2: a live SPA↔server connection exists *for the server-hosted shape*; file-based bundles remain the interchange for desktop/Tier-2. |

## Architecture

```
web/src/lib/datasource/
  types.ts        # LibraryDatasource + SynthPipeline interfaces
  local.ts        # wraps lib/db + uploadManager (behavior-identical)
  server.ts       # HTTP impl (cookie auth, same-origin)
  resolve.ts      # boot probe → mode selection
server/src/http/
  session.rs      # GET /api/session
  chapters.rs     # GET /api/books/{id}/chapters (+ ingest explode, SQLite migration)
  audio.rs        # GET /api/books/{id}/audio/{key}
  spa.rs          # static dist serving + fallback (replaces askama UI routes)
web/vite.config.ts  # dev proxy: /api → 127.0.0.1:7878
```

## Commands

```
pnpm verify                              # lint + typecheck + test + build (the refactor fence)
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
docker build -f server/Dockerfile -t taletrek-server .   # now builds SPA too
# dev, both sides live: pnpm dev (:8253, proxies /api) + just dev-server (:7878)
```

## Project structure conventions

Per AGENTS.md layout; new code lives only in `web/src/lib/datasource/` and `server/src/http/`. Tests co-located (`*.test.ts(x)` / `server/src/http/*_tests.rs` following existing patterns).

## Code style

Strict TS, interfaces-before-impl, branded IDs, variant async states, container/presentational split — unchanged (see AGENTS.md). The datasource facade is the textbook seam: UI depends on `LibraryDatasource`, never on `lib/db` or fetch.

## Testing strategy

- **Phase-1 fence:** entire existing vitest suite stays green through the refactor; `LocalDatasource` gains parity tests where coverage is thin.
- **ServerDatasource:** vitest with mocked `fetch` (transport, auth, error variants).
- **Server endpoints:** in-process axum tests (existing `server` test patterns); SQLite migration test for chapter explode; audio-by-key reads from a fixture bundle.
- **Human gate:** runbook walkthrough on `docker run` — login, upload, synth-with-tab-closed, reopen + play. Safari/`decodeAudioData` opus check early (risk R2).

## Boundaries

- **Always:** standalone PWA behavior unchanged (suite green, no visible diff); run `pnpm verify` + cargo gates before commits.
- **Ask first:** bundle-format changes (expected: none), auth changes, new deps, CSP relaxation.
- **Never:** multi-user/accounts, server-held LLM keys, removing on-device Piper, CORS-open remote mode, breaking ADR-0013 invariants without a new ADR.

## Non-goals (this effort)

Offline hosted mode, cross-mode sync, SSE/WS, migration tooling, server-side raw-file parsing, worker-mode desktop queue (still follow-up), community library, multi-user.

## Risks

- **R1 — Phase-1 refactor breadth:** `lib/db` imported concretely at ~11+ sites with scattered writers. Mitigation: pure refactor behind the barrel, existing tests as the fence, incremental landing.
- **R2 — Opus decode on Safari:** hosted playback relies on `decodeAudioData`/`<audio>` handling the bundle's opus files. T3 import already exercises this — verify on real Safari before Phase 3 UI work.
- **R3 — SW interference:** dev-SW caching (G3) vs `/api`. Network-only for `/api`.
- **R4 — CSP vs SPA runtime:** workers/wasm/styles all `'self'`; no wasm needed hosted.

## Success criteria (testable)

1. `docker run -p 7878:7878 -e TALETREK_TOKEN=… taletrek-server` → login → SPA served same-origin; askama panel gone.
2. Hosted: upload EPUB → parses in browser → text-only bundle POSTs → job 202 → progress polls → plays; tab closed mid-synth, job completes.
3. Hosted: reading position persists (PATCH round-trip); delete works.
4. Standalone: `pnpm verify` green, PWA identical behavior, on-device synth intact.
5. DigitalOcean deploy guide merged; runbook walkthrough recorded in todo.md.

## Open questions (resolved at plan time — see plan.md §Architecture decisions)

- ~~Session capabilities envelope~~ → **minimal `{ ok: true }`**; voices stay at `GET /api/voices`.
- ~~Chapter explode granularity~~ → **per-chapter rows, paragraphs as JSON array** (matches SPA `Chapter`), **lazily** exploded into SQLite on first request.
