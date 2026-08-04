# Task 006: Export (voice recovery, text-only vs full)

**Description:** The IDB seam on the egress side. Reads a library book out of IDB and produces a `BookBundle` ready for the T4 writer. The non-obvious work is **voice recovery**: the SPA has no `voiceId` field directly on `Book` (it lives denormalized on `AudioCacheRecord.voiceId` and transiently on `PersistedUploadJob`). Export must recover the voice from cached audio (or refuse full export per resolved decision #2), and must support text-only export regardless.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/export.ts` exports `exportBookBundle(bookId: BookId, opts: { full: boolean }): Promise<BookBundle>`.
- [ ] `full: true` — collects every paragraph across the book's chapters (via `getChaptersByBook`), recovers the voice from a cached `AudioCacheRecord` for the book (via `getAudioCacheKeysByBook` → fetch one record → read `.voiceId`), then loads every audio entry whose key matches `audioCacheKey(voice, paragraphText)`. Builds the `audio` Map.
- [ ] `full: true` with no recoverable voice (no `audioCache` entries, no `uploadJob`) → throws a typed `NoAudioToExportError` (sibling of the T1 errors): "This book has no synthesized audio to export. Export a text-only bundle instead and synth it on the desktop." (resolved decision #2.)
- [ ] `full: false` (text-only) — writes `manifest.book.voiceId` from the recovered voice if available, else from the user's current default voice in settings (`getSetting('voiceId')`). Always succeeds. (resolved decision #2.)
- [ ] Populates `meta/*` from `Book`: `position.json` ← `Book.position`; `processing.json` ← `Book.processing`; `source.json` ← the `files` store record (`getBookFile`) when present.
- [ ] Stamps nothing — the T4 writer owns generator/codec stamping. `export.ts` returns a `BookBundle` whose `manifest.audio.present` reflects `opts.full`; the writer finalises.
- [ ] `export.test.ts` uses `fake-indexeddb`: full export of a book with cached audio yields the right segment count + voice; text-only export of a voice-less book stamps the default-settings voice; `full: true` on a voice-less book throws `NoAudioToExportError`.

**Verification:**
- [ ] `pnpm test -- bundle/export` green (fake-indexeddb).
- [ ] Combined with T5: an end-to-end lib test (or the Phase-3 checkpoint test) imports a bundle, exports it, and confirms the export reproduces a conformant archive (round-trip at the IDB seam).
- [ ] `pnpm typecheck` + `pnpm lint` clean.

**Dependencies:** T1 (types/errors), T4 (writer consumes the `BookBundle` this produces; the writer must exist for the round-trip assertion). Soft-depends on T5 for the combined round-trip test.

**Files likely touched:**
- `web/src/lib/bundle/export.ts` (new)
- `web/src/lib/bundle/export.test.ts` (new)
- `web/src/lib/bundle/errors.ts` (add `NoAudioToExportError`)

**Docs:** Inline comment in `export.ts` on **why** the voice is recovered from `AudioCacheRecord` not `Book` (the data-model quirk surfaced in planning).

**Estimated scope:** Medium (2 new + 1 small edit; the voice-recovery + two-mode logic is the substance).
