# Task 004: Migrate reader-path callers through the facade

**Description:** First migration slice: the reader route and playback stack. `ReaderPane`, `useProgressPersistence`, `useCachedParagraphs`, and the player hooks (`usePlayer` audio probing: cached-paragraph indicators, whole-book `getBookAudio` for the preloaded engine) switch from direct `lib/db` imports to the `LocalDatasource` singleton from T3. Playback state itself stays where it is (house rule: never Context) — only data access is re-pointed.

**Acceptance criteria:**
- [ ] `routes/reader/*` and `players/*` no longer import from `lib/db`; they import the datasource singleton.
- [ ] Behavior identical: progress persistence writes the same shapes at the same moments; cached-paragraph indicators light up the same; preloaded (FFmpeg whole-book) player still reads `bookAudio`; Web Audio path untouched.
- [ ] Any audio-probe method the players need that T2/T3 missed is added to the interface first (small T2 amendment in the same change, noted in the commit body).
- [ ] Reader tests (existing, co-located) green unmodified — they are the fence; test *code* may only change import paths, never assertions.

**Verification:**
- [ ] `pnpm test` green.
- [ ] `pnpm verify` green.
- [ ] Manual smoke (dev server): open a synthesized book, play, seek, close/reopen — position restored.

**Dependencies:** T3

**Files likely touched:**
- `web/src/routes/reader/ReaderPane.tsx`
- `web/src/routes/reader/useProgressPersistence.ts`
- `web/src/routes/reader/useCachedParagraphs.ts`
- `web/src/players/usePlayer.ts` (probe paths)
- `web/src/lib/datasource/types.ts` (probe amendments if needed)

**Docs:** None expected.

**Estimated scope:** Medium (4-5 files)
