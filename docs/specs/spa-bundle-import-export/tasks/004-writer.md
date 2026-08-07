# Task 004: Writer (jszip deflate + Opus stamp)

**Description:** Pure `BookBundle → bytes` writer — the inverse of T2. Produces a `.taletrek` ZIP that the T2 reader reads back (in-memory round-trip) and, by the parity principle, the Rust reader accepts. Stamps the manifest with the `taletrek-spa` generator at the SPA's version and the Opus codec for full bundles. No IDB.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/writer.ts` exports `writeBookBundle(bundle: BookBundle): Promise<Uint8Array>`.
- [ ] Emits `manifest.json` with `schemaVersion: 1`, `kind: "book"`, `generator: { app: "taletrek-spa", version: <SPA version> }`. For full bundles: `audio.present === true`, `codec === "opus"`, `segmentCount === bundle.audio.size`. For text-only: `audio.present === false`, no `audio/` entries.
- [ ] Emits `text.json` with the chapters in `text.json.chapters` shape (`bundle-format.md` line 67).
- [ ] Each `audio` Map entry becomes `audio/<key>.opus` (entry name = the cache key, `.opus` extension matching the codec).
- [ ] Emits `meta/source.json`, `meta/processing.json`, `meta/position.json` only when the corresponding `bundle.meta` field is present.
- [ ] `writer.test.ts` round-trips: build a `BookBundle` in memory → `writeBookBundle` → `readBookBundle` (T2) → assert deep equality on manifest + chapters + audio keys + meta. Also asserts the manifest-stamping fields.
- [ ] After T4, refactor T2's hand-built `jszip` fixtures to use `writeBookBundle` instead (DRY; the reader tests now exercise the real production writer for their inputs).
- [ ] Reuses `jszip`; no new dependency.

**Verification:**
- [ ] `pnpm test -- bundle` green (reader + writer + parity all pass).
- [ ] `pnpm typecheck` + `pnpm lint` clean.

**Dependencies:** T1 (types), T2 (reader, for the round-trip test). Soft-depends on T3 (the parity test stays read-only; the writer doesn't need it, but the round-trip principle is the same).

**Files likely touched:**
- `web/src/lib/bundle/writer.ts` (new)
- `web/src/lib/bundle/writer.test.ts` (new)
- `web/src/lib/bundle/reader.test.ts` (refactor fixtures to use `writeBookBundle`)

**Docs:** None beyond existing.

**Estimated scope:** Medium (2 new + 1 refactored file).
