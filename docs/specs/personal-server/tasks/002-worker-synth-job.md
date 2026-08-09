# Task 002: Move parallel synth engine into `crates/worker::synth_job`

**Description:** Move `desktop/src/synth_job.rs` (the bounded `rayon` pool that flattens every chapter's paragraphs and runs `taletrek_synth::synthesize_paragraph` in parallel) into `crates/worker::synth_job`. The only change is the progress seam: `Option<&Progress>` → `Option<&dyn ProgressSink>` (the trait landed in T1). The desktop's `bundle_io.rs` (still in desktop until T3) switches its import from `crate::synth_job` to `taletrek_worker`. Behavior identical; desktop tests gate the move.

**Acceptance criteria:**
- [ ] `crates/worker/Cargo.toml` adds `rayon` and `taletrek-synth` (path) deps (synth_job references `taletrek_synth::{synthesize_paragraph, PiperRunner, SynthError, SynthOptions, AudioSegment, BookBundle, Encoder, cache_key}`).
- [ ] `crates/worker/src/lib.rs` declares `pub mod synth_job;` and re-exports `synth_all_paragraphs` + `SynthJobError` (so callers can `use taletrek_worker::{synth_all_paragraphs, SynthJobError}`).
- [ ] `crates/worker/src/synth_job.rs` is `desktop/src/synth_job.rs` moved, with `use crate::progress::Progress;` → `use crate::ProgressSink;` and the `progress: Option<&Progress>` param → `Option<&dyn ProgressSink>`. The `SynthJobError` enum, the `collect_paragraphs` helper, and the parallel `pool.install(|| par_iter()...)` body are otherwise byte-for-byte identical.
- [ ] `desktop/src/bundle_io.rs` switches `use crate::synth_job::{synth_all_paragraphs, SynthJobError};` → `use taletrek_worker::{synth_all_paragraphs, SynthJobError};` (or qualified path). No other change to bundle_io in this task.
- [ ] `desktop/src/main.rs` drops `mod synth_job;`. (It does not call synth_job directly — it goes through `bundle_io::synth_and_stamp`, which stays in desktop until T3.)
- [ ] The synth_job unit tests (every paragraph → segment keyed by `cache_key`; identical paragraphs dedup; `jobs: 1` still correct; aborts on empty paragraph; empty bundle → empty map; progress lines monotonic with `jobs: 1`; progress silent on empty/errored) move into `crates/worker/src/synth_job.rs` `#[cfg(test)]`, using the worker `Progress` (or a capturing `ProgressSink` stub) for the progress assertions.

**Verification:**
- [ ] `cargo build --workspace` clean.
- [ ] `cargo test -p taletrek-worker` green (synth_job tests now live here).
- [ ] `cargo test -p taletrek-desktop` green — **the gate**: `bundle_io` tests (which call `synth_and_stamp` → `synth_all_paragraphs`) pass against the imported worker function.
- [ ] `cargo test -p taletrek-synth` still green (untouched).
- [ ] `cargo clippy -p taletrek-worker -p taletrek-desktop --all-targets -- -D warnings` clean.

**Dependencies:** T1 (`ProgressSink` trait + worker crate exist).

**Files likely touched:**
- `crates/worker/Cargo.toml` (add `rayon`, `taletrek-synth`)
- `crates/worker/src/lib.rs` (declare + re-export `synth_job`)
- `crates/worker/src/synth_job.rs` (moved from `desktop/src/synth_job.rs`)
- `desktop/src/synth_job.rs` (deleted)
- `desktop/src/main.rs` (drop `mod synth_job;`)
- `desktop/src/bundle_io.rs` (import path swap)

**Docs:** None beyond the moved doc comments.

**Estimated scope:** Small–Medium (1 moved module + import path swaps; purely mechanical after T1's trait seam).
