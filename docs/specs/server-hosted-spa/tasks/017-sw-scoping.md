# Task 017: Service worker `/api` network-only + hosted-affordances audit

**Description:** Make the PWA layer safe and coherent in hosted mode. The service worker must never cache `/api` (R3/G3): network-only, failed network = error (hosted mode is online-only by decision). Audit what else the SW + manifest do when served from the server origin: precache of app shell is fine (and speeds reloads), but nothing may cache API responses; offline fallback page in server mode should not pretend the library works offline.

**Acceptance criteria:**
- [x] SW fetch handler: `/api/*` (and `/ui/login`) bypass cache entirely — pass-through with no cache.put on any status.
- [x] Manifest/SW scope sane when served at server origin (paths relative — verify no absolute localhost:8253 assumptions leak into the build).
- [x] Offline behavior in server mode: app shell may load, library shows an explicit offline/empty state — never stale data masquerading as current.
- [x] Audit pass (record in task completion): CSP values from T8 vs actual runtime requests (workers, fonts, connect-src) in the hosted build; any relaxation documented with justification (spec boundary: CSP relaxation requires ask-first).
- [x] `pnpm verify` green; manual hosted check with DevTools "Offline" toggle shows the intended states.

**Verification:**
- [x] `pnpm test` + `pnpm verify` green (SW tests co-located per house pattern if they exist — extend).
- [x] Manual: hosted app → DevTools offline → correct empty/offline states; back online → recovers without reload weirdness.

## Completion record (2026-08-29)

**SW rule.** `runtimeCaching` gained a first-listed `NetworkOnly` route for `/api/*` + `/ui/*` (superset of `/ui/login` — the whole server-rendered namespace). Verified in the built `dist/sw.js`: `registerRoute( pathname.startsWith("/api/")||startsWith("/ui/"), new NetworkOnly, "GET")` alongside the T16 `navigateFallbackDenylist: [/^\/api\//, /^\/ui\//]`; the wasm `CacheFirst` route is unchanged. `NetworkOnly` never calls `cache.put` (any status) and a failed network rejects — hosted mode is online-only by decision. GOTCHA comment added at the rule + G3 now links it.

**Scope/origin audit (built `dist/`).** `manifest.webmanifest`: `start_url:"/"`, `scope:"/"`, `id:"/"`, root-relative icons. `sw.js` precache manifest + `registerSW.js`: all relative URLs. The only absolute URLs in `dist/index.html` are CSP policy tokens and the known-dead Google Fonts link (G29). No `localhost:8253` or origin assumptions leak. (The `allowedHosts` entry in `vite.config.ts` is dev-server-only.)

**Offline states (implementation).**
- Boot probe (`resolve.ts`): a definitive answer (200/401) persists a `taletrek:hosted-shape` localStorage marker; 404 clears it; 5xx leaves it. An unreachable probe + marker → **server mode** (offline reload of the hosted shape no longer masquerades as an empty standalone library). Storage failures degrade to the old behavior; G2 eviction worst-case equals pre-marker behavior.
- Library (`useLibraryState` + `LibraryPage`): failed initial load → explicit `Can't reach your TaleTrek server.` error state with a **Try again** button (never an eternal spinner, never "Your library is empty"); already-rendered data is kept and labeled by an amber **"Offline — showing your library as it last loaded. It syncs when you reconnect."** banner when `navigator.onLine` drops; an online-transition effect re-fetches automatically on reconnect (no reload).
- Reader (`ReaderPane` loader): non-401 load failures render a `Couldn't load this book.` error state instead of re-throwing into an unhandled rejection + eternal Loading.

**CSP audit (T8 `SPA_CSP` vs hosted runtime).** `server/src/http/spa.rs` `SPA_CSP` remains token-identical to `web/vite.config.ts`'s meta CSP. Runtime requests: parse/tts/concat workers are same-origin bundled assets (`worker-src 'self'` ✓; ffmpeg blob-core fallback covered by `worker-src … blob:`); `connect-src 'self' https: http://localhost:* http://127.0.0.1:*` covers same-origin `/api` + user-configured AI providers; playback is blob-URL audio (`media-src 'self' blob:` ✓). Fonts: the index.html Google-Fonts stylesheet link stays CSP-blocked in prod (both shapes) — the `--font-mono` chain falls back to `ui-monospace` (verified in `styles/index.css`); documented G29, removal deferred. **No CSP relaxation was needed — the audit found zero gaps.**

**Manual walkthrough** (CDP-driven Chrome 151, served `web/dist` behind login, DevTools-style offline emulation applied to page + SW targets): login → SW `activated`, marker `"1"` → upload txt → book listed → **offline + reload** → SW shell + explicit error state (no empty-library masquerade) → **Try again** after reconnect → list recovered → **mid-session offline** → banner over the loaded list → reconnect → banner cleared, auto re-synced → CacheStorage audit: only `workbox-precache-v2-…` exists, **zero `/api` or `/ui` URLs cached** after the full flow → offline navigation to `/ui/login` fails to load rather than booting the SPA (denylist + NetworkOnly proven live). Screenshots: `/tmp/opencode/t17-shots/0*.png` (session-local).

**CDP gotcha found while verifying:** `Network.emulateNetworkConditions` on the page target does not cover service-worker fetches — the SW target needs its own emulation, and the session that sets it must stay attached (emulation auto-resets when its session closes). Not a product issue; recorded here for future browser-driven verification runs.

**Dependencies:** T8 (CSP baseline), T13+ (hosted mode exists); before T18

**Files likely touched:**
- `web/src/sw.ts` (or equivalent — locate via `web/` PWA wiring)
- `web/vite.config.ts` (only if origin assumptions found)
- possibly a reader/library empty-state component

**Docs:** SW `/api` rule → `/** GOTCHA */` next to the fetch handler (+ link from G3 if apt).

**Estimated scope:** Small-Medium (2-4 files)
