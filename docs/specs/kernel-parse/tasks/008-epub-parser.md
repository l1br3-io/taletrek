# T8 — EPUB parser (zip + quick-xml + html core)

**Description:** The flagship format. EPUB = zip of XHTML + OPF package manifest. Hand-rolled thin reader: resolve the OPF, follow the spine, pull metadata, use the T7 block core for each document, prefer nav/NCX chapter titles over raw filename strings.

**Work:**
- [x] `zip` + `quick-xml` deps (zip already workspace-proven in synth)
- [x] `src/epub.rs` — open zip from bytes → `META-INF/container.xml` → OPF path; parse OPF: `dc:title`, `dc:creator`, manifest (id → href), spine (idref order); chapter titles from `nav.xhtml` (EPUB3) or `toc.ncx` (EPUB2) when resolvable, else first-heading/fallback `Chapter N`; each spine doc → `extract_blocks` (T7) → chapters. Nested/href resolution relative to the OPF dir; strip fragment anchors
- [x] Fixture `testdata/book.epub`: hand-built minimal zip (`mimetype` first, stored; `container.xml`; OPF with dc:title/dc:creator; `nav.xhtml`; two chapter XHTMLs with noise) — committed as a normal fixture, built by a checked-in test helper script if a binary blob is unpleasant to review
- [x] Golden + idempotence tests; malformed-zip and missing-OPF → typed `ParseError::Malformed { format: Epub, .. }`

**Acceptance:**
- [x] Golden green: title/author from OPF, chapters in spine order with nav titles, noise cleaned
- [x] Broken EPUB fails with the typed error, never a panic

**Verify:** `cargo test -p taletrek-parse --quiet && cargo clippy --workspace --all-targets -- -D warnings`

**Dependencies:** T7 (block core)
**Files:** `crates/parse/src/epub.rs`, `crates/parse/Cargo.toml`, `crates/parse/testdata/book.epub`, `tests/golden.rs`
**Docs:** none
**Estimated scope:** M
