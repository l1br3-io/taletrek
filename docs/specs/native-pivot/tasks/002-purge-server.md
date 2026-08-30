# T2 — Server total purge

**Description:** Delete the personal server and everything whose only reason to exist was it. Code, build glue, and primary docs in one atomic sweep. Full doc polish (developing/testing/gotchas/ROADMAP) belongs to T4/T5 — this task leaves no *code or config* references.

- [x] `git rm -r server docs/specs/personal-server docs/specs/server-hosted-spa docs/deploy-digitalocean.md docs/off-device-synth-track.md docs/adrs/0014-server-hosted-spa-dual-shape.md`
- [x] `Cargo.toml` workspace members → `["crates/*", "desktop"]`; `Cargo.lock` prunes on next cargo run
- [x] justfile: drop `server_token`/`server_jobs` vars + `dev`, `dev-server`, `docker-server` recipes; keep dev-web / synth / resynth / synth-fixture / tests / verify
- [x] `web/vite.config.ts`: drop the `/api` + `/ui/login` dev proxy block (and its comment); everything else (CSP, PWA config) untouched
- [x] Code-comment refs in `crates/synth/src/bundle/manifest.rs`, `crates/worker/src/{stamp,voices}.rs` reworded host-neutral (no behavior change)
- [x] `cargo check --workspace` green; `rg -l "taletrek-server|personal-server|server-hosted"` — remaining hits are intentional-historical (`GeneratorApp` union + ADR-0013 + shipped Rust-track specs, handled in T4) or T3 scope (`datasource/types.ts`)

**Files:** deletions above + `Cargo.toml`, `justfile`, `web/vite.config.ts`, `crates/*` comment touch-ups
**Verify:** `cargo check --workspace && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
