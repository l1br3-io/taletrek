# TODO — Effort 1: Portable Bundle Format + Rust synth crate

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 1 — Workspace skeleton
- [x] Root `Cargo.toml` (workspace, `members = ["crates/*"]`)
- [x] `rust-toolchain.toml` (pin stable 1.97)
- [x] `.gitignore` += Rust (`target/`) + bundle artifacts (fixtures excluded)
- [x] `crates/synth/Cargo.toml` + `src/lib.rs`
- [x] `cargo build` green

## Phase 2 — Manifest + text model + errors
- [x] `bundle/manifest.rs` (`Manifest`, `BookMeta`, `AudioMeta`, `Generator`, `SCHEMA_VERSION = 1`)
- [x] `bundle/text.rs` (`ChapterText` mirroring SPA `Chapter`)
- [x] `bundle/error.rs` (`BundleError` via thiserror)
- [x] Unit tests: unknown schema version → typed error

## Phase 3 — Normalize + cache-key parity (HIGH RISK) ✅ GATE PASSED
- [x] Read SPA `web/src/lib/tts/normalize.ts` + `audio-cache.ts` key derivation
- [x] Port `normalizeForSpeech` + `splitForSpeech` → `normalize.rs`
- [x] `cache_key.rs` → `${voice}:${NORM_VERSION}:${sha256(normalized)}`
- [x] Port SPA `normalize.test.ts` cases → Rust unit tests
- [x] Cache-key parity test with **hardcoded SPA-matching SHA-256** (`tests/cache_key_parity.rs`)
- [x] **GATE:** byte-for-byte key match on canonical sample (verified: `aa3ec16e…`, `5835dab3…`, `c86cfd5d…`)

## Phase 4 — Bundle I/O (text-only)
- [x] `bundle/io.rs` — `write_book_bundle` / `read_book_bundle` (`zip` crate)
- [x] Round-trip test: text-only bundle

## Phase 5 — Audio segments
- [x] `bundle/audio.rs` — `AudioSegment { key, codec, bytes }`
- [x] `write_book_bundle` optional audio map → `audio/<key>.<ext>`
- [x] Round-trip test: full bundle (Opus)

## Phase 6 — Library bundle
- [x] `bundle/library.rs` — `LibraryBundle`, read/write
- [x] Round-trip test: multi-book library

## Phase 7 — Synth pipeline (NEXT — deferred to its own checkpoint)
- [ ] `PiperRunner` trait + `SubprocessPiperRunner`
- [ ] `Encoder` trait + Opus impl (audiopus or ffmpeg behind trait)
- [ ] `synthesize_paragraph(voice, text)` wiring
- [ ] Stubbed unit test (trait seam); `#[ignore]` real-piper integration test
- [ ] Note: requires `piper` binary on PATH; medium risk (native deps)

## Phase 8 — Conformance fixtures ✅
- [x] `examples/gen_fixtures.rs` → 3 fixtures under `tests/fixtures/`
- [x] `tests/fixtures_conformance.rs` — reader loads each fixture, asserts manifest

## Phase 9 — Final gates
- [x] `cargo clippy -p taletrek-synth --all-targets -- -D warnings` clean
- [x] `cargo test -p taletrek-synth` green (29 tests)
- [x] `pnpm verify` — web untouched; pre-existing `pcm.test.ts` biome failure is NOT from this effort (no files under `web/` changed)
- [x] Update `bundle-format.md` with final codec choice (Opus default)
- [x] Flip `spec.md` frontmatter `status: draft → active`

## Follow-on efforts (NOT this one)
- [ ] Effort 2 — `desktop-synth-app` (import text-only → synth → export full)
- [ ] Effort 3 — `spa-bundle-import-export` (TS bundle reader/writer + UI)
- [ ] Effort 4 — `personal-server` (Docker library server + worker mode)
