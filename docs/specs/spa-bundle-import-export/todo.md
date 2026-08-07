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
- [ ] T10: Runbook + final gates (`tasks/010-runbook-gates.md`)

## Follow-on (NOT this effort)
- [ ] Library-bundle (`.taletrek-lib`) SPA support
- [ ] Effort 4 — `personal-server` (Rust Docker library server + worker-mode synth)
