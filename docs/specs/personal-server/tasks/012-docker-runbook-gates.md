# Task 012: Dockerfile (multi-stage, debian-slim, piper + ffmpeg) + runbook + final gates

**Description:** The shippable artifact and the proof it works. A multi-stage `server/Dockerfile` builds `taletrek-server` on the pinned toolchain and ships it on a `debian-slim` runtime with `piper` + `ffmpeg` installed (piper needs glibc — no musl). A `runbook.md` documents the manual end-to-end walkthrough (real piper + real curated voice + the SPA import), and the final gates prove the whole workspace is green. This is the Tier-3 milestone — *"close every device, synth keeps going"* — when the runbook succeeds.

**Acceptance criteria:**
- [ ] `server/Dockerfile` is multi-stage:
  - **Builder:** a Rust image pinned to the workspace toolchain (1.97.0) that builds `--release -p taletrek-server` (and its `crates/synth` + `crates/worker` deps). Build with `--locked` against the checked-in lockfile.
  - **Runtime:** `debian:stable-slim`, `apt-get install --no-install-recommends piper ffmpeg ca-certificates` (piper + libopus via ffmpeg), copy the binary in, `EXPOSE 7878`, `VOLUME /data`, default `ENV TALETREK_DATA_DIR=/data TALETREK_BIND=0.0.0.0:7878`. Voice models download at runtime into a cache volume (not baked into the image).
  - Non-root `USER`, minimal layers, `.dockerignore` excludes `target/`, `node_modules/`, `web/`, `.git/`.
- [ ] `docs/specs/personal-server/runbook.md` documents:
  - **Local dev:** `cargo run -p taletrek-server` with the required env (`TALETREK_TOKEN`).
  - **Docker:** `docker build -f server/Dockerfile -t taletrek-server .` then `docker run -p 7878:7878 -e TALETREK_TOKEN=... -v tt-data:/data -v tt-voices:/root/.cache/taletrek/voices taletrek-server`.
  - **End-to-end walkthrough (the Tier-3 proof):** upload `crates/synth/tests/fixtures/book-text-only.taletrek` → `POST synth` with the default curated voice → poll `GET /api/jobs/:id` to `succeeded` → download the bundle → assert `manifest.audio.present == true` and Opus segments start with `OggS` → **import into the SPA via the T3 button → audio plays** → then `POST resynth` with a different voice → re-download → re-import → new voice plays.
  - The `#[ignore]`d integration test (if added — optional) that encodes the steps behind the same `piper`/`ffmpeg`/voice gate as desktop's `tests/synth_e2e.rs`.
- [ ] Optionally add `server/tests/server_e2e.rs` (`#[ignore]`) that spins the binary (or in-process axum) + real piper/ffmpeg + the curated voice and asserts the full synth → download → manifest path. Gated exactly like desktop's e2e (soft-skip when prerequisites absent). This is the server analogue of desktop's `synth_e2e.rs`.

**Final gates (the ship checklist — run from the `personal-server` branch):**
- [ ] `cargo build --release` (whole workspace) clean on toolchain 1.97.0.
- [ ] `cargo clippy --workspace --all-targets -- -D warnings` clean.
- [ ] `cargo test --workspace` green — critically including **desktop** (refactor regression, T1–T3) and **`crates/synth`** (untouched, incl. `cache_key_parity`).
- [ ] `pnpm verify` green (no `web/` changes in this effort — if a pre-existing `web/` lint failure on `main` blocks the full `verify`, record it the same way efforts 2 + 3 did: confirm it pre-dates this branch and is not a regression; `typecheck`/`test`/`build` must still be green).
- [ ] `docker build -f server/Dockerfile -t taletrek-server .` succeeds; `docker run ... taletrek-server` reaches `GET /api/health` → `200 ok`.
- [ ] Runbook walkthrough executed on a real machine (date + commit recorded in `todo.md`): upload → synth → download → SPA import → audio plays; resynth round-trip too.
- [ ] `spec.md` frontmatter flipped: `status: draft → active` at the /build checkpoint; `status: shipped` + `shipped: YYYY-MM-DD` on the merge commit (the merge, not this task, does the final flip).

**Verification:**
- [ ] `docker build` succeeds locally; image size is reasonable (record it in the runbook — target: well under a few hundred MiB for the runtime layer; piper + ffmpeg dominate).
- [ ] `docker run` health check passes.
- [ ] All `cargo` + `pnpm` gates above green (or pre-existing blockers documented as in efforts 2/3).
- [ ] Runbook walkthrough marked done with date + commit in `todo.md`.

**Dependencies:** T1–T11 (everything). The Dockerfile bundles the finished binary; the runbook exercises the finished server.

**Files likely touched:**
- `server/Dockerfile` (new)
- `.dockerignore` (new, root)
- `docs/specs/personal-server/runbook.md` (new)
- `server/tests/server_e2e.rs` (new, `#[ignore]` — optional but recommended)
- `todo.md` (record runbook date + commit; mark final gates)

**Docs:** This task *is* the docs (runbook) + the ship gates. Update `AGENTS.md`'s "Current effort" pointer to point at the next effort (or note the track complete) only as part of the merge commit, not here.

**Estimated scope:** Medium (Dockerfile + runbook + a gated e2e test; the bulk is the manual walkthrough, which is human time, not code). Land the Dockerfile + runbook + gates first; the human walkthrough is the final sign-off recorded in `todo.md`.
