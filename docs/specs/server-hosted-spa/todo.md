# TODO — Effort 5: Server-hosted SPA

> Spec: [`spec.md`](./spec.md) · Plan: [`plan.md`](./plan.md) · ADR-0014 (Task 1).
> Track this file for live status; flip `[ ]` → `[x]` as work lands.

## Phase 0 — Decision record
- [x] T1: ADR-0014 — dual-shape SPA amends ADR-0013 alt-2 (`tasks/001-adr-0014-dual-shape.md`)

## Phase 1 — SPA datasource seam (pure refactor)
- [x] T2: `datasource/types.ts` — `LibraryDatasource` + `SynthPipeline` interfaces (`tasks/002-datasource-types.md`)
- [x] T3: `datasource/local.ts` — local wrappers + parity tests (`tasks/003-datasource-local.md`)
- [x] T4: Migrate reader-path callers (`tasks/004-migrate-reader-callers.md`)
- [x] T5: Migrate library-path callers (`tasks/005-migrate-library-callers.md`)
- [x] T6: Finish migration + no-direct-import grep gate (`tasks/006-migrate-finish-gate.md`)

### Checkpoint: Refactor fence — `pnpm verify` green, standalone PWA identical, UI off `lib/db` (allowlist: settings, secureKeyring).

## Phase 2 — Server hosts SPA + completes API
- [x] T7: `GET /api/session` (`tasks/007-api-session.md`)
- [x] T8: Static SPA serving + CSP + panel → `/ui/admin` interim (`tasks/008-static-spa-hosting.md`)
- [x] T9: Chapters — lazy SQLite explode + endpoint (`tasks/009-api-chapters.md`)
- [x] T10: Audio-by-content-key endpoint (`tasks/010-api-audio-by-key.md`)
- [x] T11: Progress PATCH + position column (`tasks/011-api-progress.md`)
- [x] T12: Dev workflow — Vite proxy + `just dev` (`tasks/012-dev-proxy.md`)

### Checkpoint: SPA hosted, API complete — curl round-trip on new endpoints; served SPA in local mode.

## Phase 3 — `ServerDatasource` + hosted UX
- [x] T13: `resolve.ts` boot probe + `server.ts` library ops (`tasks/013-server-datasource.md`)
- [x] T14: Remote synth pipeline (`tasks/014-remote-synth-pipeline.md`)
- [x] T15: Remote playback (`tasks/015-remote-playback.md`)
- [x] T16: Hosted parity + delete askama panel (`tasks/016-hosted-parity-delete-panel.md`)
- [ ] T17: SW `/api` network-only + affordances audit (`tasks/017-sw-scoping.md`)

### Checkpoint: End-to-end hosted flow — login → upload → server synth (tab closed) → reopen → play. Safari/Opus check (R2).

> T13 verification notes (2026-08-28): `just dev` with a seeded server — probe 200 → `datasource mode: server`; 401 (no cookie) → `/ui/login` redirect, post-login cookie lands back on `/` in server mode; library lists the server book; reader loads chapters (lazy explode) + position PATCH round-trips (`position.progressFraction` piggybacks on the verbatim T11 body). Standalone check: `pnpm dev` with no server → proxy 502 → `datasource mode: local`, PWA boots identically. Hosted Play currently refuses with "On-device playback synthesis is not available while hosted by the server." (`serverPlaybackEngine` holds the T15 engine slot — no Piper/wasm downloads hosted). Audio probing decided per task: single `GET /api/books/:id` → `audioPresent && voiceId` match marks every non-empty paragraph (whole-book synth, bundle rewritten atomically at completion).

> T14 verification notes (2026-08-28, real piper — `TALETREK_PIPER` seeded voice, served `web/dist` behind login, Chrome-driven): upload EPUB in hosted mode → browser parse → `POST /api/books` 201 → `POST …/synth` 202 → banner ticks `2/21 → …` → "'Caravan Nights' is ready." Failure path exercised for real (server started without `TALETREK_PIPER` → job `failed` → error banner carried the server's message; Retry after fixing env re-ran to green). R5 reload mid-job: 192-¶ book reloaded at 2/192 → boot recovery re-adopted, banner resumed `40/192`. Headline demo: closed the tab at ~40/192 → server ran to `succeeded 192/192` (curl-verified) → reopened → library shows the book ready (no banner), `audioPresent: true`. Design notes: `ingestBook` POSTs the text-only bundle at upload time (so `synthesizeOnUpload: off` + reader + library work without `startJob`); `startJob` never re-POSTs (probes dto → synth-or-resynth; 409 adopts the in-flight job); `cancel()` = stop polling only, job runs on (doc'd on the method); hosted transform runs client-side then re-POSTs + resynths under the book's current voice (probed pre-re-POST — the re-POST resets `audioPresent`). Known follow-ups for T16/T17: banner copy "Keep this tab open…" is wrong hosted (nothing pauses), and the Google-Fonts CSP console error is the known G29.

> T15 verification notes (2026-08-28, real piper + served `web/dist`, Chrome-driven): `serverPlaybackEngine` replaced by `createServerPlaybackEngine` (`lib/datasource/remote-playback.ts`) — `synthesize` = `audioCacheKey` (existing path) → `GET /api/books/:id/audio/:key` (raw-colon key) → `Blob`; both players consume it unchanged (desktop `<audio>`, mobile Web Audio `decodeAudioData`), nothing touches IDB (indicators stay server-probed). Live walkthrough: seeded `bk_sample` (3 ¶, real Opus) → Play fetched every key 200 `audio/ogg` → blob playback → auto-advance → "Finished"; paragraph-click seek re-anchored; reload → position PATCH round-trip (`{chapterIndex, paragraphIndex, progressFraction}`) → resume + replay from saved spot; coarse-pointer emulation exercised the Web Audio scheduler path (decode → MediaStream → hidden `<video>`, auto-advance OK). **Key-parity fix discovered en route:** the hosted bundle carried raw parse text while the reader plays its cleaned view — keys diverged under the default (enabled) cleaning. `ingestBook` now applies the stored cleaning config before the bundle write (egress cleaning; `DEFAULT_CLEANING` moved to `lib/clean/types.ts`), so bundle text == reader text == key input; proven live by uploading a txt with a URL + page-number line ("See https://… for details." / "14") → server synth → all cleaned paragraphs fetched 200 and played. Soft spot (accepted, mirrors local cache-key staleness): toggling the cleaning config *after* upload 404s affected paragraphs until re-upload/re-transform. **R2 Safari/Opus: deferred** — no Safari hardware in this environment; evidence carried from effort-4 runbook §4 (browser-driven import + `<audio>` playback of the same Opus bytes, @ 22508db 2026-08-24) plus today's Chrome proof of both decode paths. Caveat for T16/T19: Ogg/Opus in `<audio>`/`decodeAudioData` is historically unsupported on Safari — hosted playback there likely needs a wav/m4a-codec bundle or transcode; verify on real hardware before claiming Safari support.

> T16 verification notes (2026-08-29, real piper + served `web/dist`, Chrome-driven + curl; commits `94a4797`, `ae38730`, `773591b`): **Parity** — Settings swaps the on-device voice manager for the `GET /api/voices` picker (`fetchServerVoices` + module-cached `useServerVoices`; VoicePicker renders select-only without storage props) and hides Storage/Backup/Danger-zone, adding a Server-account group whose plain-form `POST /ui/logout` (new endpoint, unauthenticated by design) clears the HttpOnly cookie + 303s to `/ui/login`; library hides Import/Export/Rename/Outline via the provider mode only, per-book Synthesize opens `SynthVoiceSheet` (pick → `startJob` under that voice), cards render synth chips (live running %, failed with the server's error as title, Audio ready) from live state ∨ `listRecentJobs()` (new seam method; local answers `[]`), delete surfaces the server's 409 job-running refusal, and mid-session 401s redirect to the login gate (library + reader loaders). Banner copy hosted: "Synthesis runs on your server — this tab is only watching." **Live walkthrough:** login → upload txt (URL + page number) → auto-synth hfc → "Audio ready" chip → reader Play (3 keys 200) → Synthesize sheet → Ryan → resynth succeeded 3/3 → banner "Audio updated" → chip "Audio ready" (Ryan-voiced key serves `audio/ogg`) → Delete (confirm) → empty library → Settings shows hosted sections + Log out. **Panel deletion** — `/ui/admin/*` routes/handlers/views/templates gone (ui.rs is the login-page renderer; login-flow tests moved to auth.rs; spa.rs + header tests probe `/ui/login`/`/api/session`); `/ui/{*rest}` catch-all 404s so panel URLs don't boot the SPA (`/ui/admin` 404 authed+anon, `/ui/login` 200 anon). **Live-found bug:** the production SW's navigateFallback served index.html for `/ui/login`, making the post-logout 401-redirect loop forever — fixed with `navigateFallbackDenylist: [/^\/api\//, /^\/ui\//]` (denylist verified in the built sw.js; logout's server side curl/unit-verified). The in-browser logout re-check after the SW fix is pending (the DevTools MCP session wedged mid-verification) — folded into T17's SW walkthrough. **Drive-by:** restored `onRename` forwarding in LibraryList (dropped by 76ae442; Rename reappears in local mode). Gates: `pnpm verify` + `cargo clippy -D warnings` + `cargo test --workspace` green (138 server tests).

## Phase 4 — Deploy + ship
- [ ] T18: Dockerfile builds SPA + docker e2e (`tasks/018-docker-builds-spa.md`)
- [ ] T19: Deploy guide + runbook + CHANGELOG + final gates (`tasks/019-deploy-guide-ship.md`)

### Final gates (run @ T19, branch `server-hosted-spa`)
- [ ] `cargo build` + `cargo clippy --workspace --all-targets -- -D warnings` + `cargo test --workspace` green
- [ ] `pnpm verify` green
- [ ] `docker build -f server/Dockerfile .` succeeds; `docker run` → login → hosted SPA → full walkthrough
- [ ] Manual runbook walkthrough recorded below (real piper + ffmpeg)
- [ ] `spec.md` `status:` flips `draft → active` on /build checkpoint; `shipped` on merge

## Follow-on (NOT this effort)
- [ ] Offline-capable hosted mode / cross-mode sync
- [ ] SSE/WebSocket live progress; job-list pagination
- [ ] Cross-book content-addressed audio store + Range streaming
- [ ] Remote-server mode for the standalone PWA (CORS + token in settings)
- [ ] Worker-mode desktop queue; server-side raw-file parsing; multi-user
