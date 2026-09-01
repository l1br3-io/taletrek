# T12 — Web: `html`/`docx` sourceFormats + TS-side idempotence test

**Description:** The one web touch. Today `BundleSourceFormat` is a closed union (`pdf|epub|mobi|txt|md|unknown`) — a parse-produced `html`/`docx` bundle would fall through the import switch. Extend the vocabulary additively and pin the cross-app cleaning invariant from the TS side.

**Work:**
- [x] `web/src/lib/bundle/manifest.ts` — `BundleSourceFormat` += `'html' | 'docx'`
- [x] `web/src/lib/bundle/import.ts` — `sourceFormatToBookFormat` += both (identity mapping); `sourceFormatMime` += `text/html`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- [x] `BookFormat` (wherever the SPA union lives — types/db) += `'html' | 'docx'`; sweep for exhaustive switches on it (icons/labels) and extend
- [x] TS-side parity test: import a parse-produced fixture bundle (commit one small `.taletrek` built by `just parse-fixture`, or build bytes in-test) → assert `cleanChapters` output `===` input paragraphs (the reader's derived cleaning must not alter parse output — clean-at-parse's mirror contract)
- [x] Import unit tests: `html`/`docx` map through; `unknown` still collapses to `'txt'` (G28 unchanged)

**Acceptance:**
- [x] All mapping tests green; no exhaustive-switch holes (`pnpm typecheck` proves it)
- [x] `pnpm verify` green

**Verify:** `pnpm verify`

**Dependencies:** None (parallel-safe from spec approval; the parity test needs a parse-produced bundle → practically after T5, or build the bytes via a committed fixture)
**Files:** `web/src/lib/bundle/{manifest,import}.ts`, `BookFormat` home, tests beside them
**Docs:** G28 note gains a sentence: `html`/`docx` are now producer-known values (only pre-pivot bundles carry `unknown`)
**Estimated scope:** S
