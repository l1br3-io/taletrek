# Task 012: Dev workflow — Vite `/api` proxy + `just dev`

**Description:** Make the two-process dev story one command: Vite dev server (:8253) proxies `/api` → `127.0.0.1:7878` so the SPA in dev behaves like the hosted shape (same-origin API), and `just dev` composes `dev-server` + `dev-web`. This unblocks T13+ development without Docker.

**Acceptance criteria:**
- [ ] `web/vite.config.ts`: `server.proxy['/api'] → http://127.0.0.1:7878` (and `/ui/login` if login-redirect testing in dev needs it — check T13's flow; add only what's needed).
- [ ] `justfile`: new `dev` recipe runs `dev-server` and `dev-web` together (background one, or `just --justfile`-multi — house pattern: keep it simple, document how to stop; on Ctrl-C both die).
- [ ] `docs/developing.md`: short section — "server-hosted mode dev: `just dev` → open :8253; API proxied to :7878; token `dev-secret`".
- [ ] `pnpm verify` still green (proxy is dev-only config; build unaffected).

**Verification:**
- [ ] `pnpm verify` green.
- [ ] Manual: `just dev` → `curl http://localhost:8253/api/health` proxies through → `ok`.

**Dependencies:** T7 (an endpoint worth proxying; health technically suffices — T7 preferred so the probe is real)

**Files likely touched:**
- `web/vite.config.ts`
- `justfile`
- `docs/developing.md`

**Docs:** developing.md section (this task's deliverable).

**Estimated scope:** Small (3 files)
