# Task 005: Import (new-id-on-collision, audio dedup, size guard)

**Description:** The IDB seam on the ingest side. Takes a `BookBundle` (from the T2 reader) and writes it into the SPA's existing IDB stores so it becomes a first-class library book that plays immediately. Allocates a fresh `BookId`/`ChapterId`s on collision with an existing book (format-doc rule; never overwrites). Audio flows into the existing content-addressed `audioCache` so dedup with on-device-synth'd audio is automatic. Mirrors `backup.ts`'s `BackupTooLargeError` pre-flight.

**Acceptance criteria:**
- [ ] `web/src/lib/bundle/import.ts` exports `importBookBundle(bundle: BookBundle): Promise<{ bookId: BookId; imported: { chapters: number; audio: number } }>`.
- [ ] Always allocates a **fresh** `BookId` (via `newBookId()`) and fresh `ChapterId`s (via `newChapterId()`) — never reuses the bundle's ids verbatim, so re-importing the same bundle creates a second book (format-doc §Conformance; resolved decision: not the backup.ts skip). The bundle's original ids are not carried.
- [ ] Writes the book via `putBook` and chapters via `putChapters` (existing db API). `sourceFormat: "unknown"` (bundle allows it) maps to SPA `BookFormat` `'txt'` (resolved decision / gotcha).
- [ ] For a full bundle, writes each `audio` Map entry into `audioCache` via `putAudioCacheEntry`, keyed by the entry's cache key. Because the key is content-addressed, paragraphs already cached under the same voice dedup automatically (no duplicate writes, no size growth).
- [ ] Restores `meta/*`: `position.json` → `Book.position`; `processing.json` → `Book.processing`; `source.json` → the `files` store via `putBookFile` (provenance).
- [ ] Pre-flight size guard: estimates the bundle's IDB footprint (sum of `audio` byte lengths + chapter text) and, if `navigator.storage.estimate()` indicates insufficient remaining quota, throws `BundleTooLargeError` (T1) **before** writing anything. Mirrors `backup.ts`'s `BackupTooLargeError`.
- [ ] `import.test.ts` uses `fake-indexeddb`. Asserts: import twice → two books with distinct `BookId`s, both playable; second import of the same full bundle writes **zero** new `audioCache` entries (dedup); `meta/*` lands on the right `Book` fields; size guard throws on a stubbed-low quota.

**Verification:**
- [ ] `pnpm test -- bundle/import` green (fake-indexeddb).
- [ ] `pnpm typecheck` + `pnpm lint` clean.
- [ ] No new IDB store; no schema migration (existing stores only).

**Dependencies:** T1 (types/errors), T2 (reader produces the `BookBundle` input shape).

**Files likely touched:**
- `web/src/lib/bundle/import.ts` (new)
- `web/src/lib/bundle/import.test.ts` (new)

**Docs:** The `sourceFormat: "unknown" → "txt"` mapping gets a `/** GOTCHA */` inline comment in `import.ts` (T9 will add the `gotchas.md` index line if it proves non-obvious).

**Estimated scope:** Medium (2 new files; IDB write orchestration + dedup reasoning + size guard).
