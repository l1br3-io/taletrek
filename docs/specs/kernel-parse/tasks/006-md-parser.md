# T6 — MD parser (`pulldown-cmark`)

**Description:** Markdown files → chapters via heading structure. First structural format after TXT; establishes that a real parsing crate slots cleanly into the T1 API + T3 cleaning seam.

**Work:**
- [ ] `pulldown-cmark` dep (default features off if feasible)
- [ ] `src/md.rs` — event stream → paragraphs; **level-1 headings** (`#`) start new chapters and title them; deeper headings (`##`+) render as their text line inside the running chapter; title fallback = first `#` (already a chapter title) → `hint` stem
- [ ] Fixture `testdata/book.md`: two `#` chapters, a `##` sub-heading, link + image + footnote-marker noise, em-dashes/smart-quote chars
- [ ] Golden test: exact `ParsedBook`; cleaning already applied (noise gone)

**Acceptance:**
- [ ] Golden green; `##` heading survives as text; links reduce to text; images dropped
- [ ] Idempotence test extended to the MD fixture

**Verify:** `cargo test -p taletrek-parse --quiet`

**Dependencies:** T1, T3
**Files:** `crates/parse/src/md.rs`, `crates/parse/Cargo.toml`, `crates/parse/testdata/book.md`, `tests/golden.rs`
**Docs:** none
**Estimated scope:** S
