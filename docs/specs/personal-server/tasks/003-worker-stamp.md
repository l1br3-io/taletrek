# Task 003: Move stamping + `refuse_full_input` into `crates/worker` (parameterize `generator.app`)

**Description:** Complete the worker extraction by moving the manifest-stamping core out of `desktop/src/bundle_io.rs` into `crates/worker::stamp`, **parameterized by `generator.app`** so both hosts stamp correct provenance (`"taletrek-desktop"` / `"taletrek-server"`) through one code path. `refuse_full_input` (the "synth refuses an already-full bundle" guard) is also host-shared, so it moves too. The desktop's `bundle_io.rs` thins to its CLI-only residue (output-path naming, `write_book_bundle_file`, and thin wrappers that fix `generator.app = "taletrek-desktop"`). Desktop behavior identical; its tests (unit + `#[ignore]`d e2e) are the gate.

**Acceptance criteria:**
- [ ] `crates/worker/src/stamp.rs` exports:
  - `pub fn synth_and_stamp<R, E, F>(bundle, voice_id, voice_model, make_runner, encoder, jobs, generator_app: &str, progress: Option<&dyn ProgressSink>) -> Result<(), StampError>` — runs `synth_all_paragraphs`, replaces the audio map, and stamps the manifest (audio.present=true, encoder codec, `NORM_VERSION`, dedup'd segment count, `generator = { generator_app, CARGO_PKG_VERSION }`, preserve `book.voice_id`).
  - `pub fn resynth_and_stamp<...>(bundle, new_voice_id, voice_model, ..., generator_app: &str, progress)` — rewrites `book.voice_id` first, then delegates to `synth_and_stamp` (replaces, not merges, audio).
  - `pub fn refuse_full_input(bundle: &BookBundle, label: &str) -> Result<(), FullInputError>` — same guard; `label` is a caller-supplied display string (desktop passes the input path; server passes the book id) so the error message stays useful in both hosts.
  - A `StampError` enum (`Synth(SynthJobError)`, `Bundle(BundleError)`) — note: file-write errors stay desktop-side (see below), so `StampError` has no `WriteFile` variant.
- [ ] `generator.app` is **never hardcoded** inside worker. The desktop wrapper passes `"taletrek-desktop"`; the server (later task) passes `"taletrek-server"`.
- [ ] `desktop/src/bundle_io.rs` keeps only: `pub const GENERATOR_APP: &str = "taletrek-desktop";`, `default_synth_output`, `default_resynth_output`, `write_book_bundle_file` (+ `BundleIoError::WriteFile`), and thin desktop-flavored wrappers `synth_and_stamp`/`resynth_and_stamp`/`refuse_full_input` that forward to `taletrek_worker::stamp::*` with `GENERATOR_APP` (so `main.rs`'s call sites are unchanged).
- [ ] The stamping unit tests (`synth_and_stamp_round_trips_with_correct_manifest`, `segment_count_reflects_dedup`, `preserves_book_voice_id`, `aborts_on_empty_paragraph`; `resynth_and_stamp_*` re-key + discard-stale + accept-text-only; `refuse_full_input` accept/reject) move into `crates/worker/src/stamp.rs` `#[cfg(test)]`, asserting `generator.app` against a passed-in string (not the desktop const).
- [ ] `desktop/src/bundle_io.rs` keeps the output-naming tests (`default_synth_output_*`, `default_resynth_output_*`) and the `write_book_bundle_file` round-trip + missing-parent tests (these are desktop-CLI-specific).
- [ ] `desktop/src/main.rs` is unchanged (it calls the desktop-flavored wrappers, which now forward to worker).

**Verification:**
- [ ] `cargo build --workspace` clean.
- [ ] `cargo test -p taletrek-worker` green (stamp tests now live here).
- [ ] `cargo test -p taletrek-desktop` green — **the gate**: desktop's thinned `bundle_io` tests + `cli` tests pass; the manifest the desktop stamps still reads `generator.app == "taletrek-desktop"`.
- [ ] `cargo test -p taletrek-desktop --test synth_e2e -- --ignored` still soft-skips cleanly (or passes, if `piper`+`ffmpeg`+`TALETREK_VOICE_PATH` are set) — the `#[ignore]`d real-piper test asserts `generator.app == "taletrek-desktop"` at the running crate version, which still holds.
- [ ] `cargo test -p taletrek-synth` still green (untouched).
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.

**Dependencies:** T1 (`ProgressSink`), T2 (`synth_job` in worker).

**Files likely touched:**
- `crates/worker/src/lib.rs` (declare + re-export `stamp`)
- `crates/worker/src/stamp.rs` (new — moved stamping core from `desktop/src/bundle_io.rs`, parameterized)
- `desktop/src/bundle_io.rs` (thinned: keep output naming + file write + desktop wrappers)
- `desktop/Cargo.toml` (no new deps; possibly drop `thiserror` if nothing in desktop still uses it after the stamp errors move — verify before removing)

**Docs:** Note the single-stamping-path invariant (desktop + server can't diverge `generator.app`) in `stamp.rs`'s module doc-comment — it's the mitigation for the "bundle format drift, 3rd producer" risk in the plan.

**Estimated scope:** Medium (1 new module + 1 thinned module + test split; the parameterization is the only non-mechanical change).
