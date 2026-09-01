# T13 — Docs + final verify

**Description:** Close the effort: docs tell the new story, gates all green, spec ready to flip shipped at merge. Mirrors native-pivot T4/T7 discipline — every doc claim sweep-verified against reality.

**Work:**
- [x] `docs/bundle-format.md` — `sourceFormat` enumeration += `html`/`docx`; producer list notes the CLI's `parse` as the text-only bundle producer
- [x] `docs/ROADMAP.md` — effort-2 row: planned → shipped (at ship; `/build` start flips spec to active — row can flip with the merge commit)
- [x] `AGENTS.md` — layout tree gains `crates/parse/` line; commands unchanged (cargo gates already cover it)
- [x] `docs/gotchas.md` — **G30** (numbered past retired-in-place G29, per stable-ID rule): clean-idempotence is a cross-app invariant — parse output must survive the reader's `cleanChapters` unchanged; breaking it orphans bundle audio (cache-miss → G22 error). Inline code home exists (clean.rs docs) — added the gotcha only because the failure crosses the Rust/TS boundary
- [x] `CHANGELOG.md` — kernel-parse entry
- [x] Final sweep: `rg -n "MOBI|mobi"` in crates/desktop → only deferred-decision references (spec/ROADMAP), no live code paths
- [x] Full gates: `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet && pnpm verify && just test-e2e`
- [x] Reader smoke via chrome-devtools MCP (T7-native-pivot bar): `just parse-fixture` → import in `pnpm dev` → chapters render, format label correct; then synth'd copy plays end-to-end

**Acceptance:**
- [x] All gates green; no dangling doc links (`python3 .opencode/harness/scripts/check-refs.py` if in scope)
- [x] Reader smoke: zero console errors; import + playback of a parse-produced bundle works
- [x] Spec frontmatter ready to flip `shipped` on merge

**Verify (2026-09-01, this run):**
- MOBI sweep: only the typed `UnsupportedExtensionError` tests in `desktop/src/main.rs` (the pinned deferred decision) + doc comments; no live parse paths.
- Gates: clippy `-D warnings` clean · `cargo test --workspace` 233 passed / 0 failed (5 ignored = real-engine) · `pnpm verify` green (lint + typecheck + test + build) · `just test-e2e` 5 real piper+ffmpeg e2e passed.
- check-refs.py: 14 broken refs, all pre-existing at HEAD in pre-pivot specs (`audio-cache`/`clean-reading`/`library-offline` → pruned `jog-mode`/`upload-read`/`speak` dirs, native-pivot T4 fallout) — none in kernel-parse files; out of scope here.
- Smoke (chrome-devtools, `pnpm dev` :8253): `just parse-fixture` → `/tmp/plain.taletrek` imported as "plain" (**text only**); reader shows `txt · 2 chapters`, Chapter One/Two render, URL-stripped prose confirms clean-at-parse. `just chain-fixture` → `/tmp/plain.synth.taletrek` imported ("**with audio**"); Play → status `Playing` (AudioContext running) → `Finished`; **zero console messages** across import + playback.

**Dependencies:** T11, T12 (and transitively all)
**Files:** `docs/{bundle-format,ROADMAP}.md`, `AGENTS.md`, `docs/gotchas.md`, `CHANGELOG.md`, this file
**Docs:** this task IS docs
**Estimated scope:** S
