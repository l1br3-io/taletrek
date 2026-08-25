# Plan — Effort 5: Server-hosted SPA

> Spec: [`spec.md`](./spec.md). Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md), amended by **ADR-0014** (Task 1). Format: [`../../bundle-format.md`](../../bundle-format.md) (frozen v1 — this effort expects **zero** format changes).
> Prior efforts (all ✅ shipped): [1 portable-bundle-format](../portable-bundle-format/spec.md) · [2 desktop-synth-app](../desktop-synth-app/spec.md) · [3 spa-bundle-import-export](../spa-bundle-import-export/spec.md) · [4 personal-server](../personal-server/spec.md).
> This plan is a thin index. Per-task acceptance, files, and verification live in `tasks/00N-*.md`.

## Overview

Make the personal server **host the real SPA**: one `web/` build, two deployment shapes — the unchanged offline-first PWA (local IndexedDB) and a server-served, same-origin client backed by the server's SQLite/library/synth (Jellyfin model, DigitalOcean-deployable). The SPA gains a datasource facade (`LibraryDatasource` + `SynthPipeline` interfaces) introduced as a pure refactor first (existing suite is the fence), the server gains static hosting + four endpoints (`/api/session`, chapters, audio-by-key, progress), then a `ServerDatasource` wires the two together. Upload stays browser-parsed (workers) → in-memory text-only bundle → `POST /api/books` → server synth → poll; playback fetches OGG/Opus by content key. The askama operator panel is deleted once the hosted SPA reaches parity.

## Architecture decisions

- **Facade boundary: UI ↔ datasource; lib internals are the local implementation.** Only routes/hooks/players/context stop importing `lib/db` directly. `ingest.ts`, `upload/manager.ts`, `transform/manager.ts`, `bundle/*`, `audio-cache.ts` etc. become the body of `LocalDatasource`/`LocalSynthPipeline` and keep direct db access — they are behind the seam. `context/settings.tsx` + `secureKeyring` **stay on IDB in both modes** (locked in spec: client-side keys, local settings).
- **Pure refactor before any server behavior.** Phase 1 introduces interfaces + `LocalDatasource` and migrates callers with zero behavior change; `pnpm verify` (existing suite, no new fences) is the gate. `resolve.ts` deliberately lands in Phase 3 — so after Phase 2 the server-served SPA still runs in local mode and everything works at every intermediate commit.
- **Server mode is resolved at boot, same-origin only.** `GET /api/session` probe: authed 200 → server mode; 401 → redirect `/ui/login`; unreachable/404 → local mode. Cookie auth (already implemented) — no CORS, no remote-URL settings field in v1.
- **Interim home for the askama panel.** The SPA takes `/` in Phase 2; the panel moves under `/ui/admin/*` (still cookie-gated, no-JS) and is **deleted** in Phase 3 parity. `/ui/login` stays permanently as the pre-SPA cookie gate.
- **Chapters: lazy explode into SQLite.** First `GET /api/books/:id/chapters` for a book explodes its `text.json` into per-chapter rows (paragraphs as JSON array — matches the SPA `Chapter` shape) and caches; re-explode on `updated_at` mismatch. Self-healing for effort-4-era libraries; no boot sweep over every stored bundle.
- **`/api/session` stays minimal:** `{ ok: true }` authed, `401` otherwise. No capabilities envelope in v1 (voices already live at `GET /api/voices`).
- **Audio served from the stored bundle, per-book v1:** `GET /api/books/:id/audio/:contentKey` → zip central-directory lookup → buffered `audio/ogg` (paragraphs are tens of KB). No Range, no cross-book store (follow-up). Content keys are already identical on both sides by construction.
- **Progress is last-write-wins:** `books.position` JSON column + `updated_at`; `PATCH /api/books/:id/progress`. No cross-mode sync.
- **Transform-after-synth = re-POST + resynth** (spec's accepted tradeoff): client-side AI transform re-POSTs a fresh text-only bundle (same book id → idempotent upsert) then triggers resynth.
- **Dev workflow:** Vite proxies `/api` → `127.0.0.1:7878` (`just dev` runs both). The dev Service Worker stays network-only for `/api` (G3).

## Dependency graph + task order

```
Phase 1 — SPA datasource seam (pure refactor; suite = fence)
  T2 types.ts ─► T3 local.ts ─► T4 reader callers ─► T5 library callers ─► T6 finish + grep gate

Phase 2 — server hosts SPA + completes API (Rust side; parallelizable with Phase 1*)
  T7 /api/session ─► T12 dev proxy + just dev
  T8 static SPA serving + CSP + panel→/ui/admin      (independent of T7)
  T9 chapters (lazy explode) / T10 audio-by-key / T11 progress   (independent of T7–T8)

Phase 3 — wiring
  T13 resolve.ts + server.ts datasource ◄── needs T2/T3 + T7 + T9/T10/T11
      └─► T14 remote synth pipeline ─►┐
      └─► T15 remote playback ────────┴─► T16 hosted parity + delete panel ─► T17 SW + affordances audit

Phase 4 — deploy + ship
  T18 Dockerfile (builds SPA) ─► T19 deploy guide + runbook + CHANGELOG
```

*T7–T11 touch only `server/` and could run in parallel with Phase 1 in a second session; T12 needs T7; T13 is the join point. On one session, strict order below.

## Task index

### Phase 0 — Decision record
- [ ] Task 1: ADR-0014 — dual-shape SPA amends ADR-0013 alt-2 → `tasks/001-adr-0014-dual-shape.md`

### Phase 1 — SPA datasource seam (pure refactor)
- [ ] Task 2: `datasource/types.ts` — `LibraryDatasource` + `SynthPipeline` interfaces from the call-site inventory → `tasks/002-datasource-types.md`
- [ ] Task 3: `datasource/local.ts` — `LocalDatasource`/`LocalSynthPipeline` wrappers + parity tests → `tasks/003-datasource-local.md`
- [ ] Task 4: Migrate reader-path callers through the facade → `tasks/004-migrate-reader-callers.md`
- [ ] Task 5: Migrate library-path callers through the facade → `tasks/005-migrate-library-callers.md`
- [ ] Task 6: Finish migration — settings-route/misc callers + no-direct-import grep gate → `tasks/006-migrate-finish-gate.md`

### Checkpoint: Refactor fence
- [ ] `pnpm verify` green; standalone PWA behavior identical (no visible diff); UI no longer imports `lib/db` outside the allowlist (settings, secureKeyring).

### Phase 2 — Server hosts SPA + completes API
- [ ] Task 7: `GET /api/session` endpoint → `tasks/007-api-session.md`
- [ ] Task 8: Static SPA serving + JS-app CSP + askama panel → `/ui/admin` interim → `tasks/008-static-spa-hosting.md`
- [ ] Task 9: Chapters — lazy SQLite explode + `GET /api/books/:id/chapters` → `tasks/009-api-chapters.md`
- [ ] Task 10: `GET /api/books/:id/audio/:contentKey` (OGG/Opus from stored bundle) → `tasks/010-api-audio-by-key.md`
- [ ] Task 11: `PATCH /api/books/:id/progress` + `books.position` migration + BookDto field → `tasks/011-api-progress.md`
- [ ] Task 12: Dev workflow — Vite `/api` proxy + `just dev` composing both sides → `tasks/012-dev-proxy.md`

### Checkpoint: SPA hosted, API complete
- [ ] `cargo clippy` + `cargo test -p taletrek-server` green; `pnpm build` output served at `/` via `TALETREK_STATIC_DIR`; curl round-trip on all four new endpoints; served SPA runs in local mode (pre-Phase-3 state).

### Phase 3 — `ServerDatasource` + hosted UX
- [ ] Task 13: `datasource/resolve.ts` (boot probe + DatasourceProvider) + `datasource/server.ts` library ops → `tasks/013-server-datasource.md`
- [ ] Task 14: Remote synth pipeline — parse → in-memory text-only bundle → POST → synth → poll → processing display → `tasks/014-remote-synth-pipeline.md`
- [ ] Task 15: Remote playback — audio-by-key fetch feeding existing players → `tasks/015-remote-playback.md`
- [ ] Task 16: Hosted UX parity + **delete the askama panel** → `tasks/016-hosted-parity-delete-panel.md`
- [ ] Task 17: Service worker `/api` network-only + hosted-affordances audit → `tasks/017-sw-scoping.md`

### Checkpoint: End-to-end hosted flow
- [ ] Login → upload EPUB → browser parse → server synth → close tab mid-job → job completes → reopen → position + audio play. Safari/Opus spot-check (risk R2) done on real hardware or explicitly deferred with evidence.

### Phase 4 — Deploy + ship
- [ ] Task 18: Dockerfile builds the SPA (multi-stage pnpm → dist → image) + docker e2e → `tasks/018-docker-builds-spa.md`
- [ ] Task 19: DigitalOcean deploy guide + runbook walkthrough + CHANGELOG + final gates → `tasks/019-deploy-guide-ship.md`

### Checkpoint: Ready for review
- [ ] All `spec.md` §"Success criteria" checked or explicitly deferred; `status:` flips to `shipped` on the merge commit.

## Risks and mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| R1 — Phase-1 refactor breadth (`lib/db` imported at many UI sites, scattered writers) | High | Pure refactor behind facade; existing suite as fence; incremental landing T4→T5→T6; lib internals stay behind the seam (decision above) |
| R2 — Opus decode on Safari via `decodeAudioData`/`<audio>` | High | T15 verifies early on real Safari; T3 import path already exercises the same bytes — evidence exists (effort-4 runbook §4) |
| R3 — Dev SW caches `/api` responses (G3) | Medium | T17 scopes SW network-only for `/api`; interim dev uses hard-reload |
| R4 — CSP vs SPA runtime (workers, styles) | Medium | T8 sets `script-src 'self'`-based CSP and verifies the built app boots under it |
| R5 — Job-state recovery after hosted reload mid-synth | Medium | T14 recovers via `GET /api/jobs` (recent-50) matched client-side by book id |
| R6 — Large library explode cost on first chapters fetch | Low | Lazy per-book explode is one zip read + N rows; measured in T9 tests; acceptable for personal scale |

## Open questions

- None blocking. Spec open questions resolved here: session shape (minimal), chapter granularity (per-chapter rows, paragraphs as JSON, lazy explode).
