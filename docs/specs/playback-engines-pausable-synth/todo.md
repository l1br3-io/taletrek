# M11 — Pluggable Playback Engines · Task checklist

> Archived record. Task detail + dependencies live in [`plan.md`](./plan.md);
> spec in [`SPEC.md`](./SPEC.md); decisions in
> [`../../../docs/adrs/0010-playback-engine-architecture.md`](../../../docs/adrs/0010-playback-engine-architecture.md);
> spike gate in [`../../../docs/spikes/web-audio-mobile.md`](../../../docs/spikes/web-audio-mobile.md).
> Checkpoints gate phases: A spike → B engine scaffolding → C Web Audio plays → D pausable → E lockdown → F shipped.

## Shipped

**Status: ✅ Shipped · 2026-07-19 (confirmed by author).**

This checklist was reconstructed from the plan's Tasks table at refactor time
(the original M11 plan carried no per-task checkpoint markers). Ship was
confirmed by code evidence — every plan-referenced file present, behaviours
wired (`manager.pause()`/`resume()`, `book.uploadJob`, `playbackEngine`
setting, `GlobalUploadBanner` Pause/Resume, ReaderPane lockdown), gotchas
G22–G24 written as established facts — and by the author's verification.

**Implementation divergences from the plan (non-blocking):**
- `web-audio-controller.ts` was not added as a separate file (lifecycle folded into `scheduler.ts` / `useWebAudioPlayer`).
- T4 (`useParagraphAudioQueue` extraction) was descoped per the plan's own note — `useWebAudioPlayer` owns its lookahead.

## Phase 0 — Spike (gate)
- [x] T1 — Web Audio spike page + real-device checklist (`spike/web-audio/`, `docs/spikes/web-audio-mobile.md`)

Checkpoint A — Spike passes on real iPhone + Chrome Android · ✅

## Phase 1 — Engine architecture + Web Audio player
- [x] T2 — ADR-0010 written; ROADMAP M11 entry; AGENTS gotchas updated
- [x] T3 — Engine registry (`lib/playback/engines.ts`) + `playbackEngine` setting/migration + Advanced UI group
- [x] T4 — ~~Extract `useParagraphAudioQueue`~~ **Descoped** — `useWebAudioPlayer` owns its own lookahead
- [x] T5 — Web Audio scheduler (`lib/audio/web-audio/scheduler.ts`) + tests (controller folded in, not a separate file)
- [x] T6 — `useWebAudioPlayer` + `usePlayer` mobile switch + `upload/manager.ts` encode gate

Checkpoint B — Engine scaffolding · ✅
Checkpoint C — Web Audio plays gapless · ✅

## Phase 2 — Pause/resume synthesis (orthogonal)
- [x] T7 — `JobState += 'paused'`; manager `pause()`/`resume(bookId)`; `book.uploadJob` persistence; boot-sweep invisibility
- [x] T8 — `GlobalUploadBanner` Pause/Resume; library paused badge + Resume action

Checkpoint D — Pausable synthesis · ✅

## Phase 3 — Mobile synthesis lockdown
- [x] T9 — `ReaderPane` gating (mobile + active/paused job); `PlayerBar` synthesis-mode render; overflow menu reduction

Checkpoint E — Mobile lockdown · ✅

## Phase 4 — Verify
- [x] T10 — `pnpm verify` green; real-iPhone gate passed

Checkpoint F — M11 shipped & `pnpm verify` green · ✅

---

### Ordering
T1 → (gate) → T2 → T3 → ~~T4~~ → T5 → T6 → T7 → T8 → T9 → T10. T7–T8 may run in parallel with T5–T6.
