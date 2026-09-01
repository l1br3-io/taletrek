# T11 — Docs close-out + full gates + reader smoke

**Description:** Close the effort the kernel-parse T13 way: docs tell the new story, every gate green, the reader smoke proves a GUI-produced bundle end-to-end, spec ready to flip `shipped` at merge.

**Work:**
- [ ] `CHANGELOG.md` — effort-3 entry (GUI + in-process engines + releases)
- [ ] `docs/ROADMAP.md` — effort-3 row flips with the merge commit (as T13 did)
- [ ] `AGENTS.md` — current-effort paragraph, layout tree gains `desktop/src/gui/` + release workflow line, `just gui` in commands
- [ ] `docs/developing.md` — GUI dev path, engine features, override flags; `docs/testing.md` — sherpa `--ignored` rows (voice-path env, if needed)
- [ ] Gotchas: any surviving trap gets an inline code home first (`encode.rs`/`sherpa_runner.rs` module docs); `docs/gotchas.md#gN` only for cross-boundary traps (e.g. per-thread sherpa memory if it bites)
- [ ] Full gates: `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet && pnpm verify && just test-e2e` + sherpa `--ignored`
- [ ] Reader smoke (chrome-devtools, T7-native-pivot bar): GUI-produced bundle (convert path) imports → chapters render, format label correct → plays end-to-end, zero console errors; re-voiced bundle opens too
- [ ] Clean-machine proof for Checkpoint C: PATH-stripped CLI + the Linux release artifact note (from T10's dispatch run)

**Acceptance:**
- [ ] All gates green; check-refs introduces no new broken links
- [ ] Reader smoke transcript in this file (zero console errors)
- [ ] Spec frontmatter ready to flip `shipped` on merge

**Verify:** full gate line + smoke transcript recorded here. **This is Checkpoint C.**

**Dependencies:** T10 (and transitively all)
**Files:** `CHANGELOG.md`, `docs/{ROADMAP,developing,testing,gotchas}.md`, `AGENTS.md`, this file
**Docs:** this task IS docs
**Estimated scope:** S
