# Task 013: `datasource/resolve.ts` boot probe + `datasource/server.ts` library ops

**Description:** The join point of the effort. `resolve.ts`: before the app renders, probe same-origin `GET /api/session` — authed 200 → server mode; 401 → `window.location = '/ui/login'`; unreachable/404 → local mode. Expose the resolved datasource via a low-frequency `DatasourceProvider` (Context is correct here: mode is set once at boot — never playback state). `server.ts`: the `ServerDatasource` — books/chapters/progress/delete over the Phase-2 endpoints (cookie auth implicit, same-origin); synth pipeline + playback come in T14/T15 (stub them to throw "not implemented" until then).

**Acceptance criteria:**
- [ ] `resolve.ts` implements the probe with correct 401-redirect semantics; probe failure (network error / 404) falls back to local mode silently (standalone PWA unchanged — this is the invariant; verify dev on :8253 with no server running still boots local).
- [ ] `DatasourceProvider` wraps the app (main.tsx/router root); exposes `{ mode: 'local' | 'server', library: LibraryDatasource, synth: SynthPipeline }`; UI reads mode only for affordance toggling (T16), never for data branching.
- [ ] `server.ts` implements the `LibraryDatasource` surface: list/get books (maps `BookDto` → SPA `Book` incl. `position` from T11, `processing` derived from job state), chapters (T9 shape → SPA `Chapter`), progress PATCH (debounced/batched same as local `useProgressPersistence` cadence), delete, audio probing (which paragraphs have audio — derive from a manifest/keys endpoint or BookDto `audioPresent` + per-key HEAD-less strategy decided here and documented in the task completion).
- [ ] Vitest with mocked `fetch`: mode resolution matrix (200/401/network-error), each library op mapping + error variants (404 → not-found state, 401 mid-session → surface re-login).
- [ ] `pnpm verify` green; standalone (`pnpm dev`, no server) still boots local mode.

**Verification:**
- [ ] `pnpm test` + `pnpm verify` green.
- [ ] Manual via `just dev` + a seeded server data dir: app boots in server mode, library lists server books.

**Dependencies:** T2, T3 (interfaces + local), T7 (session), T9 (chapters), T10 (audio keys), T11 (progress)

**Files likely touched:**
- `web/src/lib/datasource/resolve.ts` (new) + `resolve.test.ts`
- `web/src/lib/datasource/server.ts` (new) + `server.test.ts`
- `web/src/context/datasource.tsx` (new provider)
- `web/src/main.tsx` or router root (mount provider)

**Docs:** Mode-probe contract → module doc comment in resolve.ts.

**Estimated scope:** Large (4-6 files) — if it strains one session, split "resolve + provider + wiring" from "ServerDatasource library ops" (two commits), but they land as T13.
