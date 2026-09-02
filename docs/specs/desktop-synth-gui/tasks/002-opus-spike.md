# T2 — native Opus spike: crate verdict

**Description:** Timeboxed throwaway validation of in-process Opus encode. The original reason the ffmpeg subprocess won was libopus dev-header linking in the pinned toolchain (`crates/synth/src/encode.rs` module docs) — this spike answers whether a safe binding with a vendored/static build clears that bar today. Deliver: crate choice (`audiopus` vs `opus`), static-link proof, and a WAV→Opus/OGG round-trip via the `ogg` crate matching the current ffmpeg output's container shape (OGG/Opus, `.opus`).

**Work:**
- [x] Throwaway example (same rules as T1 — outside the workspace default build)
- [x] Encode synthetic PCM (16 kHz mono, the Piper shape — see `pcm.rs`) → Opus → OGG container
- [x] Decode round-trip (libopus decoder or ffprobe locally) — audio sane, duration close to source
- [x] Confirm output structure matches what `OpusEncoder` (ffmpeg `-c:a libopus`, OGG) produces well enough for the reader's Web Audio path (same codec, same container)
- [x] Measure build impact: does the vendored build need cmake/pkg-config at compile time? Static or dynamic libopus? Record in this file
- [x] Record verdict: crate, feature flags, build deps, bitrate control (must support the 24 kbps default)

**Acceptance:**
- [x] Verdict recorded: crate + features + link strategy + build-deps list
- [x] Round-trip proof pasted in this file
- [x] ~~If both candidates fail~~ — PASS (no fallback needed) static linking: stop, surface to human (documented fallback = GUI keeps ffmpeg for encode only — ask-first decision, per plan risk table)

**Verify:** spike runs, round-trip output verified, findings in this file. Workspace gates unchanged.

**Dependencies:** None (parallelizable with T1)
**Files:** spike code (throwaway), this file
**Docs:** findings inline here
**Estimated scope:** S

---

## Verdict (2026-09-02, Rust 1.97.0, Linux x86_64) — **PASS**

### Crate: `opus` 0.4.0 (`bundled` — which is opusic-sys's *default*) — chosen over `audiopus` 0.3.0-rc.0

| | `opus` 0.4.0 (SpaceManiac) | `audiopus` 0.3.0-rc.0 (lakelezz) |
| --- | --- | --- |
| sys layer | `opusic-sys` 0.7.x (DoumanAsh, actively maintained) → **`bundled` is the default feature**: vendors libopus **1.6.1**, built via cmake | `audiopus_sys` 0.2.2 — **defaults to dynamic pkg-config linking on Linux gnu** (the exact system-libopus trap `encode.rs` was written to avoid); vendored path also exists, also cmake |
| version | stable 0.4.0, MIT/Apache-2.0 | RC since ~2021, ISC |
| bitrate ctl | `set_bitrate(Bitrate::Bits(24_000))` ✓ | equivalent, RC API |

### Link strategy + build deps

- **Static, vendored**: no system libopus, no dev headers, no pkg-config, no bindgen. Build-time deps: **cmake + a C compiler** (only for the bundled build; cached after first compile). This is the one build dep the sherpa spike didn't have — CI needs cmake present (standard in GH Actions images).
- `ldd` proof: binary links only `libgcc_s/libm/libc` — no libopus, not even libstdc++ (libopus is C). Size cost ≈ **0.5 MB** (spike binary 1.1 MB total) — trivial next to sherpa-onnx's 36 MB.
- Container mux: **`ogg` 0.9.2** (pure Rust, BSD-3, `#![forbid(unsafe_code)]`) — `PacketWriter` takes packets; BOS inferred, serial ours.

### Round-trip proof (all asserts live in `spike/opus/src/main.rs`, green)

```
libopus: libopus 1.6.1
source: 48000 samples (3.0 s of 440 Hz sine, 16 kHz mono i16 — the Piper shape), 96044 WAV bytes
encoded: 150 packets × 20 ms, 9353 OGG bytes ≈ 25 kbps incl. container   ← 24 kbps target honored
round-trip (in-crate demux+decode): 48000 samples decoded (3.000 s), tone 440.7 Hz, peak/RMS sane
external: ffmpeg -f null - decodes spike.opus cleanly
```

### Container parity vs `OpusEncoder` (ffmpeg `-c:a libopus -b:a 24k -f opus`)

| | native spike | ffmpeg reference |
| --- | --- | --- |
| ffprobe codec | `opus` | `opus` |
| ffprobe format | `ogg` | `ogg` |
| channels / rate | mono / 48000 (Opus always decodes at 48k) | mono / 48000 |
| duration | 3.002 s | 3.007 s |
| bit_rate | **24 923** | 36 840 (ffmpeg VBR overshoots the same `-b:a 24k` flag) |

Same codec, same container, same channel shape → the reader's Web Audio path sees an equivalent file. Granule math verified by duration (preskip = `get_lookahead()` @48 kHz domain + 960 granules per 20 ms frame).

### Gotchas for T4 (production `NativeOpusEncoder`)

1. **The final OGG packet must carry `EndStream`** — `ogg::PacketWriter` silently drops an unflushed page in `into_inner()` (live RED→GREEN in this spike: 3.0 s of whole frames left no "partial tail" branch to end the stream).
2. OGG/Opus mux is manual but small: `OpusHead` (input rate advisory — all granules are 48 kHz domain) + `OpusTags` page, then audio pages; preskip = encoder lookahead as returned (already 48k-domain).
3. Opus encodes whole frames only — pad a partial final 20 ms frame (320 samples @16k) with silence.
4. **Sample rate comes from the WAV `fmt` chunk, not a constant** — pcm.rs docs say 16 kHz but T1 measured our actual Piper voices at 22050; the encoder must read it (Opus accepts 8/12/16/24/48 kHz input; 22050 → use 24000 Hz encoder rate? No — libopus accepts arbitrary input rates? It accepts 8/12/16/24/48k officially; 22050 gets internally resampled if passed via the opusenc API path — T4 must resample 22050→24000 or encode at the closest supported rate; note for T4 to validate with a real 22050 Piper WAV, not just synthetic 16k).
5. `Encoder` is `Send` (crate-provided) — fine for per-rayon-thread use.

### Reproduce

```
cd spike/opus
cargo run --release          # in-crate round-trip asserts + writes out/{source.wav,spike.opus,decoded.wav}
# then: ffprobe out/spike.opus; ffmpeg -i out/source.wav -c:a libopus -b:a 24000 -f opus out/ffmpeg.opus
```

Standalone cargo project (own `[workspace]` marker) — invisible to `cargo build --workspace` at the repo root (re-verified green after the spike landed).
