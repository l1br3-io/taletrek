# T3 — `clean.rs` (M4 structural filters) + TXT chapter line-split

**Description:** Port the SPA's structural cleaning filters to Rust and apply them in the parse pipeline (clean-at-parse, spec's locked decision), then add the conservative standalone-line chapter splitter for TXT. This task creates the parity-critical code path — the idempotence test is the contract that bundle audio stays playable in the reader.

**Work:**
- [x] `src/clean.rs` — port of `web/src/lib/clean/filters.ts`: `strip_urls` (bare URLs dropped; markdown `[text](url)` → `text`), `strip_images` (`![alt](url)`, `[Image: …]`, `[Figure: …]`), `strip_footnote_refs` (`[n]` inline, `[n]:` defs, superscript digits — **not** `(1984)` years), `is_page_number_line` (`^\d{1,4}$`, `^page \d+$`); drop paragraphs emptied by cleaning; pronunciation is NOT ported (reader-side only, per spec)
- [x] Apply in `parse_source` after paragraph assembly, before `ParsedBook` — every format gets it (single seam in lib.rs, not per-parser)
- [x] `src/txt.rs` — conservative chapter split: a paragraph that is exactly one line matching `^(chapter|part|section)\s+(number|roman|number-word)$` (case-insensitive, standalone) starts a new chapter titled by that line; zero matches → single chapter (unchanged)
- [x] Adversarial tests: splits `CHAPTER 7`, `Part III`, `Chapter Twelve`; does **not** split `Part of the reason was…`, `Chapter 1 was the worst day…` (ADR-0008's false positives)
- [x] Idempotence test: `clean(parse(x)) == parse(x)` on every fixture present so far
- [x] M4 filter port tests mirroring `web/src/lib/clean/filters.test.ts` cases (each filter's representative strings incl. the `(1984)` negative)

**Acceptance:**
- [x] Fixture noise (URLs, `[1]` refs, `![img](…)`, standalone page numbers) absent from parsed paragraphs
- [x] Idempotence holds on all fixtures
- [x] Both ADR-0008 prose false-positives stay in-body

**Verify:** `cargo test -p taletrek-parse --quiet`

**Dependencies:** T1
**Files:** `crates/parse/src/{clean,txt}.rs`, `crates/parse/src/lib.rs` (seam), tests
**Docs:** clean.rs module doc states the cross-app invariant (parse output must survive the reader's `cleanChapters` unchanged) — candidate gotcha G29 recorded at T13 if it needs wider visibility
**Estimated scope:** M
