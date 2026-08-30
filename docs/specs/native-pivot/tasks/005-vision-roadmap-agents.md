# T5 — VISION / ROADMAP / AGENTS rewrite

**Description:** The three orientation docs stop describing the SPA-first product and describe the native pivot. ADR-0015 is the decision; these are its projection.

**VISION.md:**
- [ ] Product paragraph: free OSS reading companion as **native apps + web reader** (kernel in Rust, OSS TTS via sherpa-onnx); web = landing + `.taletrek` reader
- [ ] Non-goals: remove "native app store distribution" (now the distribution model); remove the personal-server track paragraph; keep cloud/accounts/DRM/paid non-goals
- [ ] Personas survive (jogger/commuter/iOS user…) — wording updated where it promises PWA-only delivery

**ROADMAP.md:**
- [ ] Header: current effort = `native-pivot` (this effort); pointer to ideas one-pager + ADR-0015
- [ ] New native-track effort table: 1 `native-pivot` (active) · 2 `kernel-parse` · 3 `desktop-synth-gui` · 4 `android-app` · 5 `ios-app`
- [ ] Milestone history: keep the shipped table, strip links to deleted specs, add a note that purged efforts' specs were removed (ADR-0015)

**AGENTS.md:**
- [ ] Current-effort section → native pivot; commands drop server/docker entries; layout drops `server/` and re-scopes `web/` to "landing + reader"; gotcha index re-lists survivors only

- [ ] All three consistent with ADR-0015 + spec decisions table

**Files:** `docs/VISION.md`, `docs/ROADMAP.md`, `AGENTS.md`
**Verify:** read-through; cross-links resolve; no PWA-first claims remain
