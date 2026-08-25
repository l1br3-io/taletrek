# Task 015: Remote playback — audio-by-key fetch feeding the existing players

**Description:** Hosted reading plays server audio without importing anything. The reader's player stack (G22 pluggable engines) gets a remote source: paragraph audio fetched from `GET /api/books/:id/audio/:key` (T10), decoded through the same paths the T3 import already proved (Web Audio `decodeAudioData` / `<audio>` element per engine). The cache-probe surface from T4/T13 (buffered indicators) maps to "paragraph has audio" knowledge the server provides. **This task carries risk R2 (Safari/Opus) — verify early on real hardware.**

**Acceptance criteria:**
- [ ] A remote audio source implements whatever seam T4 settled (engine or datasource method): fetch-by-key → `Blob`/`ArrayBuffer` → existing decode/playback paths. Desktop `<audio>` + mobile Web Audio engines both work against remote bytes; FFmpeg whole-book preloaded engine is local-only and simply not selected in server mode.
- [ ] Content keys computed by the *existing* `audioCacheKey` path — no reimplementation (keys must match server-side `manifest` naming by construction).
- [ ] Playback UX identical: scheduler behavior (G23), seek re-anchor, auto-advance, Media Session metadata.
- [ ] Buffered/cached indicators reflect server knowledge (probed keys), not IDB.
- [ ] Vitest mocked-fetch: fetch-mapping, missing-key (404 → skip/synthesize-later surface, never a crash), sequential prefetch behavior if the player does read-ahead.
- [ ] **Manual Safari/Opus check (R2):** on real Safari hardware (or explicitly recorded deferral with evidence from effort-4's runbook §4), play a synthesized book end-to-end in hosted mode. Record outcome in todo.md before T16.

**Verification:**
- [ ] `pnpm test` + `pnpm verify` green.
- [ ] Manual: hosted read of a full book — play, seek, background-tab, lock/unlock on Android or desktop Safari check per above.

**Dependencies:** T13 (datasource/provider), T10 (endpoint), T4 (player seam)

**Files likely touched:**
- `web/src/players/*` (source wiring — ideally one new module `remote-source.ts`)
- `web/src/lib/datasource/server.ts` (audio fetch methods)
- `web/src/routes/reader/*` (probe usage — only if T13 left it stubbed)

**Docs:** Safari findings → gotchas.md entry if a new trap appears (else inline).

**Estimated scope:** Medium-Large (3-5 files)
