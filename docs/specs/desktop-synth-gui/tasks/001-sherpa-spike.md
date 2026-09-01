# T1 — sherpa-onnx spike: crate verdict

**Description:** Timeboxed throwaway validation of in-process TTS before any production code (mirrors kernel-parse's PDF spike). Answer: which crate (`sherpa-onnx` vs `sherpa-rs`), does it link in our pinned toolchain (Rust 1.97, Linux), can it load a Piper voice model and synthesize one paragraph to WAV, and what does the model load cost (time + memory)? The verdict unblocks T3 and feeds the spec's Technologies table.

**Work:**
- [x] Throwaway example/bin (under `spike/sherpa/` or `examples/` — NOT wired into the workspace build) using the candidate crate
- [x] Load `en_US-hfc_female-medium` from the seeded cache (`~/.cache/taletrek/voices/`) — same models the subprocess path uses today
- [x] Synthesize one short paragraph → assert WAV bytes (RIFF header, sample rate 22050)
- [x] Measure: model-load time, RSS with 1 vs 2 loaded models (per-thread cost model for rayon)
- [x] Record verdict in this file: crate choice, linking strategy (static/dynamic onnxruntime, build deps needed: cmake? libclang?), license confirmed Apache-2.0, per-model memory number

**Acceptance:**
- [x] Verdict recorded: crate + linking strategy + memory number + any gotcha
- [x] Spike code compiles and runs on this machine; does NOT join the workspace default build
- [x] ~~If both candidates fail~~ — PASS (no fallback needed)

**Verify:** spike runs, numbers pasted in this file. No workspace gates affected (`cargo build --workspace` unchanged).

**Dependencies:** None (parallelizable with T2)
**Files:** spike code (throwaway), this file
**Docs:** findings inline here; gotcha only if a linking trap survives to production code (T3's call)
**Estimated scope:** S

---

## Verdict (2026-09-02, Rust 1.97.0, Linux x86_64) — **PASS**

### Crate: `sherpa-onnx` 1.13.7 (official k2-fsa) — chosen over `sherpa-rs` 0.6.8

Both wrap the same sherpa-onnx C API and download the same k2-fsa prebuilt archives; the official crate wins on every practical axis:

| | `sherpa-onnx` 1.13.7 (k2-fsa) | `sherpa-rs` 0.6.8 (thewh1teagle) |
| --- | --- | --- |
| Bindings | pre-generated — no bindgen | bindgen at build (needs **libclang**) unless `SHERPA_SKIP_GENERATE_BINDINGS=1` |
| Upstream version | tracks releases exactly (1.13.7 = current) | pins upstream **v1.12.9** (`dist.json`) |
| Load-failure handling | `OfflineTts::create → Option` (null-checked) | `VitsTts::new` stores unchecked null ptr → **segfault** on failed load |
| Linux static | links into default PIE, no RUSTFLAGS | build.rs **panics** unless `RUSTFLAGS=-C relocation-model=dynamic-no-pic` |
| License | Apache-2.0 ✓ (confirmed; MIT-compatible use) | MIT bindings (upstream Apache-2.0) |

### Linking strategy: **static** (the crate's default feature)

- Downloads `sherpa-onnx-v1.13.7-linux-x64-static.tar.bz2` from k2-fsa GitHub releases into `target/sherpa-onnx-prebuilt/` (cached; offline builds via `SHERPA_ONNX_ARCHIVE_DIR` / `SHERPA_ONNX_LIB_DIR`).
- Statically links `sherpa-onnx-c-api` + `onnxruntime` + `espeak-ng` + `piper_phonemize` (+ deps). Resulting binary keeps only system `libstdc++/libm/libgcc_s/libc` (`ldd`-verified). Spike release binary: **36 MB**.
- **Build deps needed: none** — no cmake, no libclang, no system onnxruntime. Cargo + network on first build only.

### Numbers (this machine)

| Metric | Value |
| --- | --- |
| Model load (medium voice, 63 MB onnx) | **~1.0 s** (0.95 / 1.02 s across runs) |
| Synth, 1 thread | 661–701 ms for ~9 s audio → **~13× realtime** per thread |
| RSS baseline | 21.3 MB |
| RSS with 1 model | 258.7 MB (**+237** — includes one-time onnxruntime arena init ≈ 26 MB) |
| RSS with 2 models | 470.4 MB (**+212 per additional model**, steady-state) |
| WAV output | 22050 Hz mono PCM16 — asserted in-code (RIFF/WAVE/fmt byte parse) **and** ffprobe-verified (`pcm_s16le,22050,1`) |

**Rayon cost model for T5:** each parallel runner costs ~212 MB → clamp native-engine default jobs (4 jobs ≈ 850 MB; 8 ≈ 1.7 GB — too much for a default).

### Bridging our cached Piper voices into sherpa (feeds T3/T8)

1. **`tokens.txt` is derivable from the cached `.onnx.json`** — `phoneme_id_map` rendered as `<symbol> <ids[0]>` per line is **byte-identical** to k2-fsa's shipped tokens.txt (verified by diff for hfc_female). No extra per-voice download for tokens.
2. **`espeak-ng-data` required at runtime** (`data_dir` config) — 19 MB, voice-independent, from piper releases. One shared download/copy, reused by every voice (bundle with the app or fetch once at first voice acquire).
3. **GOTCHA — ONNX metadata:** sherpa's VITS init requires a `sample_rate` custom-metadata entry. The diffusionStudio-mirror files our cache seeds **lack it** (live RED: `'sample_rate' does not exist in the metadata`, then green with the stamped file). k2-fsa's `vits-piper-*` HF mirrors carry it (same weights + ~131 B metadata). **T3/T8 decision:** fetch voice models from k2-fsa mirrors instead of diffusionStudio, or stamp metadata at acquire time.
4. Inference params (noise/length scales) come from the `.onnx.json`, not the model — read them there (spike does).
5. Kokoro loads through the same `OfflineTts` API (`OfflineTtsKokoroModelConfig` exists in-crate); not exercised here — catalog curation is a later effort regardless.

### Reproduce

```
cd spike/sherpa
./fetch-assets.sh   # espeak-ng-data + metadata-stamped copies of the 2 seeded voices
cargo run --release # loads both voices, asserts WAV bytes, prints timings + RSS
```

Spike is a standalone cargo project (own `[workspace]` marker) — `cargo build --workspace` at the repo root does not see it (verified green after the spike landed).
