# Plan — Effort 4: Personal server

> Spec: [`spec.md`](./spec.md). Track ADR: [`../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../adrs/0013-off-device-synth-and-portable-bundles.md). Format: [`../../bundle-format.md`](../../bundle-format.md) (frozen v1).
> Prior efforts (all ✅ shipped): [1 portable-bundle-format](../portable-bundle-format/spec.md) · [2 desktop-synth-app](../desktop-synth-app/spec.md) · [3 spa-bundle-import-export](../spa-bundle-import-export/spec.md).
> This plan is a thin index. Per-task acceptance, files, and verification live in `tasks/00N-*.md`.

## Overview

Ship `taletrek-server`: a long-lived, Docker-first HTTP server that **is** the library — it stores `.taletrek` / `.taletrek-lib` bundles on disk behind a SQLite index, serves them over a versioned JSON API + a minimal server-rendered HTML UI, and runs inline Piper synth itself as background jobs (synth + resynth). Bundles move SPA↔server through the existing T3 import/export buttons — **no SPA change, no live sync** (ADR-0013 alt #2 rejected). This lands Tier 3 ("close every device, synth keeps going").

Two structural moves precede the server: extract the desktop's host-level code (voice acquire + rayon pool + manifest stamping) into a new **`crates/worker`** crate, then refactor `desktop/` to consume it. The desktop binary's existing unit + `#[ignore]`d e2e tests are the gate that the extraction is behavior-identical. `crates/synth` stays pure and untouched.

## Architecture decisions

- **Extract `crates/worker` before building the server.** Voice acquisition, the parallel pool, and manifest stamping are host-level concerns currently trapped in `desktop/`. Both hosts (sync desktop CLI, async-wrapped server) share them. `crates/synth` stays pure (no network, no threads); `crates/worker` stays sync/blocking (rayon + `ureq`), so the desktop uses it directly and the server wraps it in `spawn_blocking`. The desktop refactor is the riskiest step (regressing shipped code), so it is **Phase 1**, gated by desktop's own tests.
- **Progress is a worker trait, not a desktop type.** `voices`/`synth_job` currently take `Option<&desktop::Progress>`. Extraction requires a `crates/worker::ProgressSink` trait: desktop's `Progress` implements it (stderr lines), the server implements it (job-row `done`/`total` updates). This is the one API change the extraction forces; `crates/synth` is unaffected (it has no progress concept).
- **Layered foundations, then vertical HTTP slices.** Like effort 3's conformance gate, the server has a foundation that must be proven before the layers above build on it: worker-extraction-green (Phase 1), then db + store unit-tested in isolation (Phase 2), then the HTTP handlers stack on them (Phase 3–4). Within the HTTP layer the slices are vertical (upload→list→download→delete; trigger→poll→download).
- **`rusqlite` (sync) under tokio, all calls `spawn_blocking`.** SQLite is never on the synth hot path (the rayon pool is). A `Db` trait seam keeps the server unit-testable with an in-memory/stub store; no real piper/ffmpeg/network in CI.
- **Parameterize `generator.app`, never hardcode it.** Stamping takes a `generator.app` argument (`"taletrek-desktop"` / `"taletrek-server"`) so the two hosts can't drift the bundle's provenance — `crates/worker::stamp` is the single stamping path for both.
- **Server is the only crate that depends on `tokio`/`axum`/`rusqlite`.** Workspace stays lean; the desktop pulls none of them.
- **Resolved open questions (from the spec's favor):** crate name = `crates/worker` (forward-compatible with worker-mode); web UI = askama (typed, compiled); config = env vars + optional `config.toml`; upload = multipart (matches the UI `<form>`).

## Dependency graph + task order

```
Phase 1 — extract crates/worker (desktop's tests are the gate)
  T1 worker scaffold + ProgressSink + voices ─► T2 synth_job ─► T3 stamp (+refuse_full_input)
        └── crates/synth UNTOUCHED; desktop behavior identical

Phase 2 — server foundations (bottom-up)
  T4 server crate + config + /api/health
       └─► T5 db.rs (rusqlite + books/jobs schema + Db trait)
              └─► T6 store.rs (on-disk layout + .taletrek-lib ingest/dedup)

Phase 3 — HTTP library API (vertical)
  T7 router + bearer-auth + book list/get ─► T8 upload(multipart+ingest)/download/delete

Phase 4 — inline synth (vertical)
  T9 synth job runner + POST synth + job poll  ◄── needs worker (P1) + db jobs (T5) + store (T6)
       └─► T10 resynth + voices endpoints (catalog + prefetch)

Phase 5 — ship
  T11 server-rendered HTML UI (askama) ─► T12 Dockerfile + runbook + final gates
```

Strict order within each phase; Phase 2 tasks are sequential (store wraps db), Phase 3–4 HTTP tasks are sequential (later handlers reuse the router/auth wiring).

## Task index

### Phase 1 — Extract `crates/worker`
- [ ] Task 1: Worker crate scaffold + `ProgressSink` trait + move `voices` → `tasks/001-worker-voices.md`
- [ ] Task 2: Move parallel synth engine into `crates/worker::synth_job` → `tasks/002-worker-synth-job.md`
- [ ] Task 3: Move stamping + `refuse_full_input` into `crates/worker` (parameterized `generator.app`) → `tasks/003-worker-stamp.md`

### Checkpoint: Worker extraction green
- [ ] Desktop unit tests green (behavior identical); `crates/synth` untouched + green; `crates/worker` exists and both hosts could consume it.

### Phase 2 — Server foundations
- [ ] Task 4: Server crate + `config.rs` + `main.rs` axum bind + `/api/health` → `tasks/004-server-skeleton.md`
- [ ] Task 5: `db.rs` — rusqlite + migrations (books/jobs) + `Db` trait + `spawn_blocking` → `tasks/005-db.md`
- [ ] Task 6: `store.rs` — on-disk bundle layout + `.taletrek-lib` library ingest (dedup by book id) → `tasks/006-store.md`

### Checkpoint: Server boots + foundations proven
- [ ] `cargo run -p taletrek-server` answers `/api/health`; db + store unit-tested in isolation (tempdir/in-memory, no network).

### Phase 3 — HTTP library API
- [ ] Task 7: Router + bearer-token auth middleware + `GET /api/books` + `GET /api/books/:id` → `tasks/007-http-router-auth.md`
- [ ] Task 8: `POST /api/books` (multipart upload + ingest) + download + delete → `tasks/008-http-books-crud.md`

### Checkpoint: Library loop via curl
- [ ] Auth rejects unauthenticated; upload `.taletrek` + `.taletrek-lib` → list → download (byte-identical) → delete.

### Phase 4 — Inline synth + resynth
- [ ] Task 9: Synth job runner + `POST /api/books/:id/synth` (202) + `GET /api/jobs(:id)` → `tasks/009-synth-job.md`
- [ ] Task 10: `POST /api/books/:id/resynth` + voices endpoints (catalog + prefetch) → `tasks/010-resynth-voices.md`

### Checkpoint: Synth loop closes (stubbed)
- [ ] Upload text-only → `POST synth` → poll to `succeeded` → download → `manifest.audio.present == true`; resynth re-keys under the new voice. (Real piper via the runbook, T12.)

### Phase 5 — UI + Docker + ship
- [ ] Task 11: Server-rendered HTML UI (askama: index, book, jobs) → `tasks/011-web-ui.md`
- [ ] Task 12: Dockerfile (multi-stage, debian-slim, piper + ffmpeg) + runbook + final gates → `tasks/012-docker-runbook-gates.md`

### Checkpoint: Ready for review
- [ ] All `spec.md` §"Success criteria" met or explicitly deferred (real-piper runbook walkthrough = human-run); `cargo build/clippy/test --workspace` + `pnpm verify` green; `docker build` succeeds; `spec.md` flips to `shipped` on the merge commit.

## Risks and mitigations

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| Extracting from shipped `desktop/` regresses it | High | Desktop's unit + `#[ignore]`d e2e tests are the gate; refactor is mechanical (move + re-import + `ProgressSink` seam). Run before/after as part of T1–T3. |
| `crates/synth` API gap surfaces during server integration | Med | Patch `crates/synth` with a small helper (keeping `cache_key_parity` green), not a fork — matches T2's risk note. `crates/synth` is explicitly ask-first. |
| `rusqlite` (sync) under tokio | Med | All DB calls in `spawn_blocking`; `Db` trait seam for in-memory tests; SQLite never on the synth hot path. |
| Per-paragraph job-row updates thrash SQLite from the pool | Low | Server's `ProgressSink` updates `done`/`total`; acceptable for v1 (poll-based, no live streaming). Throttle if profiling shows it. |
| Bundle format drift (3rd producer) | Med | `generator.app = "taletrek-server"` stamps provenance; `crates/worker::stamp` is the single stamping path; shared fixtures stay the conformance gate. |
| Docker image size / piper-on-musl | Med | debian-slim base (piper needs glibc); voice models downloaded at runtime into a volume (not baked); multi-stage build. |
| Bearer-token leakage on a LAN | Med | Token env/config-only, never logged; bind interface configurable; single-user trust model per ADR-0013. |

## Open questions

None blocking — the four from the spec are resolved in this plan's favor (crate name `worker`; askama UI; env + optional TOML; multipart upload). Worker-mode job queue (desktop-as-worker) and cross-book content-addressed audio store are explicit **follow-on efforts**, out of scope here.
