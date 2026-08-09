# Task 004: Server crate skeleton + `config.rs` + axum bind + `/api/health`

**Description:** Scaffold the `server/` crate — the effort's deliverable. A `Settings` struct loads config from env vars (with an optional `config.toml` override), `main.rs` boots a `tokio` runtime and binds an `axum` router, and a single unauthenticated `GET /api/health` endpoint answers `200 "ok"`. No DB, no store, no auth middleware yet — those land in T5+. This task makes `cargo run -p taletrek-server` produce a reachable server, the smallest end-to-end slice.

**Acceptance criteria:**
- [ ] Root `Cargo.toml` adds `"server"` to `members` (alongside `crates/*`, `desktop`).
- [ ] `server/Cargo.toml`: `name = "taletrek-server"`, `[[bin]] name = "taletrek-server"`, inherits workspace; deps `tokio` (multi-thread, macros, rt), `axum` (with `multipart` feature for T8), `tower`, `tower-http` (trace), `tracing`, `tracing-subscriber`, `serde`, `serde_json`, `anyhow`, `thiserror`, `toml` (optional config parse), `taletrek-synth` (path), `taletrek-worker` (path). `[lints] workspace = true`.
- [ ] `server/src/config.rs` exposes `pub struct Settings` with fields + defaults from env: `data_dir` (`TALETREK_DATA_DIR`, default `./data`), `bind` (`TALETREK_BIND`, default `0.0.0.0:7878`), `token` (`TALETREK_TOKEN`, required at boot if no anonymous mode — for now boot fails clearly when unset), `voices_cache_dir` (`TALETREK_VOICES_CACHE_DIR`, default = `worker::voices::default_cache_dir()` or `data_dir/voices`), `jobs` (`TALETREK_JOBS`, default `available_parallelism`), `piper` (`TALETREK_PIPER`, default `"piper"`), `ffmpeg` (`TALETREK_FFMPEG`, default `"ffmpeg"`). A `Settings::from_env()` constructor; an optional `config.toml` path via `TALETREK_CONFIG` overlays env (env wins). Doc-comment each field.
- [ ] `server/src/http/mod.rs` builds an `axum::Router` with `GET /api/health` (returns `200 "ok"` plain text, no auth) wired, plus `tower_http::trace::TraceLayer`. Auth/books/jobs/ui routes are added in later tasks.
- [ ] `server/src/http/health.rs` holds the health handler (separated so later middleware layers compose cleanly).
- [ ] `server/src/main.rs`: `#[tokio::main] async fn main() -> anyhow::Result<()>` — init `tracing_subscriber`, load `Settings::from_env()`, build the router, `axum::serve(listener, app).await?`. Logs the bind address on startup. Creates `data_dir` if missing.
- [ ] The crate compiles with zero `unsafe` and no `missing_docs` warnings (workspace lints apply).

**Verification:**
- [ ] `cargo build -p taletrek-server` clean on the pinned toolchain (1.97.0).
- [ ] `cargo clippy -p taletrek-server --all-targets -- -D warnings` clean.
- [ ] `cargo run -p taletrek-server` boots and logs the bind address; `curl -sS http://127.0.0.1:7878/api/health` returns `200 ok`.
- [ ] `cargo test -p taletrek-server` — at minimum a `config` unit test: `Settings::from_env()` reads stubbed env vars and applies defaults; missing required token surfaces a clear error.
- [ ] `cargo build --workspace` clean (server joins synth + worker + desktop).

**Dependencies:** T1–T3 (worker crate exists; server declares the path dep even though only later tasks call into it).

**Files likely touched:**
- `Cargo.toml` (root — `members += "server"`)
- `server/Cargo.toml` (new)
- `server/src/main.rs` (new)
- `server/src/config.rs` (new)
- `server/src/http/mod.rs` (new)
- `server/src/http/health.rs` (new)

**Docs:** Boot/config instructions belong in the runbook (T12), not inline. A `/** GOTCHA */` on `Settings::token` noting the single-user bearer model (ADR-0013) is appropriate.

**Estimated scope:** Medium (6 new files; axum + tokio + config wiring, but no business logic yet).
