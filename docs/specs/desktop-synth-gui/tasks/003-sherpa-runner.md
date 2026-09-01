# T3 — `SherpaRunner` behind feature `sherpa`

**Description:** Production in-process TTS runner implementing the existing `PiperRunner` trait (`crates/synth/src/synth.rs`), behind cargo feature `sherpa` per the spec. Model loads once per runner at construction; `predict` returns canonical WAV bytes exactly as the trait requires (concat_wav compatibility). Includes the real-model `--ignored` test.

**Work:**
- [ ] `crates/synth/src/sherpa_runner.rs` — `SherpaRunner::new(voice_model: &Path)` loads the ONNX model (+ its sibling `.json` config, same layout convention as the subprocess path); `impl PiperRunner` → WAV bytes (mono 16-bit; sample rate from the model, serialized into a canonical WAV header)
- [ ] Feature `sherpa` in `crates/synth/Cargo.toml`; module doc states the feature + the linking requirements from T1's verdict
- [ ] Hermetic tests where possible (WAV-header shape from a stubbed synthesis call if the API allows; at minimum construction/error paths) — compile-gated `#[cfg(all(test, feature = "sherpa"))]`
- [ ] `--ignored` real-model test: seed-cache voice → one paragraph → WAV parses (`pcm::concat_wav` accepts it), non-trivial duration, deterministic-ish length bounds
- [ ] Per-thread cost note: rayon constructs one runner per thread (`make_runner`) — measure 2- and 4-thread RSS with T1's numbers; record recommended default jobs for the native engine (feeds T5)
- [ ] Typed errors: map sherpa failures into `SynthError` variants (no new error type leaking sherpa details)

**Acceptance:**
- [ ] `cargo build --workspace` (features off) unchanged; `cargo build -p taletrek-synth --features sherpa` compiles clean
- [ ] `--ignored` sherpa test green with the seed-cache voice
- [ ] Trait signature untouched; clippy `-D warnings` clean both feature states
- [ ] Memory/jobs note recorded in this file

**Verify:** `cargo test -p taletrek-synth --features sherpa` + `-- --ignored` (needs seeded voice); `cargo clippy --workspace --all-targets -- -D warnings` with and without the feature.

**Dependencies:** T1
**Files:** `crates/synth/src/sherpa_runner.rs`, `crates/synth/src/lib.rs`, `crates/synth/Cargo.toml`
**Docs:** module doc is the linking gotcha's home if T1 found traps
**Estimated scope:** M
