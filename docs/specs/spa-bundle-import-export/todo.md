# TODO — Effort 3: SPA bundle import/export

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 1 — Format layer (the conformance gate)
- [x] T1: Manifest types + typed errors (`tasks/001-manifest-errors.md`)
- [x] T2: Reader — jszip unzip + validate (`tasks/002-reader.md`)
- [x] T3: Parity test against the 3 Rust fixtures (`tasks/003-parity.md`)

### Checkpoint: Conformance gate — SPA reads desktop output; #1 risk retired.

## Phase 2 — Writer
- [x] T4: Writer — jszip deflate + Opus stamp, round-trips through reader (`tasks/004-writer.md`)

### Checkpoint: In-memory round-trip holds.

## Phase 3 — IDB integration
- [x] T5: Import — new-id-on-collision, audio dedup, size guard (`tasks/005-import.md`)
- [x] T6: Export — voice recovery, text-only vs full (`tasks/006-export.md`)

### Checkpoint: IDB round-trip reproduces a conformant archive.

## Phase 4 — UI
- [x] T7: Library "Import bundle" button (`tasks/007-ui-import.md`)
- [x] T8: Per-book "Export bundle" action (`tasks/008-ui-export.md`)

### Checkpoint: User-visible loop closes (export → re-import → plays).

## Phase 5 — Docs + ship
- [x] T9: Docs + gotchas + byte-compat wording fix in `bundle-format.md` (`tasks/009-docs.md`)
- [x] T10: Runbook + final gates (`tasks/010-runbook-gates.md`)

### Final gates (run @ T10, branch `spa-bundle-import-export`)
- [x] `cargo test -p taletrek-synth` green — 4+5+3+4 suites pass (1 `#[ignore]` needs `piper`+`ffmpeg`; fixtures unchanged, effort 1 frozen).
- [x] `pnpm test` green — 86 files / **1113 tests**, includes `bundle/parity.test.ts` against the 3 live Rust fixtures.
- [x] `pnpm typecheck` green (`tsc --noEmit`).
- [x] `pnpm build` green — `dist/` + PWA service worker generated.
- [ ] `pnpm verify` (full) — **BLOCKED, pre-existing on main**: `pnpm lint` fails with **2 errors** in `web/src/lib/tts/pool.test.ts` (`lint/suspicious/useIterableCallbackReturn`, lines 43 & 48). `pool.test.ts` is byte-identical on `main` and this branch; `biome.json` untouched by this effort; `web/src/lib/bundle/` (13 files) is lint-clean. Same shape of blocker effort 2 recorded (Phase 8); the `web/` noNonNullAssertion warnings (`pdf.ts`, `pcm.test.ts`) are also pre-existing. `typecheck`/`test`/`build` all green. Flagged for a separate `web/` cleanup; not a regression from this effort.
- [ ] Runbook walkthrough on a real browser (`runbook.md`) — **human-run, pending**: export text-only → `taletrek-desktop synth` → import full → plays offline with no re-synthesis. _(Record date + commit here when run.)_

### Checkpoint: Ready for review
- [x] All `spec.md` §"Success criteria" checked or explicitly deferred (runbook walkthrough = deferred to human run, above).
- [x] Runbook + final gates task complete. `spec.md` `status:` stays `active` — flips to `shipped` on the merge commit (per ROADMAP §"How we plan").

## Follow-on (NOT this effort)
- [ ] Library-bundle (`.taletrek-lib`) SPA support
- [ ] Effort 4 — `personal-server` (Rust Docker library server + worker-mode synth)
