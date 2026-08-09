# Task 010: `POST /api/books/:id/resynth` + voices endpoints (catalog + prefetch)

**Description:** Two small follow-on endpoints that round out the synth surface. `resynth` re-voices a full (or text-only) book — it reuses the T9 runner with the manifest's `book.voiceId` rewritten first (`worker::stamp::resynth_and_stamp`), so the whole book is re-keyed under the new voice. The voices endpoints expose the curated catalog (read-only, from `worker::voices`) and let a client pre-download a voice model so the first synth isn't slow.

**Acceptance criteria:**
- [ ] `server/src/http/jobs.rs` (or a sibling `resynth` handler) adds `POST /api/books/:id/resynth`:
  - Body `{voice, voicePath?, jobs?}` (`voice` required — the whole point is a voice swap).
  - Creates a `jobs` row `kind=resynth`, returns `202 {jobId}`.
  - Background runner (mirror T9's): load bundle → **rewrite `manifest.book.voice_id` to the new voice before synth** → `worker::stamp::resynth_and_stamp(..., generator_app="taletrek-server", ...)` → `store::put_bundle` + `Db::upsert_book` (voice_id + audio_present reflect the new voice) → job `succeeded`/`failed`.
  - Accepts both text-only and full input (no `refuse_full_input` guard — that's synth-only). Unknown book → `404`; missing `voice` → `400`.
  - Shares the T9 `ProgressSink` + `spawn_blocking` plumbing (factor it out so resynth isn't a copy-paste).
- [ ] `server/src/http/voices.rs`:
  - `GET /api/voices` → `200` JSON array of the curated catalog (`worker::voices::CURATED_VOICES`): `{id, name, quality, sizeBytes, language}` (camelCase). No auth-free shortcut — inherits the auth layer like other `/api` routes.
  - `POST /api/voices/:id/fetch` → resolves the voice (`worker::voices::resolve_voice(Some(id), opts, &UreqVoiceSource, None)`) which downloads + caches it, then `204` (or `200 {id, cached:true}`). Unknown curated id → `404` (`ResolveError::UnknownCuratedId`). This is the prefetch the web UI's "synth" button can call ahead of triggering.
- [ ] `server/src/http/mod.rs` routes the new endpoints; they inherit T7's auth layer.

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green:
  - [ ] `resynth`: synth a text-only fixture under voice A (stubbed, T9 path) → `POST resynth` voice B → poll to `succeeded` → the stored bundle's `manifest.book.voiceId == B`, and every audio segment is keyed under B (assert via `read_book_bundle` + `cache_key(B, text)`). `audio_present` stays true.
  - [ ] `resynth` accepts a text-only book too (no full-input guard) — produces a full bundle under the new voice.
  - [ ] `GET /api/voices` returns all 8 curated entries with the right shape; parity with `worker::voices::CURATED_VOICES`.
  - [ ] `POST /api/voices/:id/fetch` for an unknown id → `404`; for a known id with a stubbed `VoiceSource` cache-hit → `204` without network (inject the stub, or seed the cache dir).
  - [ ] Auth still enforced on both voices routes.
- [ ] Manual curl: `resynth` round-trip; `GET /api/voices` shows the catalog.

**Dependencies:** T1 (`worker::voices`), T3 (`worker::stamp::resynth_and_stamp`), T9 (the runner + `ProgressSink` + `spawn_blocking` plumbing to reuse).

**Files likely touched:**
- `server/src/synth.rs` (add `run_resynth_job` reusing T9 plumbing — extract a shared `run_job` inner if it cleans up)
- `server/src/http/jobs.rs` (or `resynth` handler — add `POST .../resynth`)
- `server/src/http/voices.rs` (new — catalog + prefetch)
- `server/src/http/mod.rs` (route voices + resynth)

**Docs:** Note in the resynth handler that **all old-voice audio is discarded** (worker replaces, not merges) — matches desktop `resynth`. Cross-reference the desktop behavior so the two hosts stay consistent.

**Estimated scope:** Medium (resynth reuses T9 machinery; the two voices handlers are thin). The refactor of T9's runner into a shared inner is the non-obvious part — do it as part of this task since it pays down T9's copy-paste debt.
