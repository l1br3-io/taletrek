# Task 006: Finish migration + no-direct-import grep gate

**Description:** Last migration slice + the enforcement gate. Remaining UI callers (`routes/settings/*` — audio-cache stats, clear-all-data, backup; any stragglers found by grep) route through the facade. Then codify the boundary: a grep assertion (CI-able via existing `pnpm verify` script or a tiny test) that nothing under `routes/`, `components/`, `players/`, `hooks/` imports `lib/db` — except the allowlist (`context/settings.tsx`, `lib/ai/secure-keyring.ts` consumers) which stays on IDB in both modes by locked decision.

**Acceptance criteria:**
- [ ] `routes/settings/` data access (audio-cache stats, clear-all-data, backup trigger) goes through the facade; clear-all also clears datasource-owned stores via an interface method.
- [ ] Grep gate: script or test that fails when a non-allowlisted file under `web/src/{routes,components,players,hooks,context}` imports from `lib/db` (direct path or barrel). Allowlist: `context/settings.tsx` (+ documented secureKeyring path).
- [ ] Full existing suite green — this closes the pure-refactor phase with **zero** behavior change.
- [ ] Checkpoint recorded in `todo.md` (flip T2–T6 boxes).

**Verification:**
- [ ] `pnpm verify` green.
- [ ] `rg -n "from '.*lib/db'" web/src/{routes,components,players,hooks,context}` shows only the allowlist.
- [ ] Manual smoke: standalone PWA end-to-end unchanged (upload → synth → read → settings clear).

**Dependencies:** T4, T5

**Files likely touched:**
- `web/src/routes/settings/useSettingsPageState.ts`
- `web/src/routes/settings/useAudioCacheStats.ts`
- `web/src/routes/settings/clearAllData.ts`
- `web/src/lib/backup.ts` (route-facing surface only)
- grep-gate test or script (new, small)

**Docs:** The boundary rule gets a one-line pointer in AGENTS.md conventions when the effort ships (T19); the gate itself is the code home.

**Estimated scope:** Medium (4-5 files)
