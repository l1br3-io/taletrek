# TODO — Effort 2: Desktop synth app

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 1 — Workspace + CLI skeleton ✅
- [x] Root `Cargo.toml` updated: `members = ["crates/*", "desktop"]`
- [x] `desktop/Cargo.toml` (binary `taletrek-desktop`, deps: clap, anyhow — rayon/ureq/dirs/taletrek-synth added in their phases)
- [x] `desktop/src/main.rs` + `cli.rs` — clap `synth` | `resynth` subcommands with shared `CommonArgs`
- [x] `cargo run -p taletrek-desktop -- --help` prints both subcommands
- [x] `cargo build` + `cargo clippy -p taletrek-desktop --all-targets -- -D warnings` clean

## Phase 2 — Voice catalog + resolve/download/cache (`voices.rs`)
- [x] `CURATED_VOICES` mirror (8 English medium voices) + HF base + path map (parity with `web/src/lib/tts/voices.ts` + `vendor/piper/models.ts`)
- [x] `resolve_voice(id, opts) -> Result<PathBuf>`: cache-hit short-circuits; else download `.onnx` + `.json` into `$XDG_CACHE_HOME/taletrek/voices/`
- [x] `--voice-path` override (pre-check `<stem>.json` exists → clear error)
- [x] `VoiceSource` trait (fetch bytes for URL) so unit tests stub HTTP
- [x] Unit test: cache-hit short-circuits download; unknown curated id → typed error

## Phase 3 — Parallel synth engine (`synth_job.rs`)
- [x] Load text-only bundle via `read_book_bundle`; enumerate every paragraph across chapters
- [x] `rayon` bounded pool, `--jobs` default `num_cpus`; per-task fresh `SubprocessPiperRunner`, shared `&OpusEncoder`
- [x] Per-paragraph: `synthesize_paragraph(voice, text, &mut opts)` → `(cache_key, AudioSegment)`; abort on first error
- [x] Collect into `BookBundle.audio` HashMap
- [x] Unit test (stub runner + `WavPassthrough`): every paragraph yields a segment; keys == `cache_key(voice, text)`

## Phase 4 — Bundle I/O glue + full manifest stamp (`bundle_io.rs`)
- [x] Stamp manifest: `audio.present=true`, `codec=opus`, `normVersion=NORM_VERSION`, `segmentCount`, `generator={taletrek-desktop, 0.1.0}`, keep `book.voiceId`
- [x] `write_book_bundle` → output file; default naming `<stem>.synth.taletrek` when `--output` omitted
- [x] Wire `synth` subcommand end-to-end (voices → synth_job → bundle_io)
- [x] `synth` refuses already-full input (→ points at `resynth`)
- [x] Unit test: round-trip via `read_book_bundle`; manifest correctness; refuse-full-input error

## Phase 5 — Resynth (whole-book voice swap) (`resynth.rs`)
- [x] `resynth --input <full|text-only> --voice <new>`: re-synth every paragraph with new voice; discard old audio
- [x] Update `book.voiceId` in output manifest
- [x] Accepts text-only or full input
- [x] Unit test: every output segment re-keyed to new voice; manifest `voiceId` updated

## Phase 6 — Progress logging (`progress.rs`)
- [x] stderr writer behind a `Write` seam (testable)
- [x] Synth progress: `[n/total] pct%` per paragraph (or per N)
- [x] Voice-download progress: bytes / total during fetch
- [x] Final summary line: `synth: N paragraphs, Xm Ys, → <out>`
- [x] Unit test: progress lines captured via the seam

## Phase 7 — Manual end-to-end + integration test
- [x] `#[ignore]` integration test: real `piper` + `ffmpeg` + real curated voice on a text-only fixture → full bundle (gated like effort 1)
- [x] Human runbook: synth a real text-only bundle → confirm Opus audio plays + `manifest.audio` correct; round-trip output back through SPA import (effort 3 will automate)

## Phase 8 — Final gates
- [ ] `cargo clippy -p taletrek-desktop --all-targets -- -D warnings` clean
- [ ] `cargo test -p taletrek-desktop` green
- [ ] `cargo test -p taletrek-synth` still green (effort 1 untouched)
- [ ] `pnpm verify` still green (no `web/` changes)
- [ ] Flip `spec.md` frontmatter `status: draft → active` on /build checkpoint; flip to `shipped` on merge

## Follow-on efforts (NOT this one)
- [ ] Effort 3 — `spa-bundle-import-export` (TS bundle reader/writer + UI)
- [ ] Effort 4 — `personal-server` (Docker library server + worker mode)
