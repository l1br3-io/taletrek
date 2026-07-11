# M4 — Clean Reading · Task checklist

> Source of truth for `/status` and `/build`. Task detail + dependencies live in
> [`plan.md`](./plan.md); spec in [`docs/prds/M4-clean-reading.md`](../docs/prds/M4-clean-reading.md).
> Checkpoints gate phases: A cleaning module → B wired → C settings UI → D shipped.

## Phase 1 — Cleaning module
- [x] T1 — `lib/clean/` pure transforms: `cleanText` (4 filters), `applyPronunciation`, `cleanParagraphs`, `cleanChapters`; empties dropped; `enabled:false` passthrough

Checkpoint A — Cleaning module pure + tested · ✅

## Phase 2 — Settings + wiring
- [x] T2 — `CleaningConfig` on `Settings` + `DEFAULT_SETTINGS`; spread-merge fills defaults for existing users (no migration, no `DB_VERSION` bump)
- [x] T3 — `reader.tsx` derives `cleanedChapters` (`useMemo`) → player + `ReaderView`; `useParagraphPlayer` invalidates queue on chapters-reference change

Checkpoint B — Wired: display + audio reflect cleaning; mid-playback toggle re-primes · ✅

## Phase 3 — Settings UI
- [x] T4 — Cleaning section in `settings.tsx`: master toggle, four filter rows, pronunciation editor (add/edit/delete); all persist

Checkpoint C — Settings UI complete · ✅

## Phase 4 — End-to-end verify
- [x] T5 — E2E + browser verify (display + audio cleaned, mid-playback re-prime, pronunciation changes speech, zero console errors, zero cdnjs, `pnpm verify` green)

Checkpoint D — Clean Reading shipped & `pnpm verify` green · ✅

---

### Legend
- `[x]` done · `[ ]` pending · first `[ ]` is `/status`'s next task.
- Checkpoint ✅ = all tasks in the gated phases are `[x]` and verified green.
