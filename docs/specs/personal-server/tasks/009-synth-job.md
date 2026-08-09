# Task 009: Synth job runner + `POST /api/books/:id/synth` (202) + `GET /api/jobs(:id)`

**Description:** The Tier-3 payoff slice: trigger synthesis, return a job id immediately, run the synth in the background, poll for status. `POST /api/books/:id/synth` validates the stored book is text-only (`worker::stamp::refuse_full_input`), creates a `queued` job row, returns `202 {jobId}`, and spawns a tokio task that: loads the bundle, resolves the voice (`worker::voices`, cache/prefetch/download), runs `worker::synth_job` via `spawn_blocking`, stamps the manifest (`worker::stamp`, `generator.app = "taletrek-server"`), writes the bundle back through `store`, and updates the job row through the lifecycle. `GET /api/jobs/:id` and `GET /api/jobs` let the client poll. Unit tests use a stub `PiperRunner` (via `WavPassthrough`) — no real piper/ffmpeg in CI; the real path is the T12 runbook.

**Acceptance criteria:**
- [ ] `server/src/synth.rs` exposes `pub async fn run_synth_job(ctx, book_id, voice_id, voice_path, jobs) -> Result<job_id, SynthTriggerError>`:
  - Loads the bundle bytes via `store::get_bundle`, parses with `read_book_bundle`.
  - Refuses an already-full bundle (`worker::stamp::refuse_full_input`) → `409`-style error pointing at `resynth`.
  - Creates a `jobs` row (`kind=synth`, `status=queued`, `total` = paragraph count across chapters).
  - `tokio::spawn`s the background work (returns the `job_id` immediately).
  - Background body (all blocking work in `spawn_blocking`, or a `std::thread` for the rayon pool): resolve voice → set `status=running` (+ voice) → run `worker::stamp::synth_and_stamp(bundle, voice_id, voice_model, || SubprocessPiperRunner::new(piper), &OpusEncoder::new().with_binary(ffmpeg), jobs, "taletrek-server", Some(&sink))` → on success `store::put_bundle` the full bundle + `Db::upsert_book` (audio_present=true) + `status=succeeded`; on err `status=failed` with the error string + the paragraph index in the `error` column.
  - The `ProgressSink` impl updates the job row's `done`/`total` on each `synth_step` (and is a no-op or bytes-counter on `download_step`). Hold a `Db` handle + `job_id` inside it; wrap updates in `spawn_blocking`. (Acceptable for v1 — poll-based, no live streaming.)
- [ ] `server/src/http/jobs.rs`:
  - `POST /api/books/:id/synth` — body `{voice?, voicePath?, jobs?}` → `202 {jobId}` (camelCase). Missing book → `404`; already-full → `409`.
  - `GET /api/jobs/:id` → `200 {id, bookId, kind, voice, status, done, total, error?, createdAt, updatedAt}` or `404`.
  - `GET /api/jobs` → `200` array of recent jobs (`Db::list_recent_jobs`, capped).
  - All three authed (inherit T7's layer).
- [ ] `SynthTriggerError` maps to HTTP statuses (`BookNotFound→404`, `AlreadyFull→409`, `BadVoice→400`, internal→`500`).
- [ ] The runner reads `Settings.piper`/`ffmpeg`/`voices_cache_dir`/`jobs` so the synth uses the configured binaries.

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green (stub the Piper runner — the worker's `synth_job` already accepts a `make_runner` closure; inject `|| StubRunner` + `WavPassthrough` so tests need no piper/ffmpeg):
  - [ ] Upload text-only fixture → `POST synth` → `202 {jobId}` → poll `GET /api/jobs/:id` until `status=succeeded` (tokio test runtime + a short timeout) → `done==total`, no error.
  - [ ] After success, `GET .../books/:id` shows `audioPresent=true`; `GET .../bundle` returns a bundle `read_book_bundle` parses with `audio.present==true` and `generator.app=="taletrek-server"`.
  - [ ] `POST synth` on an already-full book → `409`.
  - [ ] `POST synth` on an unknown book → `404`.
  - [ ] A synth that errors (e.g. a paragraph that normalizes empty) records `status=failed` + a non-empty `error` + the paragraph index; the book's stored bundle is unchanged.
  - [ ] Job row's `done` advances during a multi-paragraph synth (assert `total>0` and final `done==total`).
- [ ] Manual stubbed: same flow via curl against a running server with the stub wired in (if a test-only `--stub-synth` flag is cheap, add it; otherwise rely on the integration test + the T12 real runbook).

**Dependencies:** T1–T3 (`worker::{voices, synth_job, stamp}`), T5 (`Db` jobs queries), T6 (`store::get_bundle/put_bundle`), T7 (auth + router), T8 (`AppState` stable).

**Files likely touched:**
- `server/src/synth.rs` (new — `run_synth_job` + the `ProgressSink` impl + `SynthTriggerError`)
- `server/src/http/jobs.rs` (new — synth trigger + job polling handlers)
- `server/src/http/mod.rs` (route the jobs handlers)
- `server/src/http/books.rs` (no change, or a thin `audio_present` reflect after synth via `upsert_book` — covered by synth.rs)
- `server/src/main.rs` (wire the synth runner into `AppState` — voice cache dir, piper/ffmpeg paths from `Settings`)

**Docs:** `/** GOTCHA */` on the two blocking seams: (1) rayon pool runs sync → it must be inside `spawn_blocking` (or a dedicated std thread), never awaited on the async runtime directly; (2) every `Db` write from the `ProgressSink` is also blocking → `spawn_blocking` per update, or batch. Note the v1 per-paragraph update cadence and that SSE/throttling is a follow-on.

**Estimated scope:** Large (the effort's hardest task — async/sync bridge + job lifecycle + ProgressSink + error mapping). If it resists landing in one go, split: (a) `synth.rs` runner + `Db` lifecycle with a direct unit test, then (b) the HTTP handlers + status mapping. Keep the slice's acceptance as the gate either way.
