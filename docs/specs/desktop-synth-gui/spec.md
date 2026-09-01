---
status: active        # draft → active → shipped
started: 2026-09-02
---

# SPEC — Native pivot track · Effort 3: Desktop synth GUI (`desktop-synth-gui`)

> Track context: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md) · why + locked stack: [`ideas/native-pivot.md`](../../ideas/native-pivot.md) · direction: [`ROADMAP.md`](../../ROADMAP.md).
> Builds on effort 2 [`kernel-parse`](../kernel-parse/spec.md) (✅) — the CLI is already a complete file→audiobook pipeline; this effort gives it a face and removes its external binaries.

## Problem

The kernel works, but only through a terminal. `taletrek-desktop parse`/`synth` is a complete source→`.taletrek` pipeline, yet the product promise is "free download, works offline" — and today it demands `piper` and `ffmpeg` on PATH (or a seeded cache) plus CLI literacy. Two gaps block the first real ship: **no GUI** (the processor app in the VISION is a window, not a shell) and **external runtime deps** (subprocess piper + ffmpeg contradict "just works" distribution, and Android/iOS will need in-process TTS anyway — the sherpa-onnx direction the tagline already states).

## Objective (users + success)

- **User:** anyone who wants an audiobook from a file they own — no terminal, no installs. Also the maintainer (this replaces CLI-first usage as the primary interface).
- **Success looks like:** on a clean machine with zero native deps installed, run the app, drop an EPUB, pick a voice (auto-downloaded), watch per-book progress, save a `.taletrek` that plays in the web reader — and the same binary still serves the CLI (`parse`/`synth`/`resynth`) unchanged.

## Scope (this effort only)

1. **Engine swap (in-process)** — sherpa-onnx TTS (Piper voices today, Kokoro voices load the same way) behind the existing runner trait; native Opus encode (libopus, statically linked) + OGG mux behind the existing `Encoder` trait. The subprocess implementations stay for CLI flags/tests. This is done *first* — the GUI must never need external binaries.
2. **GUI** — egui/eframe shell on `taletrek-desktop`: a `gui` subcommand (bare invocation opens it). File drop / picker → job queue → voice picker (curated catalog + HF download, reused from `crates/worker`) → parallel synth with live progress (`ProgressSink` → GUI sink) → `.taletrek` output. Re-voice (resynth) as a queue action on any input.
3. **CLI parity** — existing subcommands keep their interface; native engine becomes the default, `--piper`/`--ffmpeg` remain explicit subprocess overrides (test escape hatches).
4. **Distribution** — GitHub Actions release workflow: Linux x86_64 artifact first-class (statically linked where possible), aarch64/Windows/macOS best-effort in the same matrix. Free GitHub-release downloads; no store.

## Decisions (locked — specify phase 2026-09-02)

| Area | Decision |
| --- | --- |
| GUI framework | **egui/eframe** — the ROADMAP-deferred choice, decided here. One cargo toolchain, one static binary, whole app inside the existing cargo gates. Rejected Tauri 2: two toolchains inside the desktop app + system-webview variance (WebKitGTK fragmentation) — the wrong trade for a free-download utility. Utility-grade immediate-mode UI is the accepted aesthetic. |
| TTS engine | **In-process sherpa-onnx, this effort.** New `SherpaRunner` implementing synth's runner trait behind a cargo feature (`sherpa`); Piper voice models load directly; Kokoro voice models use the same API (curation is a later catalog add, not a mechanism change). Subprocess piper stays behind `--piper` for parity testing. |
| Encode | **Native Opus**: libopus via a safe binding (`audiopus`/`opus` crate — validated in plan) statically linked, + pure-Rust OGG mux (`ogg` crate). New `NativeOpusEncoder` behind feature `native-encode`. The ffmpeg subprocess encoder stays — encode.rs was written for exactly this swap. CLI default flips to native; `--ffmpeg` remains the explicit override. |
| App shape | **One binary, new `gui` subcommand; bare `taletrek-desktop` (no args) opens the GUI.** CLI flags untouched. Native-heavy deps (sherpa, libopus) behind default-on cargo features so `--no-default-features` keeps a lean CLI-only build. |
| Queue model | **In-app job queue**: VecDeque of jobs (convert or re-voice), each job = parse (if source) → synth (`synth_all_paragraphs`, rayon) → encode → bundle write. Sequential job execution, parallel paragraphs within a job; per-paragraph + per-book progress via a GUI `ProgressSink`. Queue logic is pure and UI-free (testable without egui). |
| Voices | Reuse `crates/worker` catalog + HF download as-is. v1 ships the existing curated Piper voices; voice files land in the same `~/.cache/taletrek/voices` the CLI uses. |
| State | Minimal: settings (output dir, default voice, jobs) in egui's native storage. No app library, no history persistence — output files are the state (bundles are the interchange). |
| Distribution | GitHub Actions release matrix on tag: `x86_64-unknown-linux-gnu` (or musl if static linking of onnxruntime/libopus allows) first-class; `aarch64-linux`, `windows`, `macos` best-effort artifacts attached to the release. Static linking preferred; glibc fallback acceptable. |
| `--ignored` e2e | Existing real-engine tests keep running the subprocess path (piper+ffmpeg flags) — they prove engine *parity*, while new `--ignored` sherpa tests prove the native path. Both must stay green. |

## Architecture

```
 taletrek-desktop (one binary)
 ├─ cli.rs        parse | synth | resynth | gui   (bare = gui)
 ├─ gui/          eframe app — thin: views render queue state
 │    queue.rs    pure job queue state machine (UI-free, unit-tested)
 │    sink.rs     ProgressSink → GUI channel
 └─ …existing handlers (now default-native engine)
        │
        ▼  crates/worker (unchanged role)
   synth_all_paragraphs (rayon) · voices (catalog+HF) · ProgressSink · stamp
        │
        ▼  crates/synth (engine traits — the swap point)
   runner trait ──► SherpaRunner (feature `sherpa`, in-process, ONNX Runtime)
   │                 └ SubprocessPiperRunner (stays, --piper)
   Encoder trait ──► NativeOpusEncoder (feature `native-encode`: libopus + ogg mux)
   │                 └ OpusEncoder/ffmpeg (stays, --ffmpeg)
   cache_key / normalize / pcm / bundle — untouched (text-derived keys:
   engine swap cannot change cache keys by construction)
```

Layering: engine impls live in `crates/synth` behind features (the traits are already there); `worker` stays engine-agnostic; `desktop/gui` is orchestration + pixels only. No new crate.

## Technologies (additions — ask-first at review)

| Crate | License | Role |
| --- | --- | --- |
| `sherpa-onnx` (or `sherpa-rs` — plan validates) | Apache-2.0 | In-process TTS: Piper + Kokoro voice models |
| `eframe`/`egui` | MIT/Apache-2.0 | GUI shell |
| `rfd` | MIT/Apache-2.0 | Native file dialogs (egui's standard pairing) |
| `audiopus` or `opus` (plan validates; static/vendored build) | MIT (binds BSD-3 libopus) | Native Opus encode |
| `ogg` | MIT/Apache-2.0 | OGG/Opus container mux |
| `crossbeam-channel` (already via deps) | MIT/Apache-2.0 | progress → GUI thread |

GPL/AGPL alternatives rejected per G4. Native-dep linking (onnxruntime, libclang/cmake at build time) is the plan phase's #1 spike target.

## Commands

```
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo run -p taletrek-desktop -- gui          # or: just gui
cargo run -p taletrek-desktop -- gui --no-default-features   # lean CLI build check (feature isolation)
cargo test --workspace -- --ignored           # real-engine e2e: subprocess AND sherpa paths
just parse-fixture && just chain-fixture       # unchanged CLI bar
gh release create …                           # CI builds artifacts (release workflow)
```

## Project structure

```
desktop/
  src/cli.rs          + Gui variant; bare-run default
  src/gui/mod.rs      eframe app entry, main window
  src/gui/queue.rs    pure job-queue state machine (UI-free)
  src/gui/sink.rs     ProgressSink impl → crossbeam channel
  src/gui/views/      drop-zone, queue list, voice picker, job detail
  src/gui/settings.rs output dir / default voice / jobs
crates/synth/src/sherpa_runner.rs   feature `sherpa` — in-process TTS runner
crates/synth/src/opus_native.rs     feature `native-encode` — libopus + ogg
.github/workflows/release.yml       tag → matrix build → artifacts
```

## Code style

Follows the existing crates (`//!` docs, typed `thiserror` errors, plain-data structs, features documented at the module door). The queue is the pattern to show:

```rust
pub enum JobKind { Convert { input: PathBuf, voice: VoiceId }, ReVoice { input: PathBuf, voice: VoiceId } }
pub enum JobState { Queued, Running { done: usize, total: usize }, Done(PathBuf), Failed(String) }

pub struct Queue { jobs: VecDeque<Job> }
impl Queue {
    pub fn push(&mut self, kind: JobKind);
    pub fn tick(&mut self, event: QueueEvent);   // pure transition — the egui layer only renders this
}
```

- GUI layer renders state; **all** transitions live in UI-free types (`queue.rs` unit-tested like any crate module)
- egui never appears outside `desktop/src/gui/`
- Engine impls honor the existing trait signatures exactly — no trait changes

## Testing strategy

- **Queue state machine**: unit tests (`#[cfg(test)]` beside `queue.rs`) — enqueue, progress ticks, failure, completion, cancel.
- **Sherpa runner** (`--ignored`, real model): fixture paragraph → PCM out, sample-format/rate match, deterministic length bounds. Hermetic stub: a fake runner already powers existing CLI tests — extend, don't duplicate.
- **Native encoder**: hermetic — synthetic PCM → encode → decode round-trip (libopus decode) or header/OGG-structure assertions; bit-exactness against ffmpeg output is **not** required (keys are text-derived).
- **Engine parity** (existing `--ignored` e2e): subprocess and sherpa paths each produce a bundle the reader imports and plays; cache keys identical across engines (same text ⇒ same keys — assert manifest equality minus generator/encoder stamps).
- **Reader smoke** (chrome-devtools, the T7 bar): GUI-produced bundle imports + plays end-to-end, zero console errors.
- **GUI**: state-machine level only; no screenshot tests. Manual smoke is the release gate.
- **Release workflow**: CI artifacts build green on tag; `just gui` documented for dev.

## Boundaries

- **Always:** engine behind the existing traits (no trait rewrites); cache keys unchanged; queue logic pure/UI-free; features `sherpa`/`native-encode` compile-off-able; both `--ignored` suites green; clippy `-D warnings`; bundle format v1 untouched.
- **Ask first:** any dependency beyond the table (or swapping one); onnxruntime static-linking strategy changes; new gotchas; touching `cache_key.rs`/`normalize.rs`.
- **Never:** external runtime deps in the GUI path (no subprocess piper/ffmpeg by default); GPL/AGPL (G4); cloud anything; store distribution; AI transforms (later, per ADR-0015 decision 6); re-architecting worker.

## Success criteria

1. Bare `taletrek-desktop` on a clean Linux box (no piper/ffmpeg installed) opens the GUI.
2. Drop an EPUB → voice downloads on demand → live progress → `.taletrek` saved → **plays in the web reader end-to-end** (chrome-devtools smoke, zero console errors).
3. Re-voice of an existing bundle from the GUI works (resynth path).
4. Same binary: `parse`/`synth`/`resynth` CLI unchanged; `--piper`/`--ffmpeg` overrides still function.
5. Cache keys identical between subprocess and native engines (parity test).
6. `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` + `--ignored` suites + `pnpm verify` green.
7. Tag push produces GitHub-release artifacts; the Linux one runs on a clean machine.

## Non-goals (this effort)

AI transforms (desktop-processor feature, later per M6 note), library UI/history, auto-update, i18n, theming beyond egui defaults, Kokoro *catalog curation* (mechanism ships, catalog later), first-class Windows/macOS QA (artifacts best-effort), Android/iOS anything (efforts 4–5), bundle format changes, voice cloning/custom voice import.

## Risks

| Risk | Mitigation |
| --- | --- |
| sherpa-onnx crate maturity + native linking (cmake/libclang, onnxruntime static) | Spike task first in the plan; `sherpa-rs` as the validated fallback; subprocess engines remain the floor — GUI could ship feature-gated off if the spike fails (decision point, not silent) |
| libopus static linking in the pinned toolchain — the exact reason ffmpeg subprocess was chosen (encode.rs docs) | Spike #2: `audiopus`/`opus` vendored/static features; if both fail, v1 GUI keeps ffmpeg for encode only (documented residual dep, ask-first) |
| onnxruntime binary size (~10–20 MB per artifact) | Accepted (30 MB FFmpeg WASM precedent, G11); static link where possible |
| egui drag-drop/file-dialog rough edges | `rfd` is the standard pairing; worst case: picker-only import (drop-zone is enhancement, not gate) |
| GUI threads vs rayon pool contention | Queue runs one job at a time; rayon threads sleep when idle — egui stays responsive; measure in the smoke |

## Open questions (plan phase, not blockers)

- `sherpa-onnx` vs `sherpa-rs` crate (spike decides — API surface, linking, voice-model loading ergonomics).
- `audiopus` vs `opus` crate; vendored vs system libopus.
- glibc vs musl for the Linux artifact (static-linking outcomes decide).
- Voice preview (audition a voice before commit) — nice-to-have, cut unless free.
- Whether resynth exposes voice-quality (x_low/medium/high) pick or id-only.
