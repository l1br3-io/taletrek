# TODO — Effort 4: Personal server

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 1 — Extract `crates/worker` (desktop's tests are the gate)
- [x] T1: Worker crate scaffold + `ProgressSink` trait + move `voices` (`tasks/001-worker-voices.md`)
- [x] T2: Move parallel synth engine into `crates/worker::synth_job` (`tasks/002-worker-synth-job.md`)
- [x] T3: Move stamping + `refuse_full_input` into `crates/worker`, parameterize `generator.app` (`tasks/003-worker-stamp.md`)

### Checkpoint: Worker extraction green — desktop identical. (`crates/synth` stayed untouched through T1–T3; the later piper `--config` sibling-path fix `4725dd0` touched `crates/synth/src/synth.rs` — 18 lines, e2e-validated, no public-API change.)

## Phase 2 — Server foundations (bottom-up)
- [x] T4: Server crate + `config.rs` + `main.rs` axum bind + `/api/health` (unauth) (`tasks/004-server-skeleton.md`)
- [x] T5: `db.rs` — rusqlite + migrations (books/jobs) + `Db` trait seam + `spawn_blocking` (`tasks/005-db.md`)
- [x] T6: `store.rs` — on-disk bundle layout + `.taletrek-lib` ingest (dedup by book id) (`tasks/006-store.md`)

### Checkpoint: Server boots + health; db + store unit-tested in isolation.

## Phase 3 — HTTP library API
- [x] T7: Router + bearer-token auth middleware + `GET /api/books` + `GET /api/books/:id` (`tasks/007-http-router-auth.md`)
- [x] T8: `POST /api/books` (multipart + ingest) + download + delete (`tasks/008-http-books-crud.md`)

### Checkpoint: Library loop via curl (auth-gated upload → list → download → delete).

## Phase 4 — Inline synth + resynth
- [x] T9: Synth job runner + `POST /api/books/:id/synth` (202) + `GET /api/jobs(:id)` (`tasks/009-synth-job.md`)
- [x] T10: `POST /api/books/:id/resynth` + voices endpoints (catalog + prefetch) (`tasks/010-resynth-voices.md`)

### Checkpoint: Synth loop closes (stubbed) — upload text-only → synth → poll succeeded → full bundle out; resynth re-keys.

## Phase 5 — UI + Docker + ship
- [x] T11: Server-rendered HTML UI — askama (index, book, jobs) (`tasks/011-web-ui.md`)
- [x] T12: Dockerfile (multi-stage, debian-slim, piper + ffmpeg) + runbook + final gates (`tasks/012-docker-runbook-gates.md`)

### Final gates (run @ T12, branch `personal-server`)
- [x] `cargo build` (whole workspace) clean
- [x] `cargo clippy --workspace --all-targets -- -D warnings` clean
- [x] `cargo test --workspace` green (incl. desktop refactor regression)
- [x] `pnpm verify` green (`web/` changes this effort: `vite.config.ts` dev-port pin only)
- [x] `docker build -f server/Dockerfile .` succeeds; `docker run` reaches `/api/health`
- [x] Manual runbook walkthrough (real piper + ffmpeg + curated voice): upload text-only fixture → synth → poll → download → `manifest.audio.present == true`, Opus `OggS` → import into SPA via T3 → audio plays. Resynth round-trip too.
  - 2026-08-20 @ `70ec7d9`: §2 (a)–(f) + §3 (docker build/run → `/api/health` ok) + §5 (4 `#[ignore]`d e2e green: desktop + server × synth + resynth) all pass, re-verified after the piper `--config` fix (`4725dd0`). Machine gates re-run green: `just verify-rust` + `pnpm verify`.
  - 2026-08-20 @ `da0d7d1` (post-`/ship` review): hardening landed — empty-token boot guard, atomic bundle + voice-cache writes (temp+rename), boot orphan-job sweep, `jobs` clamp [1, 32], index error logging; `cargo clippy` + `cargo test --workspace` (197) green.
  - 2026-08-20 (post-`/ship` blockers): manifest-voice contract fixed — server synth now rewrites `book.voiceId` to the effective voice (format: importers key audio from the manifest voice; a `lessac`-manifest fixture synth'd under the default voice was unplayable-by-construction) + regression test. In-flight guard — second synth/resynth trigger and DELETE under a running job are `409`; a delete that races past the guard fails the job instead of resurrecting the book (both tested). Also landed: unique bundle temp names, login rate-limiting (10 fails / 15 min / IP → 429), security headers (CSP/nosniff/DENY/no-referrer), zip decompression caps in `crates/synth` (256 MiB/entry, 1 GiB/archive), piper tarball sha256 verification, `.onnx` download size sanity band, `413` + XSS-escaping pins, dev bind pinned to loopback in the justfile. `cargo clippy` + `cargo test --workspace` (211) green. Runbook §2(e) voiceId expectation updated — re-run §2 before the §4 SPA check.
  - 2026-08-24 (ship walkthrough): §2 (e)+(f) re-run live post-hardening — manifest-voice rewrite confirmed end-to-end (`lessac → hfc_female`, then ryan resynth). Found + fixed a real blocker: the worker's curated cache-miss download fetched the voice config as `<voice>.json` (404 on HF — it's hosted `<voice>.onnx.json`); masked until now because e2e gates seed the voice cache and the runbook resynth passed `voicePath` (`22508db`, regression test pins the URL shape). §4 SPA audio-plays check done browser-driven (both bundles import "with audio"; playback probes show real durations + auto-advance + "Finished", console clean; ryan/hfc bytes distinct) — human accepted the automated evidence. Effort ships.

### Checkpoint: Ready for review
- [x] All `spec.md` §"Success criteria" checked or explicitly deferred (runbook walkthrough = human-run, above).
- [x] `spec.md` `status:` flips `draft → active` on /build checkpoint; flips to `shipped` on the merge commit. *(shipped 2026-08-24)*

## Follow-on (NOT this effort)
- [ ] Worker-mode job queue (desktop-as-worker connecting to the server) — phase 2 / new effort
- [ ] Cross-book content-addressed audio store (v1 dedups within a bundle only)
- [ ] Live progress streaming (SSE/WebSocket); continue-on-error / partial-resume synth
- [ ] Server-side AI-transform API-key handling (needs a follow-up ADR under ADR-0013, interacting with ADR-0007/0004)
