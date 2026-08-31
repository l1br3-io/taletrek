# T11 — Chained `synth --input <source>` + real-engine e2e

**Description:** The one-command pipeline from the spec's locked CLI decision: when `synth --input` names a supported source file (not `.taletrek`), parse it in memory first, then run the existing synth path unchanged. Plus the `--ignored` real-engine test proving the whole chain.

**Work:**
- [x] `desktop/src/main.rs` — in the synth handler: `.taletrek` input → existing path; known source extension → `parse_source` → `to_text_only_bundle` → existing synth path; default output for chained runs = `<stem>.synth.taletrek` (unchanged naming rule); unknown extension → the T5 error
- [x] `resynth` stays bundle-only (documented in its `--help`)
- [x] Unit test of the dispatch branch with a mock runner (TXT source in, synth path entered, bundle not required on disk)
- [x] `#[ignore]`d e2e test (real piper+ffmpeg, `TALETREK_PIPER_BIN`/`TALETREK_VOICE_PATH` per `docs/testing.md` + `just test-e2e`): `parse` TXT fixture → `synth` the produced bundle → full audio bundle asserts (audio present, segments > 0, opus codec); plus the chained one-shot variant
- [x] `justfile` — extend or add a `chain-fixture` recipe if it earns its line (optional)

**Acceptance:**
- [x] Chained unit test green hermetically; `--ignored` e2e green with real engines
- [x] `just parse-fixture && just synth-fixture` still green (no regression to the two-step path)

**Verify:** `cargo test --workspace --quiet` + `just test-e2e` (env-gated)

**Dependencies:** T5 (+ T6–T10 for full format coverage; hard dep is the CLI structure)
**Files:** `desktop/src/{main,cli}.rs`, `desktop/tests/` or co-located `#[ignore]` test, `justfile`
**Docs:** `docs/developing.md` CLI examples updated (synth now takes sources)
**Estimated scope:** S
