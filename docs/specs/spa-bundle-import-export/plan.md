# Plan — Effort 3: SPA bundle import/export

> Spec: [`spec.md`](./spec.md). Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md). Format: [`../../bundle-format.md`](../../bundle-format.md) (frozen v1).
> This plan is a thin index. Per-task acceptance, files, and verification live in `tasks/00N-*.md`.

## Overview

Add the SPA's only new surface for the off-device track: a TS reader + writer for the frozen v1 `.taletrek` book-bundle format, plus IDB import/export and Library-page UI. Closes the Tier-2 loop (export text-only → desktop synth → import full → plays offline). The load-bearing requirement is **mutual round-trip conformance** with the Rust crate, proven by reading the three committed fixtures unchanged.

## Architecture decisions

- **Layered, not vertically sliced.** The format-conformance gate is the #1 risk (ADR-0013: "format drift"). The reader must be proven correct against the Rust fixtures before IDB integration is built on top of it. So: types → reader → parity gate → writer → import → export → UI. Each layer's tests are independent of the layer above.
- **`web/src/lib/bundle/` is pure at the core.** `reader.ts`/`writer.ts` take bytes in/out — no IDB. `import.ts`/`export.ts` own the IDB seams. This is what makes `parity.test.ts` fast and what lets the UI mock the lib layer cleanly.
- **Reuse, don't re-derive.** `audioCacheKey` + `NORM_VERSION` + `normalizeForSpeech` from `audio-cache.ts`/`tts/normalize.ts` are the single cache-key derivation. `jszip` is the ZIP lib (already a dep, used in `parse/epub.ts`). `newBookId()`/`newChapterId()` allocate collision ids. No new IDB store — audio flows into the existing content-addressed `audioCache`.
- **UI mirrors `BackupSection.tsx`.** Library-level "Import bundle" button (hidden `<input type="file" accept=".taletrek">` + toast) sits beside `UploadButton` in `LibraryPage.tsx`; per-book "Export bundle" is a new callback prop on `BookCard`'s existing `actionsMenu`.
- **Library bundles are detected and refused**, not supported. Reader throws `UnsupportedBundleKindError` on `kind: "library"`; full library import/export is a follow-on effort.

## Task index

### Phase 1 — Format layer (the conformance gate)
- [ ] Task 1: Manifest types + typed errors → `tasks/001-manifest-errors.md`
- [ ] Task 2: Reader (jszip unzip + validate) → `tasks/002-reader.md`
- [ ] Task 3: Parity test against Rust fixtures → `tasks/003-parity.md`

### Checkpoint: Conformance gate
- [ ] `parity.test.ts` green — SPA reads all 3 Rust fixtures; the #1 risk (format drift) is retired.

### Phase 2 — Writer (closes the in-memory round-trip)
- [ ] Task 4: Writer (jszip deflate, Opus stamp) → `tasks/004-writer.md`

### Checkpoint: In-memory round-trip
- [ ] writer → reader round-trips; manifest correctness holds.

### Phase 3 — IDB integration
- [ ] Task 5: Import (new-id-on-collision, dedup, size guard) → `tasks/005-import.md`
- [ ] Task 6: Export (voice recovery, text-only vs full) → `tasks/006-export.md`

### Checkpoint: IDB round-trip
- [ ] Import → IDB → export reproduces a byte-equivalent archive (round-trip conformance at the IDB seam).

### Phase 4 — UI
- [ ] Task 7: Library "Import bundle" button → `tasks/007-ui-import.md`
- [ ] Task 8: Per-book "Export bundle" action → `tasks/008-ui-export.md`

### Checkpoint: User-visible loop closes
- [ ] Export a text-only bundle from the library; re-import it; it plays.

### Phase 5 — Docs + ship
- [ ] Task 9: Docs + gotchas + byte-compat wording fix → `tasks/009-docs.md`
- [ ] Task 10: Runbook + final gates → `tasks/010-runbook-gates.md`

### Checkpoint: Ready for review
- [ ] All acceptance criteria in `spec.md` met; `pnpm verify` green; `cargo test -p taletrek-synth` green; runbook walkthrough passes.

## Risks and mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| Cache-key drift Rust↔TS breaks audio dedup | High | Reuse `audioCacheKey`/`NORM_VERSION` verbatim; parity test asserts fixtures' audio keys match `audioCacheKey(voice, text)`. |
| jszip produces archives the Rust reader rejects | High | Mutual round-trip is the gate (writer task 4 + import/export checkpoint round-trip through the Rust reader where feasible via fixtures). |
| Mobile memory on huge full bundles (in-memory jszip) | Med | v1 accepts the limitation; recorded as a gotcha in task 9; streaming reader is a documented follow-on. |
| `sourceFormat: "unknown"` has no SPA `BookFormat` | Low | Import maps `unknown → "txt"`; documented in gotchas (task 9). |
| IDB quota exceeded on large import | Med | `BundleTooLargeError` pre-flight mirroring `BackupTooLargeError` (task 5). |

## Open questions

None — the four from the spec review are resolved in `spec.md` § "Resolved decisions."
