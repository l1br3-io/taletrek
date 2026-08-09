# TODO — Effort 4: Personal server

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 1 — Extract `crates/worker` (desktop's tests are the gate)
- [x] T1: Worker crate scaffold + `ProgressSink` trait + move `voices` (`tasks/001-worker-voices.md`)
- [x] T2: Move parallel synth engine into `crates/worker::synth_job` (`tasks/002-worker-synth-job.md`)
- [ ] T3: Move stamping + `refuse_full_input` into `crates/worker`, parameterize `generator.app` (`tasks/003-worker-stamp.md`)

### Checkpoint: Worker extraction green — desktop identical; `crates/synth` untouched.

## Phase 2 — Server foundations (bottom-up)
- [ ] T4: Server crate + `config.rs` + `main.rs` axum bind + `/api/health` (unauth) (`tasks/004-server-skeleton.md`)
- [ ] T5: `db.rs` — rusqlite + migrations (books/jobs) + `Db` trait seam + `spawn_blocking` (`tasks/005-db.md`)
- [ ] T6: `store.rs` — on-disk bundle layout + `.taletrek-lib` ingest (dedup by book id) (`tasks/006-store.md`)

### Checkpoint: Server boots + health; db + store unit-tested in isolation.

## Phase 3 — HTTP library API
- [ ] T7: Router + bearer-token auth middleware + `GET /api/books` + `GET /api/books/:id` (`tasks/007-http-router-auth.md`)
- [ ] T8: `POST /api/books` (multipart + ingest) + download + delete (`tasks/008-http-books-crud.md`)

### Checkpoint: Library loop via curl (auth-gated upload → list → download → delete).

## Phase 4 — Inline synth + resynth
- [ ] T9: Synth job runner + `POST /api/books/:id/synth` (202) + `GET /api/jobs(:id)` (`tasks/009-synth-job.md`)
- [ ] T10: `POST /api/books/:id/resynth` + voices endpoints (catalog + prefetch) (`tasks/010-resynth-voices.md`)

### Checkpoint: Synth loop closes (stubbed) — upload text-only → synth → poll succeeded → full bundle out; resynth re-keys.

## Phase 5 — UI + Docker + ship
- [ ] T11: Server-rendered HTML UI — askama (index, book, jobs) (`tasks/011-web-ui.md`)
- [ ] T12: Dockerfile (multi-stage, debian-slim, piper + ffmpeg) + runbook + final gates (`tasks/012-docker-runbook-gates.md`)

### Final gates (run @ T12, branch `personal-server`)
- [ ] `cargo build` (whole workspace) clean
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean
- [ ] `cargo test --workspace` green (incl. desktop refactor regression + `crates/synth` untouched)
- [ ] `pnpm verify` green (no `web/` changes)
- [ ] `docker build -f server/Dockerfile .` succeeds; `docker run` reaches `/api/health`
- [ ] Manual runbook walkthrough (real piper + ffmpeg + curated voice): upload text-only fixture → synth → poll → download → `manifest.audio.present == true`, Opus `OggS` → import into SPA via T3 → audio plays. Resynth round-trip too. _(Record date + commit here when run.)_

### Checkpoint: Ready for review
- [ ] All `spec.md` §"Success criteria" checked or explicitly deferred (runbook walkthrough = human-run, above).
- [ ] `spec.md` `status:` flips `draft → active` on /build checkpoint; flips to `shipped` on the merge commit.

## Follow-on (NOT this effort)
- [ ] Worker-mode job queue (desktop-as-worker connecting to the server) — phase 2 / new effort
- [ ] Cross-book content-addressed audio store (v1 dedups within a bundle only)
- [ ] Live progress streaming (SSE/WebSocket); continue-on-error / partial-resume synth
- [ ] Server-side AI-transform API-key handling (needs a follow-up ADR under ADR-0013, interacting with ADR-0007/0004)
