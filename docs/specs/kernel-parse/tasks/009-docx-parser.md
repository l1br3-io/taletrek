# T9 — DOCX parser (zip + quick-xml)

**Description:** Word documents → chapters via paragraph styles. DOCX = zip with `word/document.xml` (namespaced `w:` XML) + `docProps/core.xml` metadata. No new deps (zip + quick-xml from T8).

**Work:**
- [ ] `src/docx.rs` — read `word/document.xml`; stream `w:p` paragraphs (concat `w:t` runs; `w:br`/tabs → space); paragraphs styled `Heading1`/`Title` start chapters and title them (Heading2+ stay in-chapter text — mirrors MD's level rule); empty paragraphs dropped; metadata from `docProps/core.xml` (`dc:title`, `dc:creator`) → fallback `hint` stem
- [ ] Fixture `testdata/doc.docx`: hand-built minimal zip (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`, `docProps/core.xml`) with two Heading1 sections + noise
- [ ] Golden + idempotence tests; non-docx zip / missing document.xml → typed `Malformed { Docx }`

**Acceptance:**
- [ ] Golden green: Heading1 boundaries + titles, core.xml metadata, runs concatenated correctly
- [ ] Malformed input typed-errors cleanly

**Verify:** `cargo test -p taletrek-parse --quiet`

**Dependencies:** T1, T3 (zip/quick-xml land in T8 but the dep lines are trivial if reordered)
**Files:** `crates/parse/src/docx.rs`, `crates/parse/testdata/doc.docx`, `tests/golden.rs`
**Docs:** none
**Estimated scope:** M
