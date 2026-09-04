---
status: shipped       # draft → active → shipped   (merged 2026-09-02; the merge-commit flip was missed — done retroactively in desktop-synth-gui T11's close-out sweep)
started: 2026-08-30
---

# SPEC — Native pivot track · Effort 2: Kernel parse (`crates/parse`)

> Track context: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md) · why + locked stack: [`ideas/native-pivot.md`](../../ideas/native-pivot.md) · direction: [`ROADMAP.md`](../../ROADMAP.md).
> Closes the accepted interim gap: until now nothing converts ebooks into bundles (ADR-0015 decision 8).

## Problem

The kernel can synthesize (`crates/synth` + `crates/worker`) but not ingest: the desktop CLI is bundle→bundle only, the SPA parse pipeline was deleted with the pivot, and every `.taletrek` in existence descends from a fixture or a pre-pivot upload. The pipeline's front door — *any common ebook/document in, clean readable text out* (ROADMAP "Ingest" theme) — is missing. This effort builds `crates/parse` and wires it into the CLI, making `taletrek-desktop` the first complete file→audiobook pipeline.

## Objective (users + success)

- **User:** the maintainer today (CLI producer feeding the reader); the desktop GUI (effort 3) and Android/iOS apps (efforts 4–5) consume the same crate via UniFFI later.
- **Success looks like:** `taletrek-desktop parse --input book.epub` emits a valid text-only `.taletrek` that the web reader imports and (after `synth`) plays; EPUB/TXT/HTML/MD/DOCX/PDF all parse from committed fixtures; the chained one-command path (`synth --input book.epub`) produces a full audio bundle whose audio actually plays in the reader.

## Scope (this effort only)

1. **`crates/parse`** — new workspace crate `taletrek-parse`: pure core (`bytes in → ParsedBook out`, no fs/`Path`), format detection, per-format parsers, M4 structural cleaning at parse time, `ParsedBook → text-only BookBundle`.
2. **CLI** — new `parse` subcommand (file → text-only bundle); `synth --input <source>` auto-parses non-bundle inputs (chained pipeline). `resynth` stays bundle-only.
3. **Web (minimal)** — extend `BundleSourceFormat`/`BookFormat`/import mapping with `'html'` + `'docx'` (additive; today they would fall through the closed switch).
4. **Docs** — `bundle-format.md` sourceFormat enumeration + producer list; ROADMAP effort-2 row flips active at `/build`; AGENTS.md layout line; CHANGELOG at ship; gotcha for the clean-idempotence invariant if it survives task-level scrutiny.

## Decisions (locked — specify phase 2026-08-30)

| Area | Decision |
| --- | --- |
| Format set | **EPUB · TXT · HTML · MD · DOCX · PDF.** MOBI **deferred** (shrinking legacy format, thin Rust support; EPUB conversion covers most MOBI-era books) |
| Cleaning | **Structural M4 filters at parse time** (URLs, images, footnotes, page numbers) — bundle paragraphs are canonical clean text. Guarantees desktop-synth text == reader playback text (cache-key parity; reader derives cleaning idempotently) |
| Pronunciation | **Not applied at parse** — user-level, reader-side only (applying it would break key parity; precedent: T3 dropped the pronunciation editor for exactly this) |
| TXT chapters | **Conservative standalone-line split**: `^(chapter|part|…)\s+(number\|roman\|number-word)$` as a *whole line* — line-anchored + numbered, cannot match mid-prose the way the deleted SPA regex did. No match anywhere → single chapter |
| PDF chapters | **ADR-0008 tier-1 only**: embedded `/Outlines` is the sole deterministic source; no outline → single chapter. No heuristics, no font signals, no AI (the kernel has none) |
| Structured formats | EPUB spine+nav/NCX, MD `#` headings, HTML `h1–h6`, DOCX `Heading*` styles — deterministic structure only, no guessing |
| CLI | `parse` subcommand + chained `synth`; `--voice` optional (default curated `en_US-hfc_female-medium` stamped into the manifest) |
| UniFFI | **Ready-not-wired**: core API is `&[u8]`/`&str` in, plain data out; bindings + `uniffi.toml` land in the mobile efforts |
| Bundle format | v1 unchanged, `SCHEMA_VERSION` stays 1; `sourceFormat` vocabulary grows `html`/`docx` (additive, readers ignore unknown strings → `unknown`→`txt` per G28 keeps old readers safe) |
| Metadata | EPUB OPF `dc:title`/`dc:creator`, DOCX `core.xml`, PDF Info dict, HTML `<title>`, MD first `#` heading; fallback = filename stem (CLI passes it as a hint) |
| `headings` field | Stays empty from parse (M10 legacy field; the heuristic producer is gone) |

## Architecture

```
                     crates/parse (taletrek-parse)
  ┌─────────────────────────────────────────────────────────┐
  │ parse_source(bytes, format, filename_hint) → ParsedBook │
  │   detect.rs   magic sniffing: %PDF / PK + epub mimetype │
  │               / [Content_Types].xml                     │
  │   clean.rs    M4 structural filters (port of web        │
  │               lib/clean — strip-only, idempotent)       │
  │   txt.rs md.rs html.rs epub.rs docx.rs pdf.rs           │
  │   bundle.rs   ParsedBook → text-only BookBundle         │
  │               (via taletrek-synth bundle types)         │
  └─────────────────────────────────────────────────────────┘
        ▲ bytes                            │ BookBundle
        │                                  ▼
  desktop CLI  ── parse ──►  <stem>.taletrek ── synth ──► full bundle
        └── synth --input book.epub  (auto-parse, one command)

  ParsedBook { title, author?, source_format, chapters: Vec<ParsedChapter{title, paragraphs}> }
  — plain data, UniFFI-ready; ids/timestamps/manifest stamping happen in bundle.rs
```

Layering: `parse` depends on `taletrek-synth` for the bundle model only (the interchange format's owner). No dependency on `worker`. Desktop owns fs, path defaults (`<stem>.taletrek`), and CLI parsing — the core never touches the filesystem.

## Technologies (additions — ask-first at review)

| Crate | License | Role |
| --- | --- | --- |
| `zip` 2 (already in synth) | MIT | EPUB + DOCX containers |
| `quick-xml` | MIT | OPF/spine, `container.xml`, DOCX `document.xml` |
| `scraper` (html5ever) | MIT / MPL-2.0 | HTML + EPUB-XHTML content extraction |
| `pulldown-cmark` | MIT/Apache-2.0 | Markdown events → headings/paragraphs |
| `pdf-extract` | MIT | PDF text extraction (hardest format — spike first) |
| `lopdf` | MIT | PDF `/Outlines` tree → chapter boundaries |
| `uuid` 1 (v4) | MIT/Apache-2.0 | `bk_…` book ids |

GPL/AGPL alternatives (mupdf & friends) are rejected per G4. Crate choices get validated in the plan phase — swap-in-place allowed, scope is not.

## Commands

```
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo test -p taletrek-parse --test golden          # fixture-driven per-format tests
pnpm verify                                         # web touched (sourceFormat mapping)
taletrek-desktop parse --input book.epub            # → book.taletrek (text-only)
taletrek-desktop synth --input book.epub            # chained: parse + synth in one command
just parse-fixture                                  # NEW: fixture → text-only bundle (mirrors synth-fixture)
```

## Project structure

```
crates/parse/
  src/lib.rs          public API: parse_source, detect_format, ParsedBook, SourceFormat, ParseError
  src/detect.rs       magic sniffing (PDF / EPUB / DOCX); extension map lives at the CLI
  src/clean.rs        M4 structural filters — port of web/src/lib/clean/filters.ts (strip-only)
  src/txt.rs          paragraph split + conservative chapter-line detection
  src/md.rs           pulldown-cmark events → chapters by heading level
  src/html.rs         block/heading extraction (shared by EPUB chapters)
  src/epub.rs         zip + OPF (metadata, spine order) + nav/NCX → chapter files
  src/docx.rs         zip + document.xml paragraphs; Heading* styles → chapters
  src/pdf.rs          pdf-extract text + lopdf outline → ADR-0008 tier-1 chapters
  src/bundle.rs       ParsedBook → BookBundle (ids, timestamps, manifest, generator stamp)
  tests/golden.rs     one committed fixture per format → exact ParsedBook assertions
  testdata/           committed fixtures (incl. a PDF with + a PDF without /Outlines)
desktop/src/cli.rs    Parse { input, output?, voice? }; synth chain detection
desktop/src/main.rs   parse handler; synth auto-parse branch
web/src/lib/bundle/   import.ts + manifest.ts: 'html' | 'docx' in unions, switch, MIME map
```

## Code style

Follows the existing Rust crates (`//!` module docs, typed `thiserror` errors, `#[must_use]` on pure constructors, plain-data structs, `serde` camelCase on the wire). One real snippet beats prose:

```rust
pub enum SourceFormat { Epub, Txt, Html, Md, Docx, Pdf }

pub struct ParsedBook {
    pub title: String,
    pub author: Option<String>,
    pub source_format: SourceFormat,
    pub chapters: Vec<ParsedChapter>,
}

pub fn parse_source(bytes: &[u8], format: SourceFormat, hint: Option<&str>) -> Result<ParsedBook, ParseError>;
```

- Pure core: no fs, no clocks, no randomness *inside* parsing (ids/timestamps only in `bundle.rs` at bundle build)
- Every parser returns the same `ParsedBook` shape; format differences never leak into the CLI
- Tests co-located (`#[cfg(test)]`) for units, `tests/golden.rs` for fixtures
- No comments beyond doc comments; clippy `-D warnings` clean

## Testing strategy

- **Golden fixtures** (`tests/golden.rs`): one committed file per format (two PDFs: with/without outline; one TXT with chapter lines + URL/footnote/page-number noise) → assert the exact `ParsedBook`. This is the primary gate — no format ships without a fixture.
- **Clean idempotence**: `clean(parse fixture) == parse fixture` paragraphs, Rust-side; plus a TS-side test importing a parse-produced bundle fixture and asserting `cleanChapters` leaves it unchanged (the cross-app parity invariant).
- **TXT splitter adversarial cases**: splits `CHAPTER 7`, `Part III`, `Chapter Twelve`; does **not** split `Part of the reason was…`, `Chapter 1 was the worst day…` (the ADR-0008 false positives).
- **CLI**: `parse` flag parsing + default output path; `synth` chain branch (mock runner — real-engine chain covered by the `--ignored` test).
- **Bundle validity**: parse output round-trips `read_book_bundle`; `audio.present == false`; manifest carries `sourceFormat`/`voiceId`/generator `taletrek-desktop`.
- **Web**: import maps `docx`/`html` through (unit tests beside `import.ts`); `pnpm verify` green.
- **Real-engine e2e** (`--ignored`, needs piper+ffmpeg): `synth --input fixture.epub` → full bundle → reader import smoke via chrome-devtools MCP (matches the native-pivot T7 bar).

## Boundaries

- **Always:** fixture per format before its parser ships; clean-idempotence + cache-key parity checks green; `SCHEMA_VERSION` untouched; typed errors (no stringly failure); clippy `-D warnings`; pure core API (bytes-in, data-out).
- **Ask first:** any dependency beyond the table above (or swapping one); changes to `normalize.rs`/`cache_key.rs`/bundle wire format; new gotchas; `bundle-format.md` edits beyond the enumeration.
- **Never:** revive heuristic outline detection beyond the locked TXT line-split (ADR-0008); apply pronunciation or any user-level transform at parse; GPL/AGPL dependencies (G4); store raw (uncleaned) paragraphs; OCR scanned PDFs.

## Success criteria

1. All six formats parse their golden fixtures to the exact expected `ParsedBook`.
2. `taletrek-desktop parse --input fixture.epub --voice en_US-hfc_female-medium` writes a bundle the web reader imports (title/author/chapters correct, format labeled `epub`).
3. Chained `synth --input fixture.epub` (real piper+ffmpeg, `--ignored`) produces a bundle whose audio plays end-to-end in the reader — no cache-miss errors (proves the cleaning parity decision).
4. TXT: standalone `CHAPTER 7`-style lines split; the two ADR-0008 prose false-positives do not.
5. PDF with outline → multi-chapter; PDF without → exactly one chapter.
6. Parsed paragraphs contain no URLs, image markers, footnote refs, or page-number lines (fixture noise is stripped); pronunciation is untouched.
7. `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` + `pnpm verify` green.
8. Web import accepts `html`/`docx` sourceFormats (unit-tested both sides).

## Non-goals (this effort)

MOBI (deferred — revisit via a later pass or ADR), AI outline detection (no AI in the kernel), pronunciation at parse, OCR for scanned PDFs, RTF/FB2/other formats, cover images (bundle v1 has no field), language detection / voice auto-pick, drag-drop upload in the web reader, the desktop GUI (effort 3), UniFFI bindings (efforts 4–5), paragraph length caps (existing per-paragraph synth behavior unchanged).

## Risks

| Risk | Mitigation |
| --- | --- |
| `pdf-extract` text quality on real PDFs (ideas one-pager flags PDF hardest) | Spike task first in the plan; fixtures commit the accepted quality bar; single-chapter fallback is always valid output |
| EPUB real-world variety (broken spines, entities, encoding) | Hand-rolled thin reader on zip+quick-xml we fully control; fixtures grow as cases arrive; lossy UTF-8 decode (`from_utf8_lossy`) never fails a parse |
| Clean port drift vs web `lib/clean` | Idempotence test is the contract: whatever the reader re-derives must not change parsed text; TS-side test pins it |
| `scraper`/html5ever weight in future mobile binaries | Accepted now (MIT/MPL, pure Rust); revisit in the android effort if binary size hurts |

## Open questions (plan phase, not blockers)

- Exact fixture provenance for PDFs (hand-written minimal vs generated-then-committed) — task T0 decides.
- Whether `parse` also accepts multiple `--input` files (batch) — lean no until asked.
- `uuid` vs hand-rolled id generation (workspace currently has neither).
