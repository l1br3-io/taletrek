# T7 — HTML parser (`scraper`)

**Description:** Single-file HTML → chapters via `h1`–`h6` block structure. Doubles as the content-extraction core EPUB reuses in T8 — extract it as a shared function, not an HTML-file-only path.

**Work:**
- [x] `scraper` dep
- [x] `src/html.rs` — parse a full document; walk body block elements in order (`p`, `h1`–`h6`, `blockquote`, `li`, `pre`); **`h1`** (or `h2` when no `h1` exists — decide by fixture realism) starts a chapter and titles it; other blocks join paragraphs. Extraction-only: `script/style/nav/aside/header/footer` never enter by construction. Title fallback: `<title>` → `hint` stem
- [x] Shared core shaped for T8: `extract_blocks(document_bytes_or_fragment) -> Vec<Block>` where `Block = Heading(level, text) | Paragraph(text)`; the file-level wrapper adds metadata + chapter assembly
- [x] Fixture `testdata/article.html`: title, two `h1` sections, a link, an image, a `<script>`/`<nav>` red herring
- [x] Golden + idempotence tests

**Acceptance:**
- [x] Golden green; `script`/`nav` content absent; link text kept, URL dropped (via clean seam)
- [x] `extract_blocks` is reusable (no file/URL assumptions; fragment input works)

**Verify:** `cargo test -p taletrek-parse --quiet`

**Dependencies:** T1, T3
**Files:** `crates/parse/src/html.rs`, `crates/parse/Cargo.toml`, `crates/parse/testdata/article.html`, `tests/golden.rs`
**Docs:** none
**Estimated scope:** M
