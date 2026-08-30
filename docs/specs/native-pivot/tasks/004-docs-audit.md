# T4 — Docs audit

**Description:** After T3, prune docs to the native story. Run *after* the code purge so decisions match what actually survived. CHANGELOG stays untouched (history).

**Spec deletion candidates** (subject died with the purge — confirm each against surviving code):
- [x] `upload-read`, `speak`, `jog-mode`, `ai-transforms`, `biometric-key-caching`, `pdf-structure`, `parallel-synthesis`, `whole-book-streaming-transform`, `mobile-streaming-deferred`, iOS huge-book resilience (if its spec dir exists separately) — done 2026-08-30: all 9 dirs deleted (`parallel-synthesis` never had its own dir; iOS resilience dir was `ios-upload-resilience`). ADR companion links to them scrubbed (0003–0008) + historical status notes.
- [x] Keep + annotate: `playback-engines-pausable-synth` (engines survive; pausable-synth half retired — add a header note), `spa-bundle-import-export`, `library-offline`, reader-UX specs, foundation — header note added; others needed no edits (no dead links)
- [x] Keep unchanged: `portable-bundle-format`, `desktop-synth-app` (Rust track, still live) — one dead track-overview link in `portable-bundle-format/tasks/README.md` reworded (sweep gate)

**Gotchas** (retire-in-place, IDs stable, header note explains gaps):
- [x] Retire: G1, G6, G7, G8, G9, G14, G15, G16, G17, G18, G19, G20, G21, G24, G25, G26, G29 — marked "RETIRED (native pivot)" in place, header audit note added
- [x] Keep: G2, G3, G4, G5, G10, G11, G12, G13, G22, G23, G27, G28 (verify each against T3 survivors) — verified; G2/G3/G10/G11/G13/G22 reworded to post-pivot reality, G12 marked dormant (no MSE survives)

**Guides:**
- [x] `docs/developing.md` + `docs/testing.md`: drop server/docker sections, server test matrix rows, `just dev` narrative
- [x] `docs/bundle-format.md`: reword server/hosted references to host-neutral (kernel/apps)

- [x] Sweep: no links from surviving docs into deleted files — clean except CHANGELOG (history, exempt) and AGENTS.md/ROADMAP.md (T5 scope); ADR-0015's dead href to deleted ADR-0014 de-linked; CI `docker` job building the deleted `server/Dockerfile` removed (broken by T2, caught here)

**Files:** listed deletions + `docs/gotchas.md`, `docs/developing.md`, `docs/testing.md`, `docs/bundle-format.md`
**Verify:** `rg -n "specs/(upload-read|speak|jog-mode|ai-transforms|biometric-key-caching|pdf-structure|parallel-synthesis|whole-book-streaming-transform|mobile-streaming-deferred)"` → no hits (CHANGELOG only, exempt); spot-read gotchas header ✓; `pnpm verify` green (449 tests, build OK)
