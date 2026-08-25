# Task 008: Static SPA hosting + JS-app CSP + askama panel → `/ui/admin` interim

**Description:** The server becomes the SPA's origin: serve a static directory (the built `web/dist`) at `/` with SPA history fallback, behind the existing cookie/bearer auth. The current CSP (`default-src 'none'`) forbids scripts by design for the askama panel — the SPA-served paths need a real JS-app policy (`script-src 'self'`, `style-src 'self'`, `worker-src 'self'`, `connect-src 'self'`, etc.) while `/ui/*` keeps the strict no-JS policy. The askama operator panel currently owns `/` — it moves under `/ui/admin/*` as an interim no-JS ops surface (deleted in T16); `/ui/login` stays where it is.

**Acceptance criteria:**
- [x] New config: `TALETREK_STATIC_DIR` (default `./web-dist`; documented in config + `--help`-equivalent env docs) — served at `/` on the protected sub-router with SPA fallback to `index.html` for client routes (tower-http `ServeDir` + fallback service).
- [x] Missing/empty static dir: log a clear warning at boot and keep the API + `/ui/admin` working (server is still useful headless; don't crash).
- [x] CSP split: SPA responses get a JS-app policy that the built app actually needs (`script-src 'self'`; `style-src 'self' 'unsafe-inline'` only if the build genuinely inlines styles — check `dist/` and prefer avoiding it; `worker-src 'self'` blob: only if workers are blob-URL'd — verify against the real build; `connect-src 'self'`; `img-src 'self' data:`). `/ui/*` responses keep `default-src 'none'`. Set via per-route-layer middleware, headers still nosniff/DENY/no-referrer.
- [x] Askama panel routes re-mounted under `/ui/admin/` (`/ui/admin`, `/ui/admin/books/{id}`, `/ui/admin/jobs`, their POSTs); `/` and the old `POST /` no longer hit the panel; internal redirects updated.
- [x] Unauthenticated `/` → `302 /ui/login` (existing auth behavior for non-API paths).
- [x] Tests: auth gate on `/` (302 unauth, 200 + `index.html` authed when static dir has one); `/ui/admin` still renders; header split asserted (SPA response allows scripts, `/ui/*` response doesn't).
- [x] Manual: `pnpm build`, `TALETREK_STATIC_DIR=web/dist cargo run`, browser → login → SPA boots **in local mode** (datasource resolves local — expected until T13), console clean, no CSP violations.

**Verification:**
- [x] `cargo clippy` + `cargo test -p taletrek-server` green.
- [x] Manual walkthrough above (record CSP values found working in the task file's completion note — T17 re-audits).

**Completion notes (2026-08-26):**
- **CSP found working** (`SPA_CSP` in `server/src/http/spa.rs`): verbatim token list of the proven standalone policy (`web/vite.config.ts`), because the built app verifiably needs it: `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` (user-configured AI providers + local LLMs — `lib/ai/engines/openai.ts` fetches the configured `baseUrl`; task's plain `connect-src 'self'` would break AI transform in hosted mode), `worker-src 'self' blob:` (ffmpeg core is blob-`importScripts`'d, `lib/audio/ffmpeg.ts`), `media-src 'self' blob:` (blob-URL playback), `img-src 'self' data: blob:`, `style-src 'self' 'unsafe-inline'` (vConsole — bundled in dist — injects inline styles; dist CSS itself is external).
- **CSP is stamped on `text/html` responses only** (G29): a CSP header on a worker-script response would become that worker's own policy and break WASM/blob (Piper, ORT, ffmpeg). Assets stay policy-free — exactly the standalone hosting model.
- Verified in Chrome 151: login → `/` serves SPA → deep link `/library` 200 → local-mode library renders. Console: no server-introduced violations. Pre-existing (also on plain `vite preview`): Google Fonts `<link>` blocked by the build's own meta CSP (G29 #2); first-boot `Manifest: Syntax error` from Chrome's credentialless installability fetch behind cookie auth (G29 #3). Both recorded as **G29**; T17 re-audits.
- Unknown `/api/*` → 404 via `ANY /api/{*rest}` (not SPA HTML); `is_ui_path` is now "not `/api`" so SPA deep links redirect to login unauthed.
- `just dev-server` wires `TALETREK_STATIC_DIR=web/dist`.

**Dependencies:** None (parallel-friendly with Phase 1)

**Files likely touched:**
- `server/src/http/spa.rs` (new)
- `server/src/http/mod.rs` (routes + header split)
- `server/src/http/ui.rs` (panel paths → `/ui/admin`)
- `server/src/config.rs` (`TALETREK_STATIC_DIR`)
- `server/templates/*` (links to new mount paths)

**Docs:** CSP-vs-SPA findings → `/** GOTCHA */` or gotcha entry if non-obvious (e.g. blob workers).

**Estimated scope:** Medium-Large (5-7 files) — the fallback + header split is the meat; if it grows, split "panel move" from "static hosting" in-session, but land as one coherent slice.
