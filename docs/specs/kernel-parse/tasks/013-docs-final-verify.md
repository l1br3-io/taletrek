# T13 — Docs + final verify

**Description:** Close the effort: docs tell the new story, gates all green, spec ready to flip shipped at merge. Mirrors native-pivot T4/T7 discipline — every doc claim sweep-verified against reality.

**Work:**
- [ ] `docs/bundle-format.md` — `sourceFormat` enumeration += `html`/`docx`; producer list notes the CLI's `parse` as the text-only bundle producer
- [ ] `docs/ROADMAP.md` — effort-2 row: planned → shipped (at ship; `/build` start flips spec to active — row can flip with the merge commit)
- [ ] `AGENTS.md` — layout tree gains `crates/parse/` line; commands unchanged (cargo gates already cover it)
- [ ] `docs/gotchas.md` — **G29** (if earned in T3): clean-idempotence is a cross-app invariant — parse output must survive the reader's `cleanChapters` unchanged; breaking it orphans bundle audio (cache-miss → G22 error). Inline code home exists (clean.rs docs) — add the gotcha only because the failure crosses the Rust/TS boundary
- [ ] `CHANGELOG.md` — kernel-parse entry
- [ ] Final sweep: `rg -n "MOBI|mobi"` in crates/desktop → only deferred-decision references (spec/ROADMAP), no live code paths
- [ ] Full gates: `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet && pnpm verify && just test-e2e`
- [ ] Reader smoke via chrome-devtools MCP (T7-native-pivot bar): `just parse-fixture` → import in `pnpm dev` → chapters render, format label correct; then synth'd copy plays end-to-end

**Acceptance:**
- [ ] All gates green; no dangling doc links (`python3 .opencode/harness/scripts/check-refs.py` if in scope)
- [ ] Reader smoke: zero console errors; import + playback of a parse-produced bundle works
- [ ] Spec frontmatter ready to flip `shipped` on merge

**Verify:** the full gate line above + smoke transcript in this file

**Dependencies:** T11, T12 (and transitively all)
**Files:** `docs/{bundle-format,ROADMAP}.md`, `AGENTS.md`, `docs/gotchas.md`, `CHANGELOG.md`, this file
**Docs:** this task IS docs
**Estimated scope:** S
