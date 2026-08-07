# Task 001: Manifest types + typed errors

**Description:** The TS mirror of the frozen v1 bundle format's JSON shapes (`manifest.json`, `text.json`, `meta/{source,processing,position}.json`) and the typed-error hierarchy that every later layer throws. This is the foundation: reader/writer/import/export all import from here. No ZIP, no IDB — pure types + error classes + a `schemaVersion` constant/guard.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/manifest.ts` exports TS interfaces for every JSON shape in `docs/bundle-format.md` §"Book bundle": `ManifestSchemaVersion` (const `1`), `ManifestKind` (`"book" | "library"`), `AudioCodec` (`"opus" | "m4a" | "wav"`), `BookMeta`, `AudioMeta`, `Generator`, `Manifest`, `TextJson` (with `ChapterText` matching the SPA's paragraph shape), `SourceMeta`, `PositionMeta`.
- [ ] `AudioCodec` reader-accept set is named (Opus + M4A + WAV for read; Opus-only for write) and exported as a const array the reader/writer share.
- [ ] `web/src/lib/bundle/errors.ts` exports the hierarchy from `spec.md` §"Code style": `BundleError` (abstract base), `UnsupportedSchemaVersionError`, `CorruptBundleError`, `UnsupportedBundleKindError`, `UnsupportedAudioCodecError`, plus `BundleTooLargeError` (resolved decision #3). Each overrides `name` and carries typed fields.
- [ ] `manifest.ts` field names map the JSON (camelCase JSON) to the SPA's branded-id TS types via the existing `bookId()`/`chapterId()`/`voiceId()` constructors where ids are involved — conversion helpers live here so the reader stays focused on ZIP/JSON.
- [ ] `text.json.chapters[].paragraphs` maps cleanly onto the SPA's `Chapter` type (same shape as `bundle-format.md` line 65 promises). The mapping helper `chapterTextToChapter()`/`chapterToChapterText()` is exported here.

**Verification:**
- [ ] `pnpm test -- bundle/manifest` green (type-level + small unit tests on the id-conversion helpers).
- [ ] `pnpm typecheck` clean.
- [ ] `pnpm lint` clean on the two new files.

**Dependencies:** None.

**Files likely touched:**
- `web/src/lib/bundle/manifest.ts` (new)
- `web/src/lib/bundle/errors.ts` (new)
- `web/src/lib/bundle/manifest.test.ts` (new, co-located)

**Docs:** None yet — gotchas land in T9 once the traps are concrete.

**Estimated scope:** Small (3 new files; pure types + small helpers, no I/O).
