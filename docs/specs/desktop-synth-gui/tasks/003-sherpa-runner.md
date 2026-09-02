# T3 — `SherpaRunner` behind feature `sherpa`

**Description:** Production in-process TTS runner implementing the existing `PiperRunner` trait (`crates/synth/src/synth.rs`), behind cargo feature `sherpa` per the spec. Model loads once per runner at construction; `predict` returns canonical WAV bytes exactly as the trait requires (concat_wav compatibility). Includes the real-model `--ignored` test.

**Work:**
- [x] `crates/synth/src/sherpa_runner.rs` — `SherpaRunner::new(voice_model: &Path)` loads the ONNX model (+ its sibling `.json` config, same layout convention as the subprocess path); `impl PiperRunner` → WAV bytes (mono 16-bit; sample rate from the model, serialized into a canonical WAV header)
- [x] Feature `sherpa` in `crates/synth/Cargo.toml`; module doc states the feature + the linking requirements from T1's verdict
- [x] Hermetic tests where possible (WAV-header shape from a stubbed synthesis call if the API allows; at minimum construction/error paths) — compile-gated `#[cfg(all(test, feature = "sherpa"))]`
- [x] `--ignored` real-model test: seed-cache voice → one paragraph → WAV parses (`pcm::concat_wav` accepts it), non-trivial duration, deterministic-ish length bounds
- [x] Per-thread cost note: rayon constructs one runner per thread (`make_runner`) — measure 2- and 4-thread RSS with T1's numbers; record recommended default jobs for the native engine (feeds T5)
- [x] Typed errors: map sherpa failures into `SynthError` variants (no new error type leaking sherpa details)

**Acceptance:**
- [x] `cargo build --workspace` (features off) unchanged; `cargo build -p taletrek-synth --features sherpa` compiles clean
- [x] `--ignored` sherpa test green with the seed-cache voice
- [x] Trait signature untouched; clippy `-D warnings` clean both feature states
- [x] Memory/jobs note recorded in this file

**Verify:** `cargo test -p taletrek-synth --features sherpa` + `-- --ignored` (needs seeded voice); `cargo clippy --workspace --all-targets -- -D warnings` with and without the feature.

**Dependencies:** T1
**Files:** `crates/synth/src/sherpa_runner.rs`, `crates/synth/src/lib.rs`, `crates/synth/Cargo.toml` (+ `SynthError::VoiceLoad` variant in `synth.rs`; infra: `justfile` test-e2e + `scripts/setup-native.sh` seed espeak-ng-data)
**Docs:** module doc is the linking gotcha's home if T1 found traps
**Estimated scope:** M

---

## Notes (landed 2026-09-02)

### Memory/jobs note (feeds T5)

From T1's measurements (this machine): baseline 21.3 MB RSS; first loaded model **+237 MB** (includes one-time ~26 MB onnxruntime arena init); each additional model **+212 MB** steady-state. N parallel runners ≈ `237 + 212·(N−1)` MB:

| native-engine jobs | RSS (approx) |
| --- | --- |
| 2 | ~470 MB (measured with 2 models) |
| 4 | ~870 MB |
| 8 | ~1.7 GB (too much for a default) |

**Recommended default for the native engine: `jobs = 2`** (≈470 MB, leaves headroom for egui + encode on 4–8 GB machines); `--jobs` overrides upward. The subprocess engine's `num_cpus` default is unaffected (stateless runner).

### Wiring hazard for T5 — `make_runner` is per *paragraph*, not per thread

The plan (and this task's original wording) assumed rayon constructs one runner per thread. **It doesn't**: `crates/worker/src/synth_job.rs` calls `make_runner()` once per **paragraph** (fine for the stateless subprocess runner — each `predict` spawns a process anyway). Each `SherpaRunner::new` costs ~1 s model load **plus** a 63 MB stamped copy when the cached model lacks ONNX metadata (see below). T5 must hoist runner construction out of the per-paragraph closure (per-thread cache or a worker signature change) **before** flipping the native default; a naive `|| SherpaRunner::new(...)` would reload the model for every paragraph in the book.

### Metadata stamping decision (T1's deferred "T3/T8 decision") — resolved here

The runner itself bridges metadata-less cached models (the diffusionStudio-mirror files `resolve_voice` seeds): when the `.onnx` carries no `sample_rate` metadata, the runner **append-stamps** the full k2-fsa metadata set (7 entries — `model_type`, `comment`, `language`, `voice`, `has_espeak`, `n_speakers`, `sample_rate`; every value derived from the sibling `.onnx.json`) into a **temp-dir copy** — pure-Rust protobuf append, no new deps, the cached file is never mutated. Verified live against the seed-cache voice (the bytes: diffusionStudio files have zero metadata; k2-fsa's differ by exactly the +131 B append). Models that already carry metadata (k2-fsa mirrors — where T8 may move the catalog) pass through zero-copy and the stamp path goes dormant.

### Other implementation notes

- `OfflineTts` is `unsafe impl Send + Sync` in the crate → `SherpaRunner` satisfies worker's `R: PiperRunner + Send` bound as-is (verified against the 1.13.7 source).
- `predict` strips interior NUL bytes before generate (sherpa's `CString::new` panics on them; `normalize_for_speech` doesn't remove NULs).
- `predict` ignores the trait's per-call `voice_model` (model is fixed at construction — that's the whole point of the runner); `debug_assert` catches mis-wiring.
- `OfflineTts::create` is wrapped in `catch_unwind` + `None`-check → both load-failure modes map to `SynthError::VoiceLoad`; generate failures reuse `SynthError::Predict` (`bin: "sherpa-onnx"`), silent output reuses `SynthError::EmptyOutput`. No sherpa types leak past `SynthError`.
- espeak-ng-data home: `~/.cache/taletrek/espeak-ng-data` (`default_espeak_data_dir()`; `SherpaRunner::with_espeak_data` for explicit control). `scripts/setup-native.sh` now copies it out of the piper tarball it already downloads; `just test-e2e` wires `TALETREK_ESPEAK_DATA` + `--features taletrek-synth/sherpa`.
