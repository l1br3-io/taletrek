# M2 — Speak · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M2-speak.md`](../docs/prds/M2-speak.md).
> Checkpoints gate phases: A engine+worker → B playback engine → C read-along UI → D milestone verified.

## Phase 1 — Engine + worker
- [x] T1 — Deps + local WASM mirror (pin ORT 1.18.0, zero cdnjs)
- [x] T2 — TTS types + curated voice catalog
- [x] T3 — TTS Worker + client (verify OPFS-from-worker)

Checkpoint A — Engine + worker proven (synthesize WAV from worker, offline-ready) · ✅

## Phase 2 — Playback engine
- [x] T4 — `useParagraphPlayer` hook (play/pause/next/prev/seek, auto-advance, Blob-URL revocation)

Checkpoint B — Playback engine works (play a book, auto-advance through paragraphs) · ✅

## Phase 3 — Read-along UI
- [x] T5 — Reader read-along (highlight, tap-to-seek, PlayerBar)
- [x] T6 — Settings: voice picker + speed slider

Checkpoint C — Full slice: upload → read → play → read-along, voice + speed wired · ✅

## Phase 4 — End-to-end verify
- [x] T7 — E2E + browser verify (play through chapter, voice switch, speed, offline, 0 console errors)

Checkpoint D — Speak slice shipped & `pnpm verify` green · ✅

---

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
