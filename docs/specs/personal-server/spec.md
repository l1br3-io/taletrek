---
status: active
started: 2026-08-09
---

# SPEC — Off-device synth track · Effort 4: Personal server

> Track ADR: [`docs/adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md)
> Format spec: [`docs/bundle-format.md`](../../bundle-format.md)
> Prior efforts (all ✅ shipped): 1. [`portable-bundle-format`](../portable-bundle-format/spec.md) · 2. [`desktop-synth-app`](../desktop-synth-app/spec.md) · 3. [`spa-bundle-import-export`](../spa-bundle-import-export/spec.md)
> Last of four efforts: 1. portable-bundle-format → 2. desktop-synth-app → 3. spa-bundle-import-export → **4. personal-server (this)**.
> Tiers: (1) SPA alone ✓ · (2) SPA + Desktop ✓ · **(3) + Server — lands here (inline-synth only; worker-pool deferred).**

## Problem

T1–T3 shipped the format, the desktop synth tool, and the SPA's bundle import/export. **Tier 2 works today**: close the tab, run `taletrek-desktop synth`, drop the resulting `.taletrek` back onto the phone via the T3 buttons. What is missing is the **always-on, central-library** piece — Tier 3. Today the user must (a) run the desktop binary by hand for each book and (b) keep their library only on the phone. There is no process that is always synth'ing while every device is asleep, and no canonical place the library lives.

This effort delivers the smallest thing that proves Tier 3: **a self-hosted Docker server that *is* the library, runs Piper synth itself on demand, and exchanges `.taletrek` bundles with the SPA through the existing T3 buttons.** It explicitly does **not** add a live SPA↔server connection (ADR-0013 alt #2, rejected) and does **not** add a worker-mode job queue (phase 2 / follow-up). The server is operated through its own HTTP API + a minimal web UI it serves.

## Objective (users + success)

- **User:** the self-hosting power user who already runs Jellyfin/Nextcloud on a NAS/VPS/home box. They want their library off the phone and synthesis that survives every device sleeping.
- **Success looks like:** `docker run` → a working library server. Upload a text-only bundle → click synth → poll the job → download the full bundle → drop it on the phone via T3 → audio plays. No desktop binary touched. No SPA changed.

## Scope (this effort only)

Deliver one binary, **`taletrek-server`** — a long-lived HTTP server (Docker-first) that:

1. **Stores a library** of `.taletrek` bundles (book-id-keyed files on disk) with a SQLite browse index. Supports `.taletrek-lib` library-bundle upload (ingests N books idempotently).
2. **Serves the library** over a versioned HTTP JSON API: list / read metadata / download bundle / delete. Plus a minimal **server-rendered web UI** (browse, upload, trigger synth, view job status) — no JS framework.
3. **Runs inline synthesis itself** — reuses the extracted synth-pool to Piper-synth a stored book with a chosen voice, in the background, tracked as a job row in SQLite. Includes **resynth** (re-voice a full book).
4. **Acquires Piper voice models** identically to the desktop (HuggingFace download + XDG cache + curated catalog + `--voice-path`-style override), via the **shared crate** this effort extracts.
5. **Authenticates** with a single bearer token (env/config). Single-user.
6. **Ships a Dockerfile** — multi-stage, debian-slim, `piper` + `ffmpeg` installed in the image, data dir mounted.

It reuses `crates/synth` for *everything* pure (bundle I/O, `synthesize_paragraph`, `cache_key`, `OpusEncoder`, `SubprocessPiperRunner`, all domain types) and a **new `crates/worker`** crate for the host-level concerns (voice acquisition, parallel pool, manifest stamping) currently trapped in `desktop/`. The desktop binary is refactored to consume `crates/worker` too — behavior identical, its existing tests gate the refactor.

## Decisions (locked — from ADR-0013 + prior efforts + this effort's specify phase)

| Area | Decision |
| --- | --- |
| Interface | **Long-lived HTTP server** (axum + tokio), Docker-first. JSON API + minimal server-rendered HTML UI. No gRPC, no WebSocket in v1. |
| Input / output | **Bundles only.** Upload `.taletrek` (book) or `.taletrek-lib` (library). Download `.taletrek`. No raw-file parsing on the server (ADR-0013 invariant). |
| Storage | **Files on disk** at `$DATA_DIR/library/<book-id>/bundle.taletrek`, keyed by book id. SQLite index + job state at `$DATA_DIR/taletrek.db`. No blobs-in-SQLite. Cross-book content-addressed audio dedup is a **follow-up** (v1 dedups within a bundle only). |
| DB | **rusqlite** (sync), all calls wrapped in tokio `spawn_blocking`. SQLite is not the hot path (synth is). Matches ADR-0013 "SQLite-default." |
| HTTP stack | **axum + tower + tower-http** (trace, cors, auth middleware) on **tokio**. |
| Synth execution | **Background job.** `POST /api/books/:id/synth` returns `202 + job_id` immediately; a tokio task runs the rayon pool (via `spawn_blocking`) and updates the job row. Client **polls** `GET /api/jobs/:id`. Live streaming (SSE/WS) is a follow-up. |
| Voice acquisition | **Reuse the extracted module** (`crates/worker::voices`): HF download + XDG cache + curated catalog + path override — identical to the desktop. |
| Concurrency | **Parallel pool** (`crates/worker::synth_job`, rayon), `--jobs`/`TALETREK_JOBS` default = `num_cpus`. Server has no mobile cap. |
| Codec | **Opus** (`OpusEncoder`, ffmpeg subprocess, 24 kbps) — matches T1/T2. |
| Native deps | **`piper` + `ffmpeg` (libopus) on PATH.** Installed in the Docker image; overridable via `TALETREK_PIPER` / `TALETREK_FFMPEG`. |
| Auth | **Single bearer token** (`Authorization: Bearer <TOKEN>`). Token from `TALETREK_TOKEN` env or config. No users, no ACLs (ADR-0013 single-user model). Health endpoint is unauthenticated. |
| Web UI | **Minimal server-rendered HTML** (no framework; askama templates or static string templates). Browse library, upload form, per-book synth/resynth buttons, job list. Not the product surface — the SPA is. |
| Shared crate | **Extract** `desktop/src/voices.rs` + `synth_job.rs` + the stamping core of `bundle_io.rs` into a new **`crates/worker`** crate. Desktop + server both depend on it. Stamping takes a parameterized `generator.app` (`"taletrek-desktop"` / `"taletrek-server"`). `crates/synth` stays pure (no network, no threads). |
| Workspace | **Add `crates/worker` and `server/` to the Cargo workspace** (`members = ["crates/*", "desktop", "server"]`; the `crates/*` glob auto-includes `crates/worker`). pnpm workspace untouched. |
| Binary name | `taletrek-server` (matches the reserved `generator.app` value in `bundle-format.md`). |
| Config | **Env vars by default** (`TALETREK_DATA_DIR`, `TALETREK_BIND` default `0.0.0.0:7878`, `TALETREK_TOKEN`, `TALETREK_VOICES_CACHE_DIR`, `TALETREK_JOBS`, `TALETREK_PIPER`, `TALETREK_FFMPEG`); optional `config.toml` override for Docker. |
| Default voice | `en_US-hfc_female-medium` (matches SPA + desktop). |
| Error policy | **Abort job on first paragraph error** (matches desktop v1). Job row records the error + paragraph index. `--keep-going` is a follow-up. |

## Architecture

```
taletrek/                            # repo root
  Cargo.toml                         # UPDATED — members += "server" (crates/* glob picks up crates/worker)
  crates/
    synth/                           # T1 (shipped) — pure core, UNTOUCHED
    worker/                          # NEW — extracted from desktop/: voice acquire + rayon pool + stamping
      src/{lib.rs, voices.rs, synth_job.rs, stamp.rs}
  desktop/                           # REFACTORED — consumes crates/worker; CLI + main loop stay
  server/                            # NEW — this effort's deliverable
    Cargo.toml                       # bin "taletrek-server"
    Dockerfile                       # multi-stage, debian-slim, piper + ffmpeg
    src/
      main.rs                        # entry: load config → bind axum → serve
      config.rs                      # env + optional config.toml → Settings
      db.rs                          # rusqlite pool + migrations + queries (spawn_blocking)
      store.rs                       # on-disk bundle file layout (library/<id>/bundle.taletrek)
      http/
        mod.rs                       # router + middleware (auth, log, cors)
        books.rs                     # library CRUD + bundle up/download
        jobs.rs                      # synth/resynth trigger + job status polling
        voices.rs                    # curated catalog + prefetch
        health.rs                    # GET /api/health (unauth)
        ui.rs                        # server-rendered HTML (browse/upload/jobs)
      synth.rs                       # job runner: spawn_blocking → crates/worker pool → update job row
      templates/                     # askama HTML (index, book, jobs)
  docs/specs/personal-server/        # this dir
```

### HTTP API (v1 — JSON unless noted)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET`  | `/api/health` | no | liveness |
| `GET`  | `/api/voices` | yes | curated voice catalog |
| `POST` | `/api/voices/:id/fetch` | yes | pre-download a voice model |
| `GET`  | `/api/books` | yes | list library (metadata index) |
| `POST` | `/api/books` | yes | upload `.taletrek` / `.taletrek-lib` (multipart) → ingests, dedups by book id |
| `GET`  | `/api/books/:id` | yes | book metadata |
| `GET`  | `/api/books/:id/bundle` | yes | download the `.taletrek` |
| `DELETE` | `/api/books/:id` | yes | remove book + bundle file |
| `POST` | `/api/books/:id/synth` | yes | `{voice?, voicePath?, jobs?}` → `202 {jobId}` (text-only → full) |
| `POST` | `/api/books/:id/resynth` | yes | `{voice, voicePath?, jobs?}` → `202 {jobId}` (re-voice) |
| `GET`  | `/api/jobs` | yes | list recent jobs |
| `GET`  | `/api/jobs/:id` | yes | job status `{status, kind, voice, progress, error?}` |
| `GET`  | `/` and `/ui/*` | yes | server-rendered HTML UI |

### Data model (SQLite)

- `books(id PK, title, author, source_format, voice_id, audio_present INT, chapter_count INT, created_at, updated_at)` — mirror of bundle `BookMeta`; `id` is the bundle's `book.id`.
- `jobs(id PK, book_id FK, kind TEXT, voice TEXT, status TEXT, done INT, total INT, error TEXT, created_at, updated_at)` — `kind ∈ {synth,resynth}`, `status ∈ {queued,running,succeeded,failed}`.

On-disk layout: `$DATA_DIR/library/<book-id>/bundle.taletrek`; `$DATA_DIR/taletrek.db`; voices at `$TALETREK_VOICES_CACHE_DIR` (default `~/.cache/taletrek/voices/`, or a volume in Docker).

## Commands

```
# Rust (run from repo root)
cargo build -p taletrek-server                      # build the server
cargo build                                         # whole workspace (synth + worker + desktop + server)
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                              # all crates green
cargo test -p taletrek-worker -p taletrek-server    # new + refactored crates
cargo run -p taletrek-server                        # local dev (needs piper+ffmpeg on PATH)

# Docker
docker build -f server/Dockerfile -t taletrek-server .
docker run -p 7878:7878 -e TALETREK_TOKEN=... -v tt-data:/data taletrek-server

# SPA gate (must stay green — no web/ changes in this effort)
pnpm verify
```

Toolchain pin and workspace lints (`unsafe_code = forbid`, `missing_docs = warn`, clippy `all`+`cargo`) are inherited from the root `Cargo.toml` — the new crates opt in via `[lints] workspace = true`, matching `crates/synth` and `desktop/`.

## Project structure conventions

- `crates/synth` — **untouched** (pure core: bundle I/O, synth, encode, domain types, errors).
- `crates/worker` — **NEW** (host-level: `voices` = HF download + cache + catalog + `VoiceSource` trait; `synth_job` = rayon pool; `stamp` = manifest stamping with parameterized `generator.app`). No `tokio`, no `axum` here — it stays sync/blocking so the desktop (sync) and server (async-wrapped) both use it cleanly.
- `desktop/` — **refactored** to depend on `taletrek-worker`; its `voices.rs`/`synth_job.rs`/stamping move into `crates/worker`, CLI + `main.rs` + progress stay.
- `server/` — **NEW**; the only crate that depends on `tokio`/`axum`/`rusqlite`.

## Code style

Follows the established Rust conventions in `crates/synth` and `desktop/`:
- `anyhow` at the binary top level (`main.rs`), `thiserror` for library error types. Lib errors convert into `anyhow` via `?`.
- Interfaces-before-impl: traits (`PiperRunner`, `Encoder`, `VoiceSource`) with real impls behind them — already the pattern; the server's HTTP layer introduces a `Store`/`Db` trait seam for testability.
- No `unsafe` (forbidden workspace-wide). Doc comments on all public items (`missing_docs = warn`).
- Variant enums for job/async states (`JobStatus { Queued, Running, Succeeded, Failed }`) — mirrors the SPA's `{ type: 'loading' }` variant pattern in Rust.
- Test doubles behind traits (stub `PiperRunner`, stub `VoiceSource`, in-memory `Store`) — no real piper/ffmpeg/network in unit tests.

## Testing strategy

| Layer | Tooling | What's covered |
| --- | --- | --- |
| `crates/worker` unit | inline `#[cfg(test)]`, stub `PiperRunner` + `VoiceSource` | voice resolve (cache-hit short-circuit, download-then-cache), pool covers every paragraph, stamping sets correct `generator.app` + audio meta |
| `crates/worker` parity | reuse `crates/synth/tests/fixtures/` | round-trip of stamped bundles stays conformant (mutual round-trip vs SPA) |
| `crates/synth` | existing tests | **untouched, must stay green** (incl. `cache_key_parity`) |
| `desktop/` | existing unit + `tests/synth_e2e.rs` (`#[ignore]`) | **behavior identical** post-refactor — these gate the extraction |
| `server/` unit | inline + `tempfile`, in-memory `Store`, stubbed synth | ingest (book + library, dedup, collision→new id), job lifecycle, HTTP handlers (status codes, auth reject), bundle up/download round-trip |
| `server/` e2e | `#[ignore]`d integration test, real `piper`+`ffmpeg` | spin the binary, upload text-only fixture, synth, assert full bundle bytes + manifest |
| Conformance | the shared fixtures set | server-produced bundles readable by the SPA's TS reader (manual cross-check; automated in a future CI gate) |

No real piper/ffmpeg/network in CI by default — `#[ignore]`d tests run via the runbook.

## Validation gates

- `cargo build` (whole workspace) clean on the pinned toolchain (1.97.0).
- `cargo clippy --workspace --all-targets -- -D warnings` clean.
- `cargo test --workspace` green — critically including `desktop/` (refactor regression) and `crates/synth` (untouched).
- `pnpm verify` green (no `web/` changes).
- `docker build -f server/Dockerfile .` succeeds; `docker run` reaches `/api/health`.
- **Manual end-to-end runbook** (documented, not CI): `docker run` → upload `crates/synth/tests/fixtures/book-text-only.taletrek` → `POST synth` with a curated voice → poll job to `succeeded` → download the full bundle → `manifest.audio.present == true`, Opus segments carry `OggS` magic → import into the SPA via the T3 button → audio plays. Round-trip a resynth too.

## Boundaries

**Always do:**
- Run `cargo test --workspace` + `pnpm verify` before commits.
- Keep `crates/synth`'s public API and the `cache_key_parity` test untouched (parity with the SPA is load-bearing — gotcha G16-equivalent for the track).
- Keep the desktop binary's behavior identical after the `crates/worker` extraction (its tests are the gate).
- Parameterize `generator.app` — never hardcode `"taletrek-desktop"` inside shared code.

**Ask first:**
- Touching `crates/synth`'s public API (a missing helper should go back as a small patch, not a fork — matches T2's risk note).
- Changing the `.taletrek` format (`schemaVersion`, entry names).
- Adding new top-level workspace deps (async/HTTP/DB), or introducing CI for Cargo (none exists today).
- Server-side storage of AI-transform API keys (deferred — needs a follow-up ADR under ADR-0013, interacting with ADR-0007 wrapped-DEK + ADR-0004 threat model).

**Never do:**
- Add a live SPA↔server sync client (ADR-0013 alt #2, rejected).
- Add raw-file (PDF/EPUB/MOBI) parsing on the server (ADR-0013 invariant).
- Add multi-user accounts / ACLs in v1 (deferred).
- Commit the bearer token, SQLite db, or any bundle data.
- `unsafe` (forbidden workspace-wide).

## Non-goals (this effort)

- **No worker-mode job queue** (desktop-as-worker connecting to the server). Phase 2 / follow-up effort.
- **No SPA changes.** Bundles move SPA↔server via the existing T3 export/import buttons.
- **No raw-file parsing.** Bundles only (ADR-0013).
- **No multi-user / sharing ACLs.** Single-user (ADR-0013).
- **No cross-book content-addressed audio store.** v1 stores each book as a whole bundle file; audio dedups within a bundle only. A shared audio store is a follow-up.
- **No live progress streaming (SSE/WebSocket).** Poll-based job status in v1.
- **No server-side AI-transform API-key handling.** Deferred to a follow-up ADR (threat-model interaction with ADR-0007/0004).
- **No automatic library sync / watch-folder.** Upload-triggered only.
- **No continue-on-error / partial-resume** for a synth job (matches desktop v1; `--keep-going` is a shared follow-up).

## Risks

| Risk | Mitigation |
| --- | --- |
| **Extracting from shipped `desktop/` regresses it.** | Desktop's unit + `#[ignore]`d e2e tests are the gate; refactor is mechanical (move + re-import), behavior identical. Run before/after as part of T1. |
| **`rusqlite` (sync) under tokio.** | All DB calls in `spawn_blocking`; a thin `Db` trait seam keeps the server testable with an in-memory stub. SQLite is never on the synth hot path. |
| **Docker image size / piper-on-musl.** | debian-slim base (piper needs glibc); voice models downloaded at runtime into a volume (not baked); multi-stage build slims the final image. |
| **Bundle format drift** (now three producers: SPA, desktop, server). | `generator.app = "taletrek-server"` stamps provenance; the shared fixtures stay the conformance gate; `crates/worker` is the single stamping path so desktop + server can't diverge. |
| **Bearer-token leakage on a LAN.** | Token is env/config-only, never logged; documented in the runbook; bind interface is configurable. Single-user trust model per ADR-0013. |
| **`crates/worker` naming / boundary bikeshed.** | Decided: `crates/worker` (forward-compatible with worker-mode). Alternatives (`crates/host`) noted as an open question, not a blocker. |

## Open questions (not blockers)

- Crate name: `crates/worker` vs `crates/host` (worker is forward-looking; host is more literal for inline-synth).
- Web UI: askama templates vs hand-rolled static strings. Propose askama (typed, compiled).
- Config: env-only is the minimum; whether to ship `config.toml` in v1 or defer. Propose env + optional TOML.
- Whether `POST /api/books` upload accepts multipart only or also raw body. Propose multipart (matches the web UI's `<form>`).

## Success criteria

- `docker build` + `docker run` yields a server that answers `/api/health`.
- Upload `book-text-only.taletrek` → `POST synth` → poll to `succeeded` → download → `manifest.audio.present == true`, Opus segments valid → **import into the SPA via T3 → audio plays**.
- `POST resynth` with a new voice produces a re-voiced full bundle.
- Desktop binary behaves identically after the `crates/worker` extraction (its unit + e2e tests green).
- `cargo build` + `clippy --workspace` + `test --workspace` green; `pnpm verify` green.
