# Task T1.7 — Synth pipeline (piper subprocess + Opus encode)

> **Effort:** 1 (`portable-bundle-format`) · **Status:** ▸ NEXT · **Depends on:** T1.1–T1.6, T1.8 (all ✅ done).
> **Self-contained:** a fresh opencode session can be pointed at this file alone.

## Goal
Add the actual synthesis pipeline to `crates/synth`: take `(voice, text)` and produce encoded Opus bytes. This is the last piece of effort 1 — once it ships, the crate can synthesize and the effort flips to `shipped`, unblocking effort 2 (`desktop-synth-app`).

## Read first (in this order)
1. `docs/adrs/0013-off-device-synth-and-portable-bundles.md` — why native Piper (subprocess, not WASM).
2. `docs/specs/portable-bundle-format/plan.md` → **Phase 7** — the original plan for this task.
3. `crates/synth/src/lib.rs` — current public API you're extending.
4. `web/src/lib/tts/engine.ts` — the SPA's synth loop you're mirroring (normalize → split → synth per chunk → concat). **Reuse** `crates::normalize::{normalize_for_speech, split_for_speech}` — do NOT re-derive.
5. `web/src/lib/tts/vendor/piper/pcm.ts` — how the SPA concats WAV chunks (port `concatWav`).

## Decisions (locked in the plan)
- **Native `piper` subprocess**, not ONNX-Runtime-in-Rust. Piper ships as a binary; shell out. Keeps the crate small, avoids re-solving phonemize/espeak (gotcha G1).
- **Injectable trait** (`PiperRunner`) so unit tests stub the subprocess. The real-piper path is a `#[ignore]` integration test requiring `piper` on `PATH`.
- **Opus default**, M4A/WAV permitted. Encoding behind an `Encoder` trait so the host picks.
- **No voice-model management beyond a cache dir.** Piper `.onnx` voices live on disk; the host app downloads them. The crate takes a path to the voice model.

## Files to create
- `crates/synth/src/synth.rs` — `PiperRunner` trait, `SubprocessPiperRunner`, `synthesize_paragraph(voice, text, opts) -> SynthOutput`.
- `crates/synth/src/encode.rs` — `Encoder` trait + `OpusEncoder` + `WavPassthrough` (for tests).
- `crates/synth/tests/synth_integration.rs` — stubbed unit test (trait seam) + `#[ignore]` real-piper test.

## Files to edit
- `crates/synth/src/lib.rs` — add `pub mod synth; pub mod encode;` and re-export `synthesize_paragraph`, `PiperRunner`, `SubprocessPiperRunner`, `Encoder`, `OpusEncoder`, `SynthOutput`.
- `crates/synth/Cargo.toml` — add the Opus dep you pick (see step 3).

## Steps

1. **`PiperRunner` trait** in `synth.rs`:
   ```rust
   pub trait PiperRunner {
       /// Synthesize one chunk of normalized text to raw PCM WAV bytes.
       fn predict(&mut self, voice_model: &Path, text: &str) -> Result<Vec<u8>, SynthError>;
   }
   ```
   `SubprocessPiperRunner` shells out to `piper --model <voice> --output_raw` (or `--output-raw`/`-f -`) reading WAV from stdout. Use `std::process::Command`. Capture `stderr` for error messages.

2. **`Encoder` trait** in `encode.rs`:
   ```rust
   pub trait Encoder {
       fn encode(&self, wav: &[u8]) -> Result<Vec<u8>, SynthError>;
       fn codec(&self) -> AudioCodec;
   }
   pub struct OpusEncoder { /* bitrate, sample_rate */ }
   pub struct WavPassthrough; // tests only
   ```

3. **Pick the Opus impl.** Try in this order, take the first that compiles clean on the pinned toolchain (1.97):
   - `audiopus` (bindings to libopus — needs `libopus` dev lib).
   - `opus-rs` / `opus` crate.
   - Fallback: shell out to `ffmpeg -i pipe:0 -c:a libopus -f opus pipe:1` (behind the trait; only if a library won't link).
   Record the choice in `docs/bundle-format.md` (the "audio codec" note).

4. **`synthesize_paragraph`** wiring — mirrors `engine.ts:104`:
   ```
   normalize_for_speech(text)
     → split_for_speech(cleaned, MAX_SYNTH_CHARS)
     → for each chunk: runner.predict(voice_model, chunk) → WAV
     → concat WAVs (port of concatWav from web/src/lib/tts/vendor/piper/pcm.ts)
     → encoder.encode(concatenated_wav) → Opus bytes
   ```
   Return `SynthOutput { cache_key: String, audio: Vec<u8>, codec: AudioCodec, duration_seconds: f64 }` where `cache_key = cache_key::cache_key(voice, text)`.

5. **Tests** (`tests/synth_integration.rs`):
   - A `FakeRunner` returning a fixed tiny WAV; assert `synthesize_paragraph` normalizes, splits, concats, and the `cache_key` matches `cache_key::cache_key(voice, original_text)`.
   - A `#[ignore] fn real_piper_synthesizes()` that skips when `piper` isn't on `PATH` (read a voice model path from an env var `TALETREK_PIPER_MODEL` and `TALETREK_PIPER_BIN`).

6. **WAV concat port:** `web/src/lib/tts/vendor/piper/pcm.ts` `concatWav` — port the minimal header parse + data concatenation. Add `crates/synth/src/pcm.rs` (or fold into `synth.rs`).

## Done when
- [ ] `synthesize_paragraph(voice, text, opts)` exists and returns Opus bytes via the injected runner.
- [ ] Cache key on the result matches `cache_key::cache_key(voice, text)` (parity preserved).
- [ ] Stubbed unit test passes with a `FakeRunner` + `WavPassthrough`.
- [ ] `#[ignore]` real-piper test exists (skips gracefully without the binary).
- [ ] `cargo test -p taletrek-synth` green (all prior tests + new ones).
- [ ] `cargo clippy -p taletrek-synth --all-targets -- -D warnings` clean.
- [ ] `docs/bundle-format.md` updated with the chosen Opus encoder.

## Verify (run before marking done)
```bash
cargo test -p taletrek-synth
cargo clippy -p taletrek-synth --all-targets -- -D warnings
# optional, only if you have piper installed:
TALETREK_PIPER_BIN=piper TALETREK_PIPER_MODEL=/path/to/voice.onnx \
  cargo test -p taletrek-synth -- --ignored real_piper
```

## After this task
1. Flip `docs/specs/portable-bundle-format/spec.md` frontmatter: `status: active → shipped`, add `shipped: <date>`.
2. Move the ▸ NEXT marker in `tasks/README.md` to effort 2.
3. Start effort 2: create `docs/specs/desktop-synth-app/` (run `/spec`) and begin T2.1.

## Risks / gotchas
- **Opus native dep** linking is the likeliest snag. If `audiopus`/`opus` won't link on 1.97, use the ffmpeg-subprocess encoder behind the trait — don't block the crate on a native lib.
- **Piper stdout format:** confirm whether `piper` emits raw PCM or WAV on stdout for the flag you choose (`--output_raw` vs default WAV). The SPA path expects WAV. Match it.
- **Long-text chunking memory:** the SPA chunks at `MAX_SYNTH_CHARS` to avoid iOS OOM. Server-side memory is not constrained the same way, but **keep the same chunking** so cache keys match (the key is over the full text either way, but per-chunk synth must match for identical audio).
