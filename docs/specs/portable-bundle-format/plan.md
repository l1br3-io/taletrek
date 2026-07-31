# Plan — Effort 1: Portable Bundle Format + Rust synth crate

> Spec: [`spec.md`](./spec.md) · Format: [`../../bundle-format.md`](../../bundle-format.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> The Problem / Decisions / Architecture live in [`spec.md`](./spec.md); this file holds the build plan only.

## Phases

### Phase 1 — Workspace + toolchain skeleton [infra, XS, low risk]

**Files:**
- `Cargo.toml` (NEW, repo root) — workspace, `members = ["crates/*"]`, shared `[workspace.package]` metadata.
- `rust-toolchain.toml` (NEW) — pin stable 1.97.
- `.gitignore` — add `target/`, `*.taletrek` dev artifacts outside fixtures.
- `crates/synth/Cargo.toml` (NEW) — `taletrek-synth`, edition 2024, deps: `serde`, `serde_json`, `sha2`, `zip`, `thiserror`. Dev-deps: `tempfile`.
- `crates/synth/src/lib.rs` (NEW, stub) — module declarations only.

**Done when:** `cargo build` in the workspace succeeds with an empty crate.

---

### Phase 2 — Manifest + text model + typed errors [data model, S, low risk]

**Files:**
- `crates/synth/src/bundle/mod.rs`
- `crates/synth/src/bundle/manifest.rs` — `Manifest`, `BookMeta`, `AudioMeta`, `Generator`, `schemaVersion = 1` constant, version check.
- `crates/synth/src/bundle/text.rs` — `ChapterText` mirroring the SPA `Chapter` (id, bookId, index, title, paragraphs, headings).
- `crates/synth/src/bundle/error.rs` — `BundleError` (thiserror): `UnknownSchema { found, supported }`, `MissingEntry { name }`, `Corrupt { source }`, `Io`, `Json`.

**Done when:** structs (de)serialize the manifest shapes from `bundle-format.md`; unknown `schemaVersion` returns `UnknownSchema`.

---

### Phase 3 — Normalization + cache-key parity [parity-critical, M, high risk]

**Files:**
- `crates/synth/src/normalize.rs` — port of SPA `normalizeForSpeech` + `splitForSpeech` (`web/src/lib/tts/normalize.ts`).
- `crates/synth/src/cache_key.rs` — `cache_key(voice, text) -> String` producing `${voice}:${NORM_VERSION}:${sha256(normalized)}`.
- `crates/synth/tests/normalize_parity.rs` — **port the SPA's `normalize.test.ts` cases**, same inputs → same outputs.
- `crates/synth/tests/cache_key_parity.rs` — fixed (voice, text) pairs with the expected SHA-256, lifted from the SPA's `audio-cache.test.ts` expectations.

**Done when:** every SPA normalize test case passes in Rust; the cache key for a canonical sample matches the SPA byte-for-byte. *This is the single highest-risk phase — it gates dedup correctness across all three apps.*

**De-risk:** read the SPA normalize module first (`web/src/lib/tts/normalize.ts`) and replicate its exact Unicode/sentence-boundary behavior before writing anything else.

---

### Phase 4 — Bundle read/write (text-only first) [I/O, M, medium risk]

**Files:**
- `crates/synth/src/bundle/io.rs` — `write_book_bundle`, `read_book_bundle` using the `zip` crate. Writes `manifest.json` + `text.json` (no `audio/`). Reads both states.
- `crates/synth/tests/bundle_round_trip.rs` — write a text-only bundle → read it back → assert manifest + chapters equal.

**Done when:** text-only round-trip passes.

---

### Phase 5 — Audio segments in bundles [I/O, S, low risk]

**Files:**
- `crates/synth/src/bundle/audio.rs` — `AudioSegment { key, codec, bytes }`; `write_book_bundle` accepts an optional `HashMap<key, AudioSegment>` and emits `audio/<key>.<ext>`.
- Extend `bundle_round_trip.rs` — full bundle (with fake audio bytes) round-trips; codec recorded in manifest; content-addressed names preserved.

**Done when:** full bundle round-trip passes with Opus + M4A codecs.

---

### Phase 6 — Library bundle [I/O, S, low risk]

**Files:**
- `crates/synth/src/bundle/library.rs` — `LibraryBundle`, `write_library_bundle`, `read_library_bundle` (ZIP of `library-manifest.json` + `books/<id>.taletrek`).
- Extend round-trip tests — multi-book library round-trips.

**Done when:** library round-trip passes.

---

### Phase 7 — Synthesis pipeline (piper subprocess + encode) [compute, M, medium risk]

**Files:**
- `crates/synth/src/synth.rs` — `PiperRunner` trait + `SubprocessPiperRunner` (shells out to `piper --model ... --output_raw`); injectable for tests.
- `crates/synth/src/encode.rs` — `Encoder` trait + Opus impl (`audiopus` or ffmpeg subprocess behind the trait). WAV passthrough for unit tests.
- `crates/synth/src/lib.rs` — `synthesize_paragraph(voice, text) -> SynthOutput` wiring: normalize → split → piper per chunk → concat WAV → encode Opus.
- `crates/synth/tests/synth_integration.rs` — `#[ignore]` test requiring `piper` on PATH; stubbed unit test covers the trait seam with a fake runner.

**Done when:** stubbed unit test passes (trait seam works); `cargo test -- --ignored` passes when `piper` is installed.

---

### Phase 8 — Conformance fixtures [quality gate, S, low risk]

**Files:**
- `crates/synth/tests/fixtures/` — generate `book-text-only.taletrek`, `book-full.taletrek`, `library.taletrek-lib` via a small `examples/gen_fixtures.rs`.
- Document in `docs/bundle-format.md` that these three are the canonical conformance set effort 3 must read.

**Done when:** fixtures committed; a `read_*` test loads each fixture and asserts its manifest fields.

---

### Phase 9 — Lint + clippy + final verify [gate, XS, low risk]

**Done when:** `cargo clippy -p taletrek-synth -- -D warnings` and `cargo test -p taletrek-synth` are green; `pnpm verify` is green (no TS touched).

## Rough effort

| Phase | Effort | Risk |
| --- | --- | --- |
| 1. Workspace skeleton | XS | Low |
| 2. Manifest + text model | S | Low |
| 3. Normalize + cache-key parity | M | **High** — gates cross-language dedup |
| 4. Bundle I/O (text-only) | M | Medium |
| 5. Audio segments | S | Low |
| 6. Library bundle | S | Low |
| 7. Synth pipeline | M | Medium — native deps |
| 8. Conformance fixtures | S | Low |
| 9. Lint + verify | XS | Low |

**Total: M-sized foundation effort.** Phase 3 is the make-or-break; it gets the most review attention.

## Validation gates (recap)

- `cargo test -p taletrek-synth` green (incl. round-trip + parity tests).
- `cargo clippy -p taletrek-synth -- -D warnings` clean.
- Cache-key parity test green vs SPA expectations.
- `pnpm verify` green (web untouched).
