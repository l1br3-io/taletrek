# Task 007: Router + bearer-token auth middleware + `GET /api/books` + `GET /api/books/:id`

**Description:** Stand up the authenticated API surface. A `tower`/axum middleware layer rejects any non-`/api/health` request whose `Authorization: Bearer <TOKEN>` header doesn't match `Settings.token` (single-user, ADR-0013). Then the two read-only book endpoints: list the library (metadata index from SQLite, no bundle parsing) and read one book's metadata. Upload/download/delete land in T8; synth/resynth in T9/T10. This task makes the router, the auth gate, and the `Db` injection all real — the later handlers just slot in.

**Acceptance criteria:**
- [ ] `server/src/http/mod.rs` builds the full router: a stateful `AppState { db: Arc<dyn Db>, store: ..., settings: Arc<Settings> }` (store is added in T8; here it can be `()`/placeholder or added now and used in T8 — add it now so `AppState` is stable across tasks), with the auth middleware applied to all routes except `GET /api/health`. Wires `GET /api/books` and `GET /api/books/:id` here; later tasks `.merge()`/`.route()` their routers in.
- [ ] `server/src/http/auth.rs`: an axum middleware (or `tower::Layer`) that reads `Authorization: Bearer <tok>`, compares against `Settings.token` (constant-time compare via a small helper or `subtle` if added — a plain `==` is acceptable for v1 single-user but note the caveat), returns `401 Unauthorized` on mismatch/absence. The health route is mounted **outside** this layer.
- [ ] `server/src/http/books.rs` (read handlers): `GET /api/books` → `200` JSON array of book metadata (`{id, title, author, sourceFormat, voiceId, audioPresent, chapterCount, createdAt, updatedAt}` — camelCase to match the bundle format + SPA); `GET /api/books/:id` → `200` single book or `404` if absent. Both read from `Db::list_books` / `Db::get_book`. Unknown id → typed `404`, not a bare `500`.
- [ ] The `Db` trait seam from T5 is what the handlers depend on (`AppState.db: Arc<dyn Db>`), so handler unit tests inject the in-memory stub `Db` — no SQLite in HTTP tests.
- [ ] `main.rs` constructs `AppState` and serves the router (replacing T4's health-only router).

**Verification:**
- [ ] `cargo build` + `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo test -p taletrek-server` green:
  - [ ] `auth`: request with no Authorization header → `401`; wrong token → `401`; correct token → passes through.
  - [ ] `GET /api/health` is reachable **without** auth.
  - [ ] `books`: with the stub `Db` pre-seeded, `GET /api/books` returns the seeded metadata in camelCase JSON; `GET /api/books/:id` returns one; unknown id → `404`.
  - [ ] Use `axum::TestServer` (`axum-test` or `tower::ServiceExt::oneshot`) so tests exercise the real router + middleware, not just the handler fn.
- [ ] Manual: `cargo run -p taletrek-server` (with `TALETREK_TOKEN=secret`); `curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:7878/api/books` → `401`; `curl -sS -H 'Authorization: Bearer secret' .../api/books` → `200 []`.

**Dependencies:** T4 (router/settings), T5 (`Db` trait + stub + row structs). (T6's store is referenced by `AppState` but its handlers land in T8.)

**Files likely touched:**
- `server/src/http/mod.rs` (router + `AppState` + middleware wiring)
- `server/src/http/auth.rs` (new — bearer middleware)
- `server/src/http/books.rs` (new — read handlers; write handlers added in T8)
- `server/src/main.rs` (construct `AppState`, serve full router)
- `server/Cargo.toml` (dev-dep for test server, e.g. `tower` `util` feature or `axum-test`; add `axum` `json` feature if not already)

**Docs:** A `/** GOTCHA */` on the auth layer's exclusion list: health is the only unauthenticated route — new routes default to authed, and a route accidentally mounted outside the layer is a security bug. Single-user bearer model per ADR-0013; multi-user/ACLs are an explicit non-goal.

**Estimated scope:** Medium (router + middleware + 2 read handlers + tests; the auth layer is the non-obvious part).
