# Task 017: Service worker `/api` network-only + hosted-affordances audit

**Description:** Make the PWA layer safe and coherent in hosted mode. The service worker must never cache `/api` (R3/G3): network-only, failed network = error (hosted mode is online-only by decision). Audit what else the SW + manifest do when served from the server origin: precache of app shell is fine (and speeds reloads), but nothing may cache API responses; offline fallback page in server mode should not pretend the library works offline.

**Acceptance criteria:**
- [ ] SW fetch handler: `/api/*` (and `/ui/login`) bypass cache entirely — pass-through with no cache.put on any status.
- [ ] Manifest/SW scope sane when served at server origin (paths relative — verify no absolute localhost:8253 assumptions leak into the build).
- [ ] Offline behavior in server mode: app shell may load, library shows an explicit offline/empty state — never stale data masquerading as current.
- [ ] Audit pass (record in task completion): CSP values from T8 vs actual runtime requests (workers, fonts, connect-src) in the hosted build; any relaxation documented with justification (spec boundary: CSP relaxation requires ask-first).
- [ ] `pnpm verify` green; manual hosted check with DevTools "Offline" toggle shows the intended states.

**Verification:**
- [ ] `pnpm test` + `pnpm verify` green (SW tests co-located per house pattern if they exist — extend).
- [ ] Manual: hosted app → DevTools offline → correct empty/offline states; back online → recovers without reload weirdness.

**Dependencies:** T8 (CSP baseline), T13+ (hosted mode exists); before T18

**Files likely touched:**
- `web/src/sw.ts` (or equivalent — locate via `web/` PWA wiring)
- `web/vite.config.ts` (only if origin assumptions found)
- possibly a reader/library empty-state component

**Docs:** SW `/api` rule → `/** GOTCHA */` next to the fetch handler (+ link from G3 if apt).

**Estimated scope:** Small-Medium (2-4 files)
