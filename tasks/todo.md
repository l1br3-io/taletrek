# M3 — Jog Mode · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M3-jog.md`](../docs/prds/M3-jog.md).
> Checkpoints gate phases: A pre-render → B media session → C background + UX → D milestone verified.

## Phase 1 — Pre-render engine
- [x] T1 — Pre-render queue in `useParagraphPlayer` (look-ahead N=3, gapless advance, chapter skip, `AudioController` extension)

Checkpoint A — Pre-render proven (gapless playback through a chapter) · ✅

## Phase 2 — Media Session
- [x] T2 — Media Session module (`setMediaMetadata`, `setMediaSessionHandlers`, `setPlaybackState`, `setPositionState`)
- [x] T3 — Wire Media Session into `/reader` (metadata on book/chapter change, handlers → player refs)

Checkpoint B — Media Session wired (metadata + lock-screen handlers active) · ✅

## Phase 3 — Background + UX
- [x] T4 — Background-audio readiness (`playsinline`, iOS meta tags, tab-background MCP verify)
- [x] T5 — PlayerBar/UX ("buffering ahead" state, chapter-skip buttons)

Checkpoint C — Background-ready + UX complete · ✅

## Phase 4 — End-to-end verify
- [x] T6 — E2E + browser verify (gapless, media-session verified, tab-background continuity, zero console errors, `pnpm verify` green; iPhone gate documented)

Checkpoint D — Jog slice shipped & `pnpm verify` green · ✅

---

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
