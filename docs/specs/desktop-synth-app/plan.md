# PLAN — Off-device synth track · Effort 2: Desktop synth app

> Spec: [`spec.md`](./spec.md). This plan is the canonical task ordering; `todo.md` is the lightweight checklist that mirrors it.

## Overview

Ship `taletrek-desktop`: a headless Rust CLI that turns a text-only `.taletrek` into a full one (and re-voices a full one), using `crates/synth` (effort 1) for all synth logic. The desktop binary is purely orchestration: CLI parsing, voice-model caching, parallel paragraph dispatch, bundle I/O glue, stderr progress.

The Tier-2 milestone — *"close the tab, synth keeps going"* — lands when T2.7's manual end-to-end run succeeds.

## Architecture decisions (from specify phase)

1. **Bundles only in.** `read_book_bundle` / `write_book_bundle` from the lib; no parsing.
2. **Voice models auto-download** from the SPA's HF base into `$XDG_CACHE_HOME/taletrek/voices/`, behind a `VoiceSource` trait so tests stub HTTP. `--voice-path` overrides.
3. **Parallel synth** via `rayon` (`--jobs`, default `num_cpus`); per-task fresh `SubprocessPiperRunner`, shared `OpusEncoder` by ref.
4. **Two subcommands**, `synth` (text-only → full; refuses full input) and `resynth` (re-voice everything; accepts text-only or full). Shared `CommonArgs` flag struct.
5. **Abort on first error** for v1 (continue-on-error deferred).

## Dependency graph + task order

```
T2.1 workspace + CLI skeleton
   └─► T2.2 voice catalog + resolve/download/cache (voices.rs)
         └─► T2.3 parallel synth engine (synth_job.rs)  ◄── needs voices resolved
               └─► T2.4 bundle I/O glue + full manifest stamp (bundle_io.rs)
                     └─► T2.5 resynth (whole-book voice swap)  ◄── reuses 2.3 + 2.4
                           └─► T2.6 stderr progress (progress.rs) — actually lands incrementally with 2.2/2.3, finalized here
                                 └─► T2.7 manual e2e runbook + #[ignore] integration test
                                       └─► T2.8 final gates (clippy + test + pnpm verify)
```

Strict order. Each task lands its own commit + tests; `progress.rs` (T2.6) is wired in as each module needs it but is consolidated/verified in T2.6.

## Verification checkpoints

| After | Gate |
| --- | --- |
| T2.1 | `cargo run -p taletrek-desktop -- --help` prints both subcommands; `cargo build` + `clippy` clean. |
| T2.2 | Unit test: cache-hit short-circuits download (stubbed `VoiceSource`); `--voice-path` passes through; missing curated id → typed error. |
| T2.3 | Unit test: stub runner + `WavPassthrough` → every paragraph of a text-only fixture yields a segment with key == `cache_key(voice, text)`. Parallel != num_cpus still correct. |
| T2.4 | `synth` on a text-only fixture (stub runner) writes a bundle that `read_book_bundle` reads back with `audio.present == true`, correct `segmentCount`, `generator.app == "taletrek-desktop"`. Refuses full input. |
| T2.5 | `resynth` on a full fixture (stub runner) re-keys every segment to the new voice; output manifest's `voiceId` updated. |
| T2.6 | Progress lines flush to stderr per paragraph + during download (captured in a test via a `Write` seam). |
| T2.7 | Manual runbook executed (real piper + ffmpeg + real voice) → Opus bundle plays; `#[ignore]` integration test encodes the steps. |
| T2.8 | `cargo clippy -p taletrek-desktop --all-targets -- -D warnings` + `cargo test -p taletrek-desktop` + `cargo test -p taletrek-synth` + `pnpm verify` all green. |

## Test strategy

- **Unit tests co-located** (`#[cfg(test)] mod tests` per module), mirroring effort 1 / the repo convention.
- **Inject the same trait seams the lib already exposes**: `PiperRunner` (stub returns a fixed WAV) and `Encoder` (`WavPassthrough`). `synth_job` and `bundle_io` are fully testable without `piper`/`ffmpeg`.
- **`VoiceSource` trait** in `voices.rs` — one method to fetch bytes for a URL — stubbed in tests so the HF download path is exercised without network.
- **Real-piper e2e** is a single `#[ignore]` integration test (gated like effort 1's `real_piper_synthesizes_opus`), plus a human runbook for the audio-plays check that a test can't assert.
