# Task 010: Runbook + final gates

**Description:** The ship gate. (a) Write `docs/specs/spa-bundle-import-export/runbook.md` — the manual end-to-end walkthrough (real SPA ↔ real `taletrek-desktop` round-trip on a real browser), mirroring effort 2's `runbook.md` shape. (b) Run every final gate and record results in `todo.md`. (c) This task does **not** flip `spec.md` to `shipped` — that is the merge commit's job (per ROADMAP §"How we plan").

**Acceptance criteria:**
- [ ] `docs/specs/spa-bundle-import-export/runbook.md` covers the full Tier-2 loop:
  1. In the SPA, pick a library book → "Export bundle" → text-only → download `book.text.taletrek`.
  2. On a desktop with `piper` + `ffmpeg` on PATH: `taletrek-desktop synth -i book.text.taletrek -v en_US-lessac-medium -o book.full.taletrek`.
  3. Back in the SPA: "Import bundle" → select `book.full.taletrek` → confirm it appears in the library and **plays end-to-end offline with no re-synthesis**.
  4. Variant: import the same full bundle twice → confirm two distinct library books (collision rule), no duplicate audio writes.
  5. Variant: export a full bundle from a synth'd book → import on a fresh device → plays.
- [ ] Gates run and recorded in `todo.md`:
  - [ ] `pnpm verify` green (lint + typecheck + test + build). *(Note: if the pre-existing `web/` lint failure from effort 2's gate is still unfixed, record it the same way — pre-existing on main, not caused by this effort.)*
  - [ ] `cargo test -p taletrek-synth` green (effort 1 untouched; fixtures unchanged).
  - [ ] `pnpm test` green — including `bundle/parity.test.ts` against the live fixtures.
  - [ ] Runbook walkthrough passes on a real browser (human-run; mark with the date/run commit).
- [ ] Every acceptance criterion in `spec.md` §"Success criteria" is checked or explicitly deferred with a reason.

**Verification:**
- [ ] All gates green (or explicitly blocked-on-pre-existing-main, recorded).
- [ ] `runbook.md` is clear enough that a fresh contributor can complete the loop from the steps alone.

**Dependencies:** T1–T9 (the whole effort). Lands last.

**Files likely touched:**
- `docs/specs/spa-bundle-import-export/runbook.md` (new)
- `docs/specs/spa-bundle-import-export/todo.md` (gate checkboxes)

**Docs:** The runbook is the doc.

**Estimated scope:** Small (1 new doc + checklist updates; no code — the gate run is verification, not implementation).
