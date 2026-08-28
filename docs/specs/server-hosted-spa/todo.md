# TODO — Effort 5: Server-hosted SPA

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · ADR-0014 (Task 1).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 0 — Decision record
- [x] T1: ADR-0014 — dual-shape SPA amends ADR-0013 alt-2 (`tasks/001-adr-0014-dual-shape.md`)

## Phase 1 — SPA datasource seam (pure refactor)
- [x] T2: `datasource/types.ts` — `LibraryDatasource` + `SynthPipeline` interfaces (`tasks/002-datasource-types.md`)
- [x] T3: `datasource/local.ts` — local wrappers + parity tests (`tasks/003-datasource-local.md`)
- [x] T4: Migrate reader-path callers (`tasks/004-migrate-reader-callers.md`)
- [x] T5: Migrate library-path callers (`tasks/005-migrate-library-callers.md`)
- [x] T6: Finish migration + no-direct-import grep gate (`tasks/006-migrate-finish-gate.md`)

### Checkpoint: Refactor fence — `pnpm verify` green, standalone PWA identical, UI off `lib/db` (allowlist: settings, secureKeyring).

## Phase 2 — Server hosts SPA + completes API
- [x] T7: `GET /api/session` (`tasks/007-api-session.md`)
- [x] T8: Static SPA serving + CSP + panel → `/ui/admin` interim (`tasks/008-static-spa-hosting.md`)
- [x] T9: Chapters — lazy SQLite explode + endpoint (`tasks/009-api-chapters.md`)
- [x] T10: Audio-by-content-key endpoint (`tasks/010-api-audio-by-key.md`)
- [x] T11: Progress PATCH + position column (`tasks/011-api-progress.md`)
- [x] T12: Dev workflow — Vite proxy + `just dev` (`tasks/012-dev-proxy.md`)

### Checkpoint: SPA hosted, API complete — curl round-trip on new endpoints; served SPA in local mode.

## Phase 3 — `ServerDatasource` + hosted UX
- [x] T13: `resolve.ts` boot probe + `server.ts` library ops (`tasks/013-server-datasource.md`)
- [x] T14: Remote synth pipeline (`tasks/014-remote-synth-pipeline.md`)
- [ ] T15: Remote playback (`tasks/015-remote-playback.md`)
- [ ] T16: Hosted parity + delete askama panel (`tasks/016-hosted-parity-delete-panel.md`)
- [ ] T17: SW `/api` network-only + affordances audit (`tasks/017-sw-scoping.md`)

### Checkpoint: End-to-end hosted flow — login → upload → server synth (tab closed) → reopen → play. Safari/Opus check (R2).

> T13 verification notes (2026-08-28): `just dev` with a seeded server — probe 200 → `datasource mode: server`; 401 (no cookie) → `/ui/login` redirect, post-login cookie lands back on `/` in server mode; library lists the server book; reader loads chapters (lazy explode) + position PATCH round-trips (`position.progressFraction` piggybacks on the verbatim T11 body). Standalone check: `pnpm dev` with no server → proxy 502 → `datasource mode: local`, PWA boots identically. Hosted Play currently refuses with "On-device playback synthesis is not available while hosted by the server." (`serverPlaybackEngine` holds the T15 engine slot — no Piper/wasm downloads hosted). Audio probing decided per task: single `GET /api/books/:id` → `audioPresent && voiceId` match marks every non-empty paragraph (whole-book synth, bundle rewritten atomically at completion).

> T14 verification notes (2026-08-28, real piper — `TALETREK_PIPER` seeded voice, served `web/dist` behind login, Chrome-driven): upload EPUB in hosted mode → browser parse → `POST /api/books` 201 → `POST …/synth` 202 → banner ticks `2/21 → …` → "'Caravan Nights' is ready." Failure path exercised for real (server started without `TALETREK_PIPER` → job `failed` → error banner carried the server's message; Retry after fixing env re-ran to green). R5 reload mid-job: 192-¶ book reloaded at 2/192 → boot recovery re-adopted, banner resumed `40/192`. Headline demo: closed the tab at ~40/192 → server ran to `succeeded 192/192` (curl-verified) → reopened → library shows the book ready (no banner), `audioPresent: true`. Design notes: `ingestBook` POSTs the text-only bundle at upload time (so `synthesizeOnUpload: off` + reader + library work without `startJob`); `startJob` never re-POSTs (probes dto → synth-or-resynth; 409 adopts the in-flight job); `cancel()` = stop polling only, job runs on (doc'd on the method); hosted transform runs client-side then re-POSTs + resynths under the book's current voice (probed pre-re-POST — the re-POST resets `audioPresent`). Known follow-ups for T16/T17: banner copy "Keep this tab open…" is wrong hosted (nothing pauses), and the Google-Fonts CSP console error is the known G29.

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
