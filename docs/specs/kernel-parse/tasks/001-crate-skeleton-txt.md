# T1 — Crate skeleton: `crates/parse` + `ParsedBook` + format detect + TXT (plain)

**Description:** Stand up the `taletrek-parse` crate with its full public API surface and the first working format: plain TXT (paragraph split, single chapter, no cleaning yet — that's T3). Establishes the golden-fixture test harness every later format plugs into.

**Work:**
- [ ] `crates/parse/Cargo.toml` (workspace member via `crates/*` glob; deps this task: `thiserror`, `serde`) + workspace lint inheritance (`unsafe_code = forbid`, `missing_docs = warn` — doc comments required on all public items)
- [ ] `src/lib.rs` — public API: `SourceFormat` enum (`Epub|Txt|Html|Md|Docx|Pdf`), `ParsedBook { title, author, source_format, chapters }`, `ParsedChapter { title, paragraphs }`, `parse_source(bytes, format, hint) -> Result<ParsedBook, ParseError>`, `detect_format(bytes) -> Option<SourceFormat>`
- [ ] `src/detect.rs` — magic sniffing: `%PDF` → Pdf; zip containing `mimetype` = `application/epub+zip` → Epub; zip containing `[Content_Types].xml` → Docx. TXT/MD/HTML are extension-mapped at the CLI, not sniffable
- [ ] `src/txt.rs` — blank-line paragraph split, `from_utf8_lossy` (parse never fails on encoding), single chapter titled from `hint` filename stem (fallback `"Untitled"`)
- [ ] `tests/golden.rs` + `testdata/plain.txt` — first fixture; exact `ParsedBook` assertion
- [ ] Unit tests: detect on PDF/EPUB/DOCX magic bytes; lossy-UTF8 TXT

**Acceptance:**
- [ ] `parse_source(txt_bytes, Txt, Some("book.txt"))` returns exact expected `ParsedBook` from the fixture
- [ ] No fs/`Path`/clock/rand anywhere in the crate (API speaks `&[u8]`/`&str` only)

**Verify:** `cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace --quiet`

**Dependencies:** None
**Files:** `crates/parse/{Cargo.toml, src/{lib,detect,txt}.rs, tests/golden.rs, testdata/plain.txt}`, root `Cargo.toml` (no change — glob member)
**Docs:** none (spec covers it)
**Estimated scope:** M
