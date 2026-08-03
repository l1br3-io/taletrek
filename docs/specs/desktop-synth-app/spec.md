---
status: active
started: 2026-08-03
---

# SPEC — Off-device synth track · Effort 2: Desktop synth app

> Track ADR: [`docs/adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
> Format spec: [`docs/bundle-format.md`](../../bundle-format.md)
> Foundation: effort 1 [`portable-bundle-format`](../portable-bundle-format/spec.md) (✅ shipped) — this effort consumes `crates/synth`.
> Second of four efforts: 1. portable-bundle-format (shipped) → **2. desktop-synth-app (this)** → 3. spa-bundle-import-export → 4. personal-server.

## Problem

Effort 1 delivered the interchange format and the reusable Rust synth core (`crates/synth`), but no app uses it yet. The Tier-2 promise — *"close the tab, synth keeps going"* — needs a standalone process that synthesizes a book off the phone. That process is the desktop app: a headless Rust CLI that takes a text-only `.taletrek` bundle in, runs native Piper on every paragraph, and writes a full `.taletrek` bundle back. No server, no parsing, no UI. It is the smallest thing that proves off-device synth.

## Scope (this effort only)

Deliver one binary, `taletrek-desktop`, that:

1. **Imports a text-only `.taletrek` bundle** (via `crates::synth::read_book_bundle`) and **exports a full `.taletrek` bundle** (via `write_book_bundle`) — the entire book synth'd to Opus, content-addressed by the same cache keys the SPA uses.
2. **Re-synthesizes a full bundle with a different voice** (`resynth`) — whole-book voice swap.
3. **Acquires Piper voice models** by auto-downloading from the same HuggingFace base the SPA uses into a local cache, with a `--voice-path` override for offline / pre-downloaded models.
4. **Runs synthesis in parallel** (`--jobs`, default `num_cpus`) — desktop has no mobile battery/CPU cap.
5. **Reports progress to stderr** line-by-line (paragraph count + voice-download progress).

It reuses `crates/synth` for *everything* synth-related: normalize, cache-key, `synthesize_paragraph`, `SubprocessPiperRunner`, `OpusEncoder`, bundle I/O. The desktop binary is orchestration + CLI + voice-model cache — no synth logic lives here.

## Decisions (locked — from ADR-0013 + effort 1 + this effort's specify phase)

| Area | Decision |
| --- | --- |
| Interface | **Headless CLI** (`clap`), no TUI, no GUI. Two subcommands: `synth`, `resynth`. |
| Input | **Bundles only.** No raw PDF/EPUB/MOBI parsing in Rust (ADR-0013 invariant). v1 desktop is bundles-only. |
| Voice acquisition | **Auto-download from HuggingFace** (`diffusionstudio/piper-voices`, the same base + path map the SPA uses) into `$XDG_CACHE_HOME/taletrek/voices/` (→ `~/.cache/...`). Skip if present. `--voice-path <model.onnx>` overrides (no download, offline). |
| Voice catalog | **Mirror the SPA's `CURATED_VOICES`** (8 English medium voices). Only curated ids resolve to a download URL; `--voice-path` is the escape hatch for any other voice. |
| Concurrency | **Parallel**, bounded pool (`rayon`), `--jobs N` default = `num_cpus`. Each task constructs its own `SubprocessPiperRunner` (cheap; the runner is just a `PathBuf`). One `OpusEncoder` is shared by reference (`encode(&self)` is stateless). |
| Codec | **Opus** (`OpusEncoder`, ffmpeg subprocess — effort 1's choice). 24 kbps default. |
| Native deps | **`piper` + `ffmpeg` on `PATH`.** Not bundled (matches effort 1 + ADR-0013). `--piper` / `--ffmpeg` flags override the binary path. |
| Default voice | `en_US-hfc_female-medium` (matches the SPA's `DEFAULT_VOICE_ID`). |
| Error policy (per-paragraph) | **Abort on first error** for v1. Piper is reliable; a failing paragraph usually means a text/encoding issue the user must fix. Continue-on-error (`--keep-going`) is a follow-up. |
| Workspace | **Add `desktop/` to the existing Cargo workspace** (`members = ["crates/*", "desktop"]`; effort 4 will append `"server"`). pnpm workspace untouched. |
| Binary name | `taletrek-desktop` (matches the `generator.app` value in `bundle-format.md`). |

## Architecture

```
taletrek/                          # repo root
  Cargo.toml                       # UPDATED — members += "desktop"
  crates/synth/                    # effort 1 (shipped) — consumed, not modified
  desktop/                         # NEW — this effort's deliverable
    Cargo.toml                     # binary "taletrek-desktop"
    src/
      main.rs                      # entry: clap parse → dispatch synth|resynth → anyhow result
      cli.rs                       # clap derive structs (Cmd::Synth | Cmd::Resynth + shared flags)
      voices.rs                    # CURATED_VOICES mirror, resolve(id)→PathBuf, HF download + cache, --voice-path override
      synth_job.rs                 # parallel synth engine: paragraphs → Vec<(key, AudioSegment)>, --jobs
      bundle_io.rs                 # thin wrappers: load text-only BookBundle, stamp full manifest, write out
      resynth.rs                   # whole-book voice swap (reuses synth_job + bundle_io)
      progress.rs                  # stderr line writer: synth [n/total] + voice-download bytes
  docs/specs/desktop-synth-app/    # this dir
```

### CLI contract (v1)

```
taletrek-desktop synth \
    --input <book.taletrek>            # required, text-only (audio.present == false)
    [--voice <id>]                     # default: en_US-hfc_female-medium (curated)
    [--voice-path <model.onnx>]        # override: use this .onnx (adjacent <stem>.json auto-discovered); skips download
    [--output <out.taletrek>]          # default: <input-stem>.synth.taletrek, beside input
    [--jobs N]                         # default: num_cpus
    [--piper <path>]                   # default: piper (PATH)
    [--ffmpeg <path>]                  # default: ffmpeg (PATH)

taletrek-desktop resynth \
    --input <full.taletrek>            # required; text-only also accepted
    --voice <newVoiceId>               # required (the whole point: re-voice the book)
    [--voice-path <model.onnx>]
    [--output <out.taletrek>]
    [--jobs N]
    [--piper <path>]
    [--ffmpeg <path>]
```

- `synth` **refuses** an already-full bundle (`audio.present == true`) → error pointing at `resynth`.
- `resynth` **re-synthesizes every paragraph** with the new voice (new voice → new cache keys → all-new audio; old audio is discarded).
- Both subcommands download the voice on first use unless `--voice-path` is given.

## Dependencies (desktop/Cargo.toml)

| Crate | Why | Notes |
| --- | --- | --- |
| `taletrek-synth` (path) | The synth core + bundle I/O. | Workspace dep. |
| `clap` (derive) | CLI parsing. | |
| `rayon` | Bounded parallel paragraph synth. | Thread count via `ThreadPoolBuilder::num_threads(jobs)`. |
| `ureq` | Voice-model download (blocking HTTP, small). | Same HF base as the SPA. Chosen over `reqwest` for minimal footprint. |
| `dirs` | Resolve `$XDG_CACHE_HOME` / `~/.cache`. | |
| `anyhow` | Top-level error reporting in `main`. | Lib errors (thiserror) convert via `?`. |

## Validation gates

- `cargo build -p taletrek-desktop` clean on the pinned toolchain.
- `cargo clippy -p taletrek-desktop --all-targets -- -D warnings` clean (workspace lints: `unsafe_code = forbid`, `missing_docs = warn`).
- `cargo test -p taletrek-desktop` green:
  - Unit tests use injected `PiperRunner` stubs + `WavPassthrough` encoder (no piper/ffmpeg needed).
  - `voices.rs` download path is behind a `VoiceSource` trait so tests stub the HTTP fetch and assert cache-hit short-circuits.
  - `synth_job` parallel engine is testable with the stub runner (asserts every paragraph produces a segment, keys match `cache_key`).
- `cargo test -p taletrek-synth` stays green (effort 1 untouched).
- `pnpm verify` stays green (no `web/` changes).
- **Manual end-to-end** (documented runbook, not CI): a real text-only fixture → `taletrek-desktop synth` with a real curated voice + real `piper` + real `ffmpeg` → a full bundle whose Opus audio plays, and whose `manifest.audio` is correct. Round-trip the output back through the SPA's import (effort 3 will automate; here it's a human smoke test).

## Non-goals (this effort)

- **No raw-file parsing** (PDF/EPUB/MOBI). Bundles only (ADR-0013).
- **No server, no worker mode, no network API.** Those are effort 4.
- **No SPA changes.** The TS bundle reader/writer + import/export UI are effort 3.
- **No TUI/GUI.** Headless CLI only.
- **No voice-model management subcommand** (`voices list|download|prune`). Voice download is implicit on first `synth`/`resynth` use; explicit management is a follow-up.
- **No library bundles.** `synth`/`resynth` operate on a single book bundle. Library-level operations are deferred.
- **No continue-on-error.** v1 aborts on the first failing paragraph (`--keep-going` is a follow-up).
- **No resumption of a partially-synth'd book.** Each run is a fresh full pass. (Content-addressing makes future resume cheap, but it's out of scope here.)

## Risks

| Risk | Mitigation |
| --- | --- |
| **Piper model load × num_cpus** could memory-spike (each parallel task loads the `.onnx`). | Default `--jobs num_cpus` is fine for medium voices (~63 MiB) on desktop; document the memory implication and expose `--jobs` for users to clamp on low-RAM machines. |
| **HF download availability / URL drift** breaks voice fetch. | Pin the same `HF_BASE` the SPA uses; on download failure, surface a clear error with the URL + suggest `--voice-path`. |
| **Parallel `predict(&mut self)`** — runner can't be shared. | Each rayon task constructs its own `SubprocessPiperRunner` (just a `PathBuf`); the encoder *is* shared (`encode(&self)`). |
| **CLI surface drift** between `synth` and `resynth`. | Shared flag struct (`CommonArgs`) consumed by both subcommands; one place to change. |
| **`.json` config missing next to `--voice-path .onnx`** → piper fails opaquely. | `voices.rs` pre-checks the `<stem>.json` exists and errors clearly before invoking piper. |
| **Effort 1 crate API gaps** discovered during integration. | This effort may surface missing helpers in `crates/synth`; those go back as small patches to effort 1 (keeping `cache_key_parity` green), not a fork. |

## Open implementation notes (not blockers)

- `ureq` vs `reqwest`: `ureq` is the default (small, blocking). If its streaming-progress API proves awkward for a 63 MiB download, `reqwest` blocking is the fallback — the `VoiceSource` trait isolates the choice.
- Output naming when `--output` omitted: `<input-stem>.synth.taletrek` for `synth`, `<input-stem>.<voice>.taletrek` for `resynth`. Decided in T2.4.
- Whether to print a final summary line (`synth: 312 paragraphs, 4m17s, → out.taletrek`) — yes, low-cost, decided in T2.6.
