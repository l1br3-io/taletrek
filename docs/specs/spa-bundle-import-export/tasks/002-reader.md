# Task 002: Reader (jszip unzip + validate)

**Description:** Pure `bytes → BookBundle` reader. Takes a `Uint8Array`/`ArrayBuffer` (the `.taletrek` file contents), unzips with `jszip`, parses `manifest.json` + `text.json` + present `meta/*`, validates against the T1 types, and returns a structured in-memory `BookBundle`. Throws the T1 typed errors on every refusal path. No IDB, no DOM.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/reader.ts` exports `readBookBundle(bytes: Uint8Array): Promise<BookBundle>` where `BookBundle` is `{ manifest: Manifest; chapters: ChapterText[]; audio: Map<string, Uint8Array>; meta: { source?: SourceMeta; processing?: AppliedProcessing; position?: PositionMeta } }`.
- [ ] Refuses `schemaVersion` missing or `!== 1` → `UnsupportedSchemaVersionError` (never best-effort loads). Reads the field before any other validation.
- [ ] Refuses `kind: "library"` → `UnsupportedBundleKindError` with the SPA-specific message. (Book bundles only in this effort.)
- [ ] Accepts a text-only bundle in **both** absence shapes: `audio.present === false` AND `audio/` directory empty/missing. `bundle.audio` is then an empty `Map`.
- [ ] Accepts a full bundle: every `audio/<cache-key>.<ext>` entry is loaded into the `audio` Map keyed by the entry's base cache key. The reader does **not** verify the key matches a paragraph (that's the parity test's job) — it just loads what's present.
- [ ] Missing `manifest.json` or `text.json`, or a truncated/non-ZIP input → `CorruptBundleError`.
- [ ] Manifest's `audio.codec` not in the reader-accept set → `UnsupportedAudioCodecError`.
- [ ] `meta/{source,processing,position}.json` parsed when present; absent entries stay `undefined`.
- [ ] Reuses `jszip` (already a dep). No new dependency.

**Verification:**
- [ ] `pnpm test -- bundle/reader` green: synthetic bundles built in-memory via the (not-yet-written) writer are read back correctly; each refusal path has a dedicated test producing the right typed error.
- [ ] Until T4 (writer) lands, reader tests build fixtures by hand with `jszip` directly in the test file — T4 will refactor those to use the writer.
- [ ] `pnpm typecheck` + `pnpm lint` clean.

**Dependencies:** T1 (types + errors).

**Files likely touched:**
- `web/src/lib/bundle/reader.ts` (new)
- `web/src/lib/bundle/reader.test.ts` (new)

**Docs:** If jszip surfaces a non-obvious trap (e.g. entry-name encoding for `:` in cache keys), inline `/** GOTCHA */` comment in `reader.ts`.

**Estimated scope:** Medium (2 new files; one non-trivial pure function with many validation branches).
