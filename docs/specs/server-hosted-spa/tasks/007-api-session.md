# Task 007: `GET /api/session` endpoint

**Description:** The boot probe the SPA will use (T13) to decide its mode. Authed → `200 { "ok": true }`; no/invalid credentials → `401` (JSON, not the HTML login redirect — the SPA handles redirect itself, and API paths already behave this way per `auth.rs`). Minimal contract per plan decision: no capabilities envelope in v1.

**Acceptance criteria:**
- [ ] `server/src/http/session.rs` (new) serves `GET /api/session` on the **protected** sub-router (it must sit behind `require_auth` like the rest of `/api`).
- [ ] Authed (bearer or cookie) → `200` `application/json` `{ "ok": true }`. Unauthed → `401` JSON (existing auth-middleware behavior for `/api/*` — verify, don't re-implement).
- [ ] Route registered in `router()` (`server/src/http/mod.rs`); security headers still applied (they're outer middleware — confirm no opt-out needed).
- [ ] In-process axum test: 200 with token, 401 without.

**Verification:**
- [ ] `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green.
- [ ] Manual: `curl -i http://127.0.0.1:7878/api/session` → 401; with `-H "Authorization: Bearer dev-secret"` → 200 `{"ok":true}`.

**Dependencies:** None (effort-4 codebase)

**Files likely touched:**
- `server/src/http/session.rs` (new)
- `server/src/http/mod.rs` (route)

**Docs:** None.

**Estimated scope:** Small (2 files)
