# T4 — `NativeOpusEncoder` behind feature `native-encode`

**Description:** Production in-process Opus encoder implementing the existing `Encoder` trait (`crates/synth/src/encode.rs`), behind cargo feature `native-encode`, per T2's verdict. WAV in → OGG/Opus bytes out; same codec identity as the ffmpeg encoder so bundles are indistinguishable at the format level.

**Work:**
- [ ] `crates/synth/src/opus_native.rs` — `NativeOpusEncoder` (default bitrate matching the current 24 kbps default; builder for bitrate if trivial); `impl Encoder` returning `AudioCodec` identical to the ffmpeg encoder's
- [ ] WAV parse (reuse `pcm.rs` helpers) → frame-sized Opus packets → `ogg` crate mux
- [ ] Feature `native-encode` in `crates/synth/Cargo.toml`; module doc carries the linking requirements from T2's verdict
- [ ] Hermetic tests: synthetic PCM → encode → assert OGG magic (`OggS`), page structure, OpusHead sample rate; decode round-trip via libopus decoder if the chosen crate exposes one, else length/duration heuristics
- [ ] `--ignored` comparison test (local ffmpeg allowed): native vs ffmpeg output both decode to similar durations; **no bit-exactness requirement** (keys are text-derived)

**Acceptance:**
- [ ] `cargo build --workspace` (features off) unchanged; with `--features native-encode` compiles clean
- [ ] Hermetic tests green without any binary on PATH
- [ ] Trait untouched; clippy `-D warnings` both feature states
- [ ] A native-encoded segment plays in the web reader (quick manual check or the T5 parity test covers it)

**Verify:** `cargo test -p taletrek-synth --features native-encode`; clippy both states.

**Dependencies:** T2
**Files:** `crates/synth/src/opus_native.rs`, `crates/synth/src/lib.rs`, `crates/synth/Cargo.toml`
**Docs:** module doc carries the static-link gotcha home
**Estimated scope:** M
