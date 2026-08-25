# TODO — Effort 5: Server-hosted SPA

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · ADR-0014 (Task 1).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 0 — Decision record
- [x] T1: ADR-0014 — dual-shape SPA amends ADR-0013 alt-2 (`tasks/001-adr-0014-dual-shape.md`)

## Phase 1 — SPA datasource seam (pure refactor)
- [x] T2: `datasource/types.ts` — `LibraryDatasource` + `SynthPipeline` interfaces (`tasks/002-datasource-types.md`)
- [x] T3: `datasource/local.ts` — local wrappers + parity tests (`tasks/003-datasource-local.md`)
- [x] T4: Migrate reader-path callers (`tasks/004-migrate-reader-callers.md`)
- [ ] T5: Migrate library-path callers (`tasks/005-migrate-library-callers.md`)
- [ ] T6: Finish migration + no-direct-import grep gate (`tasks/006-migrate-finish-gate.md`)

### Checkpoint: Refactor fence — `pnpm verify` green, standalone PWA identical, UI off `lib/db` (allowlist: settings, secureKeyring).

## Phase 2 — Server hosts SPA + completes API
- [ ] T7: `GET /api/session` (`tasks/007-api-session.md`)
- [ ] T8: Static SPA serving + CSP + panel → `/ui/admin` interim (`tasks/008-static-spa-hosting.md`)
- [ ] T9: Chapters — lazy SQLite explode + endpoint (`tasks/009-api-chapters.md`)
- [ ] T10: Audio-by-content-key endpoint (`tasks/010-api-audio-by-key.md`)
- [ ] T11: Progress PATCH + position column (`tasks/011-api-progress.md`)
- [ ] T12: Dev workflow — Vite proxy + `just dev` (`tasks/012-dev-proxy.md`)

### Checkpoint: SPA hosted, API complete — curl round-trip on new endpoints; served SPA in local mode.

## Phase 3 — `ServerDatasource` + hosted UX
- [ ] T13: `resolve.ts` boot probe + `server.ts` library ops (`tasks/013-server-datasource.md`)
- [ ] T14: Remote synth pipeline (`tasks/014-remote-synth-pipeline.md`)
- [ ] T15: Remote playback (`tasks/015-remote-playback.md`)
- [ ] T16: Hosted parity + delete askama panel (`tasks/016-hosted-parity-delete-panel.md`)
- [ ] T17: SW `/api` network-only + affordances audit (`tasks/017-sw-scoping.md`)

### Checkpoint: End-to-end hosted flow — login → upload → server synth (tab closed) → reopen → play. Safari/Opus check (R2).

## Phase 4 — Deploy + ship
- [ ] T18: Dockerfile builds SPA + docker e2e (`tasks/018-docker-builds-spa.md`)
- [ ] T19: Deploy guide + runbook + CHANGELOG + final gates (`tasks/019-deploy-guide-ship.md`)

### Final gates (run @ T19, branch `server-hosted-spa`)
- [ ] `cargo build` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` green
- [ ] `pnpm verify` green
- [ ] `docker build -f server/Dockerfile .` succeeds; `docker run` → login → hosted SPA → full walkthrough
- [ ] Manual runbook walkthrough recorded below (real piper + ffmpeg)
- [ ] `spec.md` `status:` flips `draft → active` on /build checkpoint; `shipped` on merge

## Follow-on (NOT this effort)
- [ ] Offline-capable hosted mode / cross-mode sync
- [ ] SSE/WebSocket live progress; job-list pagination
- [ ] Cross-book content-addressed audio store + Range streaming
- [ ] Remote-server mode for the standalone PWA (CORS + token in settings)
- [ ] Worker-mode desktop queue; server-side raw-file parsing; multi-user
