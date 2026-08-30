# T4 — `bundle.rs`: ParsedBook → text-only BookBundle

**Description:** The interchange hop: wrap a `ParsedBook` into the v1 text-only `.taletrek` shape using `taletrek-synth`'s bundle model (parse depends on synth for types + `write_book_bundle` only). Ids, timestamps, and the manifest are born here — the one place the core touches uuid/clock.

**Work:**
- [ ] `src/bundle.rs` — `to_text_only_bundle(book: &ParsedBook, voice_id: &str, generator: Generator) -> BookBundle`: `bk_<uuid-v4>` id, `ch_{book_id}_{index}` chapter ids, now-ms timestamps, `Manifest { schema_version: 1, kind: Book, book: BookMeta{…, audio: absent}, audio: AudioMeta{present:false, …} }`, `ChapterText` mapping (`headings` stays empty)
- [ ] `SourceFormat` → manifest `source_format` string map (`epub|txt|html|md|docx|pdf` — never `unknown`; MOBI absent by scope)
- [ ] `uuid` dep (v4) added to `crates/parse` — the one new dep this task
- [ ] Generator is a **parameter** (mirrors `stamp.rs`'s parameterized-app pattern) so the desktop GUI/apps stamp their own ids later; no `taletrek-desktop` string inside the crate
- [ ] Round-trip test: `to_text_only_bundle` → `write_book_bundle` → `read_book_bundle` → manifest + chapters equal; `audio.present == false`; `SCHEMA_VERSION` untouched at 1

**Acceptance:**
- [ ] Round-trip green; manifest fields (title/author/sourceFormat/voiceId/chapterCount/timestamps/generator) all correct
- [ ] No fs — bundle bytes return; file write stays desktop-side (T5)

**Verify:** `cargo test -p taletrek-parse --quiet && cargo clippy --workspace --all-targets -- -D warnings`

**Dependencies:** T1 (T3 ordering not required but natural — cleaned text is what gets wrapped)
**Files:** `crates/parse/src/bundle.rs`, `crates/parse/{Cargo.toml, src/lib.rs}` (dep + re-export), tests
**Docs:** none
**Estimated scope:** S
