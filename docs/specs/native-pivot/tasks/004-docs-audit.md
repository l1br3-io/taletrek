# T4 — Docs audit

**Description:** After T3, prune docs to the native story. Run *after* the code purge so decisions match what actually survived. CHANGELOG stays untouched (history).

**Spec deletion candidates** (subject died with the purge — confirm each against surviving code):
- [ ] `upload-read`, `speak`, `jog-mode`, `ai-transforms`, `biometric-key-caching`, `pdf-structure`, `parallel-synthesis`, `whole-book-streaming-transform`, `mobile-streaming-deferred`, iOS huge-book resilience (if its spec dir exists separately)
- [ ] Keep + annotate: `playback-engines-pausable-synth` (engines survive; pausable-synth half retired — add a header note), `spa-bundle-import-export`, `library-offline`, reader-UX specs, foundation
- [ ] Keep unchanged: `portable-bundle-format`, `desktop-synth-app` (Rust track, still live)

**Gotchas** (retire-in-place, IDs stable, header note explains gaps):
- [ ] Retire: G1, G6, G7, G8, G9, G14, G15, G16, G17, G18, G19, G20, G21, G24, G25, G26, G29
- [ ] Keep: G2, G3, G4, G5, G10, G11, G12, G13, G22, G23, G27, G28 (verify each against T3 survivors)

**Guides:**
- [ ] `docs/developing.md` + `docs/testing.md`: drop server/docker sections, server test matrix rows, `just dev` narrative
- [ ] `docs/bundle-format.md`: reword server/hosted references to host-neutral (kernel/apps)

- [ ] Sweep: no links from surviving docs into deleted files

**Files:** listed deletions + `docs/gotchas.md`, `docs/developing.md`, `docs/testing.md`, `docs/bundle-format.md`
**Verify:** `rg -n "specs/(upload-read|speak|jog-mode|ai-transforms|biometric-key-caching|pdf-structure|parallel-synthesis|whole-book-streaming-transform|mobile-streaming-deferred)"` → no hits; spot-read gotchas header
