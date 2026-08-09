# Task 001: Worker crate scaffold + `ProgressSink` trait + move `voices` (and `progress`)

**Description:** First step of the `crates/worker` extraction. Create the new workspace crate, introduce a `ProgressSink` trait that decouples voice resolution / synth progress from the desktop's concrete `Progress` type, and move the **voice-acquisition stack** (`voices.rs` + its dependency `progress.rs`) from `desktop/` into `crates/worker`. `voices.rs` and `progress.rs` are tightly coupled (voices constructs `Progress` and calls `download_step`; its tests assert on `Progress` lines), so they move together to avoid a half-broken intermediate state. The desktop binary switches to importing both from `taletrek_worker`; its behavior is identical. `crates/synth` is untouched.

**Acceptance criteria:**
- [ ] New crate `crates/worker` exists; root `Cargo.toml` `members` already includes it via the existing `crates/*` glob (no root edit needed — verify with `cargo metadata`).
- [ ] `crates/worker/Cargo.toml`: `name = "taletrek-worker"`, inherits workspace (version/edition/license/lints), deps `ureq`, `dirs`, `thiserror`, plus path dep `taletrek-synth` only if voices needs it (it does not today — omit unless a moved item references it).
- [ ] `crates/worker/src/lib.rs` declares `pub mod voices;` and a `pub trait ProgressSink` with the two methods the host code actually calls: `fn synth_step(&self, done: usize, total: usize);` and `fn download_step(&self, bytes_done: u64, bytes_total: u64);`. Doc-comment the trait as the seam between the worker engine and the host's progress reporting (desktop = stderr lines, server = job-row `done`/`total`).
- [ ] `desktop/src/progress.rs` moves to `crates/worker/src/progress.rs`, exposed as `taletrek_worker::Progress`. `impl ProgressSink for Progress` wires `synth_step`/`download_step` to the existing line writers. The CLI-only `summary(...)` + `elapsed()` + `to_stderr()`/`new()` stay as inherent methods on the concrete `Progress` type (not on the trait — the server never summarizes).
- [ ] `desktop/src/voices.rs` moves to `crates/worker/src/voices.rs`. `resolve_voice` (and the internal `download` helper) change `progress: Option<&Progress>` → `progress: Option<&dyn ProgressSink>`. All public items (`HF_BASE`, `DEFAULT_VOICE_ID`, `VoiceQuality`, `Voice`, `CURATED_VOICES`, `find_curated`, `ResolveOpts`, `default_cache_dir`, `VoiceSource`, `UreqVoiceSource`, `ResolveError`, `resolve_voice`) re-export from `lib.rs`.
- [ ] `desktop/src/main.rs` imports `taletrek_worker::{Progress, voices::{...}}` instead of `crate::...`; the `mod voices; mod progress;` declarations are removed from `desktop/src/main.rs`. `run_synth`/`run_resynth` compile and behave identically (they already call `resolve_voice(..., Some(&progress))` and pass `Progress::to_stderr()`).
- [ ] The catalog/parity unit tests (count = 8, all en_*, all medium; `curated_rel_onnx_path` matches the SPA `PATH_MAP`; `DEFAULT_VOICE_ID == CURATED_VOICES[0].id`) move into `crates/worker/src/voices.rs` `#[cfg(test)]`.
- [ ] The `Progress` line-formatting unit tests (exact `synth [n/total] pct%`, `voice d.t/total MiB (pct%)`, summary prefix/suffix, `format_duration`) move into `crates/worker/src/progress.rs` `#[cfg(test)]`.

**Verification:**
- [ ] `cargo build --workspace` clean.
- [ ] `cargo test -p taletrek-worker` green (moved voices + progress tests).
- [ ] `cargo test -p taletrek-desktop` green — **the gate**: the desktop's remaining tests (`cli`, `synth_job`, `bundle_io`) still pass against the imported worker modules; desktop behavior is identical.
- [ ] `cargo test -p taletrek-synth` still green (untouched).
- [ ] `cargo clippy -p taletrek-worker -p taletrek-desktop --all-targets -- -D warnings` clean.
- [ ] Manual: `cargo run -p taletrek-desktop -- --help` still prints both subcommands.

**Dependencies:** None (first task).

**Files likely touched:**
- `crates/worker/Cargo.toml` (new)
- `crates/worker/src/lib.rs` (new — `ProgressSink` trait + module/re-export declarations)
- `crates/worker/src/progress.rs` (moved from `desktop/src/progress.rs`, +`impl ProgressSink`)
- `crates/worker/src/voices.rs` (moved from `desktop/src/voices.rs`, `&Progress` → `&dyn ProgressSink`)
- `desktop/Cargo.toml` (add `taletrek-worker = { path = "../crates/worker" }`; drop now-unused `ureq`/`dirs` if nothing else in desktop uses them — verify before removing)
- `desktop/src/main.rs` (drop `mod voices; mod progress;`, import from `taletrek_worker`)
- `desktop/src/voices.rs` (deleted), `desktop/src/progress.rs` (deleted)

**Docs:** Add a `/** GOTCHA */`-style doc comment on `ProgressSink` noting the desktop/server split (desktop = stderr, server = job row). No `gotchas.md` entry needed unless the trait proves surprising in practice.

**Estimated scope:** Medium (4 new/moved files + 2 desktop edits; mechanical move + one trait seam).
