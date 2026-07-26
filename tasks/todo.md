# M11 — Pluggable Playback Engines · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`../SPEC.md`](../SPEC.md); decisions in
> [`../docs/adr/0010-playback-engine-architecture.md`](../docs/adr/0010-playback-engine-architecture.md);
> spike gate in [`../docs/spikes/web-audio-mobile.md`](../docs/spikes/web-audio-mobile.md).
> Checkpoints gate phases: A spike → B engine scaffolding → C Web Audio plays → D pausable → E lockdown → F shipped.

## Resuming

**Status: 🚧 In progress (canonical current phase).**

This checklist was reconstructed from the plan's Tasks table when the planning
docs were refactored to the harness layout. The original M11 plan carried **no
per-task checkpoint markers**, so only items with direct artifact evidence are
marked `[x]` below (T1 spike doc exists; T2 ADR-0010 + ROADMAP + AGENTS exist).
T3–T10 are `[ ]` pending — some may have landed in code (gotchas G22–G24 read as
established behaviour) but are **not verified-shipped**. Confirm against code/git
before relying on intermediate check states. M13 runs in parallel as the
named-phase deviation (see `plan.md` header).

## Phase 0 — Spike (gate)
- [x] T1 — Web Audio spike page + real-device checklist (`spike/web-audio/`, `docs/spikes/web-audio-mobile.md`)

Checkpoint A — Spike passes on real iPhone + Chrome Android · ✅ (spike doc landed; real-hardware gates per gotcha #5)

## Phase 1 — Engine architecture + Web Audio player
- [ ] T2 — ADR-0010 written; ROADMAP M11 entry; AGENTS status/gotchas updated *(docs exist; verify currency)*
- [ ] T3 — Engine registry (`lib/playback/engines.ts`) + `playbackEngine` setting/migration + Advanced UI group
- [ ] T4 — ~~Extract `useParagraphAudioQueue`~~ **Descoped** (see plan; `useWebAudioPlayer` owns its own lookahead)
- [ ] T5 — Web Audio scheduler + controller (`lib/audio/web-audio/scheduler.ts`, `web-audio-controller.ts`) + tests
- [ ] T6 — `useWebAudioPlayer` + `usePlayer` mobile switch + `upload/manager.ts` encode gate

Checkpoint B — Engine scaffolding · ◐
Checkpoint C — Web Audio plays gapless · ◐

## Phase 2 — Pause/resume synthesis (orthogonal)
- [ ] T7 — `JobState += 'paused'`; manager `pause()`/`resume(bookId)`; `book.uploadJob` persistence; boot-sweep invisibility test
- [ ] T8 — `GlobalUploadBanner` Pause/Resume; library paused badge + Resume action

Checkpoint D — Pausable synthesis · ◐

## Phase 3 — Mobile synthesis lockdown
- [ ] T9 — `ReaderPane` gating (mobile + active/paused job); `PlayerBar` synthesis-mode render; overflow menu reduction

Checkpoint E — Mobile lockdown · ◐

## Phase 4 — Verify
- [ ] T10 — `pnpm verify` green; Chrome DevTools MCP mobile-viewport pass; real-iPhone checklist documented

Checkpoint F — M11 shipped & `pnpm verify` green · ⬜

---

### Ordering
T1 → (gate) → T2 → T3 → ~~T4~~ → T5 → T6 → T7 → T8 → T9 → T10. T7–T8 may run in parallel with T5–T6.

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green · ◐ = in progress · ⬜ = not started.
