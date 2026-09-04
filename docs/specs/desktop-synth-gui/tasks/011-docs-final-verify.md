# T11 — Docs close-out + full gates + reader smoke

**Description:** Close the effort the kernel-parse T13 way: docs tell the new story, every gate green, the reader smoke proves a GUI-produced bundle end-to-end, spec ready to flip `shipped` at merge.

**Work:**
- [x] `CHANGELOG.md` — effort-3 entry (GUI + in-process engines + releases)
- [x] `docs/ROADMAP.md` — effort-3 row flips with the merge commit (as T13 did) — plus two sweep fixes: effort-1 row was still 🚧 active (stale since native-pivot's post-merge flip) and the header "Current effort" note pointed at native-pivot; both now tell the efforts-1–3-shipped story
- [x] `AGENTS.md` — current-effort paragraph, layout tree gains `desktop/src/gui/` + release workflow line, `just gui` in commands
- [x] `docs/developing.md` — GUI dev path, engine features, override flags (already landed with T5/T7/T10 — verified complete, no gaps); `docs/testing.md` — desktop row re-described (GUI + CLI, `parse`/`gui` subcommands) + a GUI unit-test layer row added; sherpa `--ignored` rows + `TALETREK_ESPEAK_DATA` were already in place
- [x] Gotchas: **no new G entry** — per this task's own rule every engine trap already has its inline code home (`sherpa_runner.rs` module docs: k2-fsa static linking, ~212 MB/runner cost model, tokens.txt derivation, espeak-ng-data, ONNX metadata stamping; `opus_native.rs`: RFC 7845 mux shape, resample-into-libopus-rates, EndStream flush). Nothing here crosses the Rust/TS boundary — bundle format v1 and cache keys are unchanged by construction, the reader untouched — so `docs/gotchas.md` gains nothing. (Harness traps stay in the task files where T7–T9 pinned them.)
- [x] Full gates: `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet && pnpm verify && just test-e2e` + sherpa `--ignored`
- [x] Reader smoke (chrome-devtools, T7-native-pivot bar): GUI-produced bundle (convert path) imports → chapters render, format label correct → plays end-to-end, zero console errors; re-voiced bundle opens too
- [x] Clean-machine proof for Checkpoint C: PATH-stripped CLI + the Linux release artifact note (from T10's dispatch run)

**Acceptance:**
- [x] All gates green; check-refs introduces no new broken links
- [x] Reader smoke transcript in this file (zero console errors)
- [x] Spec frontmatter ready to flip `shipped` on merge

**Verify (2026-09-04, this run — Checkpoint C):**

- **Gates:** clippy `-D warnings` clean · `cargo test --workspace` 325 passed / 0 failed · `pnpm verify` green (lint + typecheck + test + build) · `just test-e2e` (real piper+ffmpeg **and** sherpa paths, `--features taletrek-synth/sherpa`) 8 passed / 0 failed.
- **check-refs:** 14 broken refs — byte-identical set to kernel-parse T13's audit (`audio-cache`/`clean-reading`/`library-offline` → pruned `jog-mode`/`upload-read`/`speak` dirs); none in this effort's files. No new links broken.
- **GUI pass (fresh bundles at HEAD 446a2de, Xvfb :99 + `TALETREK_RENDERER=glow` + zenity shim per T7/T8):** click *Add files…* → picker autopicks `crates/parse/testdata/plain.txt` → job row Running → **Done → `plain.synth.taletrek`** (136,466 B; manifest `voiceId: en_US-amy-medium`, 5 Opus segments, `generator.app: taletrek-desktop`). Amy was **not** cached — the model downloaded inside the job, re-proving T8's on-demand path at HEAD (my radio click landed one row off; the accident is the better test). Then Ryan selected (cached) → *Add existing bundle…* → re-voice of that bundle → **Done → `plain.synth.en_US-ryan-medium.taletrek`** (106,634 B; `voiceId: en_US-ryan-medium`, 5 segments); `sha256sum -c` confirms the input bundle byte-identical afterward.
- **Reader smoke (chrome-devtools, `pnpm dev` :8253):** GUI convert bundle imported → status **"Imported 'plain' (with audio)"** → reader shows **`txt · 2 chapters`**, Chapter One/Two render, all 5 cleaned paragraphs (URL-stripped prose) → Play → status **Playing** → **Finished** (end-to-end, ~45 s). Re-voiced bundle imported as a second library entry → opens (`txt · 2 chapters`) → **Playing**. **Zero console errors** across both sessions — only benign info/debug (vite connect, React DevTools hint, storage-persistence note, media-session log, PWA banner note).
- **Clean-machine proof:** `env -i HOME=$HOME PATH=/nonexistent target/debug/taletrek-desktop` (no subprocess resolvable *anywhere*) → `--version` ok · `parse` → 1,008 B text-only bundle · `synth` → 111,668 B full audio bundle (5 Opus segments, seeded-cache voice, in-process engines both sides). The packaged-artifact half is T10's dispatch run <https://github.com/l1br3-io/taletrek/actions/runs/33836581714> (4/4 jobs green; Linux job smoke: `taletrek-desktop 0.1.0` + headless `parse` → non-empty bundle).
- **Docs sweep extras:** `docs/bundle-format.md`'s encoder note still told the ffmpeg-subprocess-is-the-encoder story — rewritten (native default, subprocess override, byte-shape-equivalence); `kernel-parse/spec.md` frontmatter was still `active` (its merge commit never flipped it) — flipped `shipped` retroactively with a note.
- **Harness notes for the next headless GUI session:** this python-xlib exposes XTEST via `Xlib.ext.xtest.fake_input(display, event, detail, x=…, y=…)` — `Display.fake_input` does not exist here (T8's signature note assumed it did); buttons live at y≈42 (*Add files…* x≈43, *Add existing bundle…* x≈155) with the Settings panel possibly persisted-open below (its *Browse…* at y≈104 spawns a `--directory` zenity call — useful for coordinate probes, harmless); voice-catalog rows are ~24 px apart from y≈206.

**Dependencies:** T10 (and transitively all)
**Files:** `CHANGELOG.md`, `docs/{ROADMAP,developing,testing,gotchas,bundle-format}.md`, `AGENTS.md`, this file
**Docs:** this task IS docs
**Estimated scope:** S
