# M1 — Upload & Read · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M1-upload-read.md`](../docs/prds/M1-upload-read.md).
> Checkpoints gate phases: A foundation → B parsers → C integrated → D milestone verified.

## Phase 1 — Foundation & data layer
- [x] T1 — Types + DB v2
- [x] T2 — Parser contract + TXT parser

Checkpoint A — Foundation locked (types, DB v2, parser contract) · ✅

## Phase 2 — Format parsers
- [x] T3 — EPUB parser
- [x] T4 — PDF parser + worker spike

Checkpoint B — All format parsers green · ✅

## Phase 3 — Worker integration
- [x] T5 — Parse Worker + client

## Phase 4 — Reader UI
- [x] T6 — Reader container + views + landing CTA

Checkpoint C — Worker + UI integrated end-to-end · ✅

## Phase 5 — End-to-end verify
- [x] T7 — E2E + browser verify (3 formats, reload, offline, 0 console errors)

Checkpoint D — Three-format slice shipped & `pnpm verify` green · ✅

---

## Spike (deferred — independent after T2)
- [ ] T8 — MOBI spike (decision: minimal self-written parser or punt)

---

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
