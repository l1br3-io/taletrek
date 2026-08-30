# Task Index — Off-device synth track

> 🔼 **Track overview:** removed by the native pivot (ADR-0015) — this index is
> the surviving record of the ordered task list.
>
> The full ordered task list across all four efforts. Do them in order; each
> effort must ship before the next begins (each is a prerequisite for the next).
> Track decision: [`../../../adrs/0013-off-device-synth-and-portable-bundles.md`](../../../adrs/0013-off-device-synth-and-portable-bundles.md).
> Format spec: [`../../../bundle-format.md`](../../../bundle-format.md).

**How to use this in a fresh opencode session:** pick the next ✅→▸ (not-done) task, open its task file (or the effort's spec/plan), and hand the session that one file. Done tasks are listed for orientation only — skip them.

---

## Effort 1 — `portable-bundle-format` ✅ SHIPPED (2026-08-03)
*Spec: [`../spec.md`](../spec.md) · Plan: [`../plan.md`](../plan.md) · Deliverable: the format + Rust `crates/synth` crate. No app.*

| # | Task | Status | Key files |
| --- | --- | --- | --- |
| T1.1 | Cargo workspace + toolchain skeleton | ✅ done | `Cargo.toml`, `rust-toolchain.toml`, `.gitignore`, `crates/synth/Cargo.toml` |
| T1.2 | Manifest + text model + typed errors | ✅ done | `crates/synth/src/bundle/{manifest,text,error}.rs` |
| T1.3 | Normalize + cache-key **parity** (HIGH RISK) | ✅ done — gate passed | `crates/synth/src/{normalize,cache_key}.rs`, `tests/cache_key_parity.rs` |
| T1.4 | Bundle I/O — text-only round-trip | ✅ done | `crates/synth/src/bundle/io.rs` |
| T1.5 | Bundle I/O — audio segments | ✅ done | `crates/synth/src/bundle/audio.rs` |
| T1.6 | Library bundle I/O | ✅ done | `crates/synth/src/bundle/library.rs` |
| **T1.7** | **Synth pipeline — piper subprocess + Opus encode** | ✅ done — ffmpeg Opus behind `Encoder` trait | [`007-synth-pipeline.md`](./007-synth-pipeline.md) |
| T1.8 | Conformance fixtures | ✅ done | `crates/synth/examples/gen_fixtures.rs`, `tests/fixtures/*`, `tests/fixtures_conformance.rs` |
| T1.9 | Final gates (clippy + test green) | ✅ done | — |

**Effort 1 shipped 2026-08-03** (all of T1.1–T1.9 done). Verification for any task in this effort: `cargo test -p taletrek-synth && cargo clippy -p taletrek-synth --all-targets -- -D warnings`.

---

## Effort 2 — `desktop-synth-app` 🔨 ACTIVE (spec drafted)
*Standalone Rust app: import a text-only `.taletrek` → synthesize with native Piper → export a full `.taletrek`. Headless-first. **No server, no parsing** (takes bundles only).*

**Spec + plan + todo:** [`../../desktop-synth-app/`](../../desktop-synth-app/) (`spec.md`, `plan.md`, `todo.md`). Build phase by phase off the todo. Rough phase map:

| # | Task | Key files |
| --- | --- | --- |
| T2.1 | Binary skeleton (`desktop/`) + CLI args (input bundle, output path, voice) | `desktop/Cargo.toml`, `desktop/src/main.rs` |
| T2.2 | Voice-model cache dir (download/cache Piper `.onnx` voices, mirror `CURATED_VOICES`) | `desktop/src/voices.rs` |
| T2.3 | Import text-only bundle → synth every paragraph via `crates/synth` → collect audio | `desktop/src/synth_job.rs` |
| T2.4 | Export full bundle (reuse `crates::write_book_bundle`) | `desktop/src/export.rs` |
| T2.5 | Import a full bundle → re-synth selected paragraphs ("improvement") | `desktop/src/resynth.rs` |
| T2.6 | Progress logging to stderr | `desktop/src/main.rs` |
| T2.7 | Manual end-to-end test: real `piper` binary, real voice, real bundle | — |

**Tier-2 milestone lands here** — "close the tab, synth keeps going" (synth off the phone, no server).

---

## Effort 3 — `spa-bundle-import-export` ⏸ QUEUED (start after effort 2)
*TS implementation of the format in the SPA + UI. The SPA's **only** new surface. On-device Piper stays as the offline fallback.*

| # | Task | Key files |
| --- | --- | --- |
| T3.1 | TS bundle reader/writer mirroring `crates/synth` (passes the 3 conformance fixtures) | `web/src/lib/bundle/{read,write}.ts` |
| T3.2 | "Export book" → text-only `.taletrek` (from existing IDB stores) | `web/src/lib/bundle/export.ts` |
| T3.3 | "Import book" → ingest full bundle into IDB + play | `web/src/lib/bundle/import.ts` |
| T3.4 | "Export/import whole library" → `.taletrek-lib` | `web/src/lib/bundle/library.ts` |
| T3.5 | UI: buttons in library/reader/settings + file picker | `web/src/routes/...` |
| T3.6 | Round-trip the conformance fixtures in vitest | `web/src/lib/bundle/*.test.ts` |

**Closes the loop:** parse on phone → synth on desktop → play on phone.

---

## Effort 4 — `personal-server` ⏸ QUEUED (start after effort 3)
*Rust personal library server (Docker): store, serve, optional inline synth, worker-mode job queue. Desktop gains optional "connect to server" worker mode here.*

| # | Task | Key files |
| --- | --- | --- |
| T4.1 | Binary skeleton (`server/`) + config (bind addr, data dir, bearer token) | `server/Cargo.toml`, `server/src/main.rs` |
| T4.2 | SQLite schema (books, chapters) + blob folder for audio | `server/src/db.rs`, `server/migrations/` |
| T4.3 | REST API: upload bundle, list library, stream audio, import/export library | `server/src/api.rs` |
| T4.4 | Inline synth worker (uses `crates/synth`) | `server/src/synth.rs` |
| T4.5 | Job queue table + worker pull protocol (desktop connects as worker) | `server/src/jobs.rs` |
| T4.6 | Dockerfile + volume layout | `server/Dockerfile` |
| T4.7 | Desktop worker-mode: `taletrek-desktop --server URL --token` pulls jobs | `desktop/src/worker.rs` |

**Tier-3 milestone lands here** — central library, always-on synth, multi-device.

---

## Sequencing rules
1. **Strict order:** 1 → 2 → 3 → 4. Each effort's spec/plan/todo is created when the effort starts (`/spec`).
2. **One task per session** is a good cadence; tasks are sized to land in a single focused session.
3. **Parity is sacred:** any change to `crates/synth/src/normalize.rs` or `cache_key.rs` must keep `tests/cache_key_parity.rs` green and must be mirrored to the SPA in effort 3.
4. After each task: `cargo test -p taletrek-synth && cargo clippy -p taletrek-synth --all-targets -- -D warnings` (effort 1) or `pnpm verify` (effort 3).
5. When an effort completes all tasks, flip its `spec.md` frontmatter `status: active → shipped` with the date.

## Known unrelated issue (track separately)
- `web/src/lib/tts/vendor/piper/pcm.test.ts` fails `biome lint` (`noNonNullAssertion`), which breaks `pnpm verify`. Pre-existing — not caused by this track. Fix independently.
