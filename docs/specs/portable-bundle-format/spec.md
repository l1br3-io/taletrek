---
status: active
started: 2026-07-31
---

# SPEC — Off-device synth track · Effort 1: Portable Bundle Format + Rust synth crate

> Track ADR: [`docs/adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
> Format spec: [`docs/bundle-format.md`](../../bundle-format.md)
> First of four efforts: **1. portable-bundle-format** (this) → 2. desktop-synth-app → 3. spa-bundle-import-export → 4. personal-server.

## Problem

Synthesis is the most painful part of TaleTrek. It runs entirely on-device (Piper-via-WASM in Web Workers; the upload manager even holds a screen wake lock). iOS freezes background tabs within seconds, so synth stops the moment the user switches apps — and does not progress while the app is closed. M11 made it *resumable*, not *backgroundable*.

The agreed direction (ADR-0013) is to move synthesis off the SPA onto standalone Rust apps, and to interchange books as portable files. Before any of those apps can exist, we need **(a) the interchange format** and **(b) the reusable Rust synth pipeline** that all of them will share. This effort delivers both — and nothing else. No app ships here.

## Scope (this effort only)

Deliver the foundation that efforts 2–4 depend on:

1. **The `.taletrek` bundle format** — specified in [`docs/bundle-format.md`](../../bundle-format.md) (done as part of this effort's DEFINE), and implemented as a Rust library.
2. **The `crates/synth` Rust crate** — the reusable core: clean → call native `piper` → encode (Opus) + read/write book & library bundles.
3. **A conformance fixtures set** — so the future TS implementation (effort 3) can prove byte-compatibility against the same archives.
4. **The Cargo workspace skeleton** — root `Cargo.toml`, `crates/synth/`, `rust-toolchain.toml`.

## Decisions (locked)

| Area | Decision |
| --- | --- |
| Container | **ZIP** (deflate). Natively readable in Rust (`zip`), JS (`fflate`), and browsers. Not tar/gz. |
| Audio codec | **Opus default** (best size/quality for speech). M4A permitted (iOS-native). WAV permitted, discouraged. |
| Audio naming | **Content-addressed**: `${voiceId}:${NORM_VERSION}:${sha256(normalizedText)}` — identical to the SPA's existing `audioCache` key. Dedups on import for free. |
| Manifest | **Versioned** (`schemaVersion: 1`). Unknown fields ignored on read; unknown major version refused with a typed error. |
| Bundle states | **Text-only and full travel in the same container.** `manifest.audio.present` distinguishes them. |
| Synth pipeline | **Native `piper` subprocess**, not ONNX-Runtime-in-Rust. Piper ships as a binary; we shell out. Keeps the crate small and avoids re-solving phonemize/espeak (gotchas G1). |
| Normalization | **Port the SPA's `normalizeForSpeech` + `splitForSpeech`** to Rust so cache keys match byte-for-byte. This is the load-bearing parity point. |
| Parsing | **Out of scope.** The crate takes *text* (from a bundle), never a raw PDF/EPUB/MOBI. v1 desktop is bundles-only (ADR-0013). |
| Workspace | **Cargo workspace at repo root** (`members = ["crates/*"]`). pnpm workspace untouched. |
| Toolchain pin | **`rust-toolchain.toml`** pins the stable channel — matches the repo's "pin things that bite" ethos (G1). |

## Architecture

```
taletrek/                         # repo root
  Cargo.toml                      # NEW — workspace root
  rust-toolchain.toml             # NEW — pinned stable
  crates/
    synth/                        # NEW — this effort's deliverable
      Cargo.toml
      src/
        lib.rs                    # public API re-exports
        normalize.rs              # port of normalizeForSpeech/splitForSpeech (parity-critical)
        synth.rs                  # piper subprocess wrapper → WAV
        encode.rs                 # WAV → Opus (ffmpeg or opus codec crate)
        bundle/
          mod.rs                  # read_book / write_book / read_library / write_library
          manifest.rs             # Manifest, BookMeta, AudioMeta structs (serde)
          text.rs                 # text.json chapter model (mirrors SPA Chapter)
          error.rs                # BundleError (typed: UnknownSchema, MissingText, …)
        cache_key.rs              # sha256(normalizedText) key derivation (parity with audio-cache.ts)
      tests/
        bundle_round_trip.rs      # write → read → assert equal, text-only + full
        fixtures/                 # canonical archives both Rust + TS must read
          book-text-only.taletrek
          book-full.taletrek
          library.taletrek-lib
  docs/
    bundle-format.md              # canonical format spec (delivered this effort)
    adrs/0013-…                   # track ADR (delivered this effort)
    specs/portable-bundle-format/ # this dir
```

### Public crate surface (v0.1)

```rust
// Synthesis pipeline
pub fn synthesize_paragraph(voice: &VoiceId, text: &str) -> Result<SynthOutput, SynthError>;
pub fn clean_and_split(text: &str) -> Vec<String>;        // parity w/ SPA normalize

// Bundle I/O
pub fn write_book_bundle(book: &BookBundle, out: &mut impl Write) -> Result<(), BundleError>;
pub fn read_book_bundle(input: &[u8]) -> Result<BookBundle, BundleError>;
pub fn write_library_bundle(lib: &LibraryBundle, out: &mut impl Write) -> Result<(), BundleError>;
pub fn read_library_bundle(input: &[u8]) -> Result<LibraryBundle, BundleError>;

pub struct BookBundle { pub manifest: Manifest, pub chapters: Vec<Chapter>, pub audio: HashMap<String, AudioSegment> }
```

## Non-goals (this effort)

- **No app.** No desktop binary, no server, no SPA changes. Those are efforts 2–4.
- **No raw-file parsing** in Rust (PDF/EPUB/MOBI). The crate ingests text from bundles only.
- **No TS implementation** of the format — that is effort 3. This effort ships only the Rust side + the format doc + fixtures.
- **No audio playback.** The crate produces Opus bytes; it does not play them.
- **No voice-model management beyond a cache dir.** Piper `.onnx` voice files are downloaded/cached on disk; a curated voice list mirrors the SPA's `CURATED_VOICES`.

## Validation gates

- `cargo test -p taletrek-synth` green, including round-trip tests for text-only, full, and library bundles.
- `cargo build -p taletrek-synth` clean with no warnings on the pinned toolchain.
- `cargo clippy -p taletrek-synth -- -D warnings` clean.
- **Parity spot-check:** the cache key derived in Rust for a fixed sample text + voice **matches byte-for-byte** the key the SPA's `audioCacheKey` produces. This is the single highest-risk correctness point and gets its own test.
- The three fixtures under `tests/fixtures/` are produced by this crate and committed; effort 3's TS implementation must read them unchanged.
- `pnpm verify` stays green (this effort touches no TS, so it should be a no-op for the web build).

## Risks

| Risk | Mitigation |
| --- | --- |
| **Cache-key drift** Rust↔TS breaks dedup. | Dedicated parity test; pin `NORM_VERSION`; fixtures encode known (text → key) pairs. |
| **Normalization port** is non-trivial (Unicode, sentence splitting). | Port unit-for-unit; lift the SPA's test cases (`normalize.test.ts`) into Rust tests with the same inputs/outputs. |
| **Piper binary dependency** complicates CI. | Synth tests that need real audio are gated behind a `#[ignore]` integration test requiring `piper` on `PATH`; unit tests stub the subprocess via an injectable `PiperRunner` trait. |
| **Opus encoding** adds a native dep (libopus/ffmpeg). | Use the `audiopus` / pure-Rust option first; fall back to an `ffmpeg` subprocess only if needed. Encoding is behind a trait so the host app chooses. |

## Open implementation notes (not blockers)

- The exact Opus crate choice (`audiopus` vs `opus-rs` vs ffmpeg) is decided in the build phase by what compiles cleanly on the pinned toolchain.
- Whether `piper` is invoked as a subprocess or via the `piper-rs`/ONNX binding is decided in the build phase; subprocess is the default for simplicity.
