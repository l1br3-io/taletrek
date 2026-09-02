# Plan — desktop-synth-gui (native track, effort 3)

> Spec: [`spec.md`](./spec.md) · Track: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md) · Builds on [`kernel-parse`](../kernel-parse/spec.md).
> Branch: `desktop-synth-gui`. Status source: [`todo.md`](./todo.md).

## Overview

Give the kernel a face and remove its external binaries. Two blocks, engine strictly first: (1) swap the subprocess piper/ffmpeg engines for in-process ones — sherpa-onnx TTS behind the existing `PiperRunner` trait, native Opus (libopus static + `ogg` mux) behind the existing `Encoder` trait — making `taletrek-desktop` dependency-free; (2) an egui GUI (`gui` subcommand, bare-run default): drop a file → queue → voice (auto-download) → live progress → `.taletrek`. Ship = GitHub-release artifacts via CI.

## Architecture decisions

- **egui/eframe, not Tauri 2** — one toolchain, one static binary, whole app inside the cargo gates; no webview variance (spec §Decisions).
- **Engines behind the existing traits, no trait rewrites** — `SherpaRunner` (feature `sherpa`) implements `PiperRunner::predict → canonical WAV`; `NativeOpusEncoder` (feature `native-encode`) implements `Encoder`. Subprocess impls stay as `--piper`/`--ffmpeg` overrides.
- **Cache keys are text-derived** — engine swap cannot change keys by construction; parity test pins it, not bit-identical audio.
- **Queue is pure, egui is thin** — `desktop/src/gui/queue.rs` is a UI-free state machine (unit-tested like any crate module); egui only renders + forwards events. Engine execution lives on one background job thread; rayon parallelism stays *within* a job.
- **Per-thread model load is the sherpa cost model** — `synth_all_paragraphs` constructs one runner per rayon thread (`make_runner`); each sherpa runner holds its own ONNX model. Default jobs for the native engine get clamped/guided accordingly (measured in T3, applied in T5).
- **Spikes first, fail fast** — sherpa linking and libopus static linking are the two named risks; both get throwaway spike tasks before any production code (mirrors kernel-parse's T2 PDF spike pattern).

## Task index

### Phase 1 — In-process engine (fail fast)
- [x] T1 — sherpa-onnx spike: crate verdict (link, load, synth, memory) → [`tasks/001-sherpa-spike.md`](./tasks/001-sherpa-spike.md)
- [x] T2 — native Opus spike: crate verdict (static link, WAV→Opus/OGG round-trip) → [`tasks/002-opus-spike.md`](./tasks/002-opus-spike.md)
- [ ] T3 — `SherpaRunner` behind feature `sherpa` → [`tasks/003-sherpa-runner.md`](./tasks/003-sherpa-runner.md)
- [ ] T4 — `NativeOpusEncoder` behind feature `native-encode` → [`tasks/004-native-opus-encoder.md`](./tasks/004-native-opus-encoder.md)
- [ ] T5 — CLI default flips native; `--piper`/`--ffmpeg` become overrides; engine-parity test → [`tasks/005-cli-native-default.md`](./tasks/005-cli-native-default.md)

### Checkpoint A — dependency-free CLI
- [ ] `cargo test --workspace` + `--ignored` (both engine paths) + `pnpm verify` green
- [ ] parse→synth→bundle works with no piper/ffmpeg on PATH; bundle plays in the reader

### Phase 2 — GUI
- [ ] T6 — pure queue state machine (`gui/queue.rs`) → [`tasks/006-queue-state-machine.md`](./tasks/006-queue-state-machine.md)
- [ ] T7 — egui shell + `gui` subcommand + convert happy path (dialog → queue → progress → save) → [`tasks/007-gui-shell-convert.md`](./tasks/007-gui-shell-convert.md)
- [ ] T8 — voice picker (catalog + download) + re-voice queue action → [`tasks/008-voice-picker-revoice.md`](./tasks/008-voice-picker-revoice.md)
- [ ] T9 — settings, failure/cancel UX, drag-drop → [`tasks/009-settings-failure-ux.md`](./tasks/009-settings-failure-ux.md)

### Checkpoint B — GUI happy path
- [ ] Clean machine (no external binaries): bare `taletrek-desktop` → drop EPUB → voice download → progress → `.taletrek` that plays in the reader
- [ ] Queue logic fully unit-tested; no egui types outside `desktop/src/gui/`

### Phase 3 — Ship
- [ ] T10 — release workflow (GH Actions matrix → artifacts) → [`tasks/010-release-workflow.md`](./tasks/010-release-workflow.md)
- [ ] T11 — docs close-out + full gates + reader smoke → [`tasks/011-docs-final-verify.md`](./tasks/011-docs-final-verify.md)

### Checkpoint C — ship-ready
- [ ] Tag push produces artifacts; Linux artifact runs on a clean machine
- [ ] Spec ready to flip `shipped` at merge

## Parallelization

T1 ∥ T2 (independent spikes); T6 can run any time after spec approval (no code deps). Everything else is sequential per the dependency edges in the task files.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| sherpa-onnx crate linking (cmake/libclang, onnxruntime) | High — blocks the GUI's core promise | T1 spike first; `sherpa-rs` fallback; subprocess engines remain the floor (feature-gated GUI could ship without, but that's a human decision, not silent) |
| libopus static linking in pinned toolchain 1.97 (the original reason ffmpeg subprocess won — `encode.rs` docs) | High | T2 spike; vendored/static cargo features; documented fallback = GUI keeps ffmpeg for encode only (ask-first) |
| sherpa model memory under rayon (one model per thread) | Medium | Measure in T3; clamp default jobs for native engine in T5 |
| egui drag-drop/dialog rough edges | Low | `rfd` pairing; drop-zone is enhancement (T9), not gate (T7 uses the picker) |
| CI cross-builds (aarch64/win/mac) | Medium | Linux x86_64 is the only first-class artifact; others best-effort `continue-on-error` |

## Open questions (resolved by spikes, not blockers)

- `sherpa-onnx` vs `sherpa-rs` → T1.
- `audiopus` vs `opus`, vendored vs system → T2.
- glibc vs musl for the Linux artifact → T10 (informed by T1/T2 static-link outcomes).
