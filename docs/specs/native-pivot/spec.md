---
status: active        # draft → active → shipped   (specify phase ran in-session 2026-08-30; direction approved)
started: 2026-08-30
---

# SPEC — Native pivot track · Effort 1: Purge & re-foundation

> Decision record: [ADR-0015](../../adrs/0015-native-pivot-rust-kernel-and-native-apps.md) (task T1 files it).
> Idea one-pager (the why + locked stack): [`docs/ideas/native-pivot.md`](../../ideas/native-pivot.md).
> ADR-0015 deletes ADR-0014 (personal server + hosted SPA) and narrows ADR-0013 (bundle format + desktop synth survive; the server tier does not).

## Problem

TaleTrek pivots from SPA-first to a Rust kernel + platform-native apps (desktop synth processor → Android → iOS). The repo still carries the entire old product: the upload/parse/synth/AI-transform pipeline in `web/`, the personal server + hosted-SPA dual shape, and every doc that describes them. This effort re-founds the repo on the new direction: **delete the server entirely, cut the SPA down to a `.taletrek` reader + landing page, prune the docs, and rewrite VISION/ROADMAP** — leaving a clean base for `crates/parse` (effort 2) and the apps behind it.

## Objective (users + success)

- **User:** the maintainer (clean base to build native apps on) and future app users (a website that explains the product and plays `.taletrek` files).
- **Success looks like:** the workspace is kernel + desktop CLI + reader-only web app; cargo and `pnpm verify` gates are green; the web reader still opens a v1 full `.taletrek`; docs (VISION, ROADMAP, AGENTS, gotchas, specs) tell only the native story; the landing page offers app downloads (placeholders) + the reader.

## Scope (this effort only)

1. **ADR-0015** — the pivot decision record; records every deletion (including ADR-0014 itself).
2. **Server total purge** — `server/` crate + workspace member + justfile recipes (`dev`, `dev-server`, `docker-server`) + Vite `/api` `/ui/login` dev proxy + primary docs (`specs/personal-server/`, `specs/server-hosted-spa/`, `adrs/0014`, `deploy-digitalocean.md`, `off-device-synth-track.md`) + stray code-comment refs in `crates/*`.
3. **SPA scope-down** — remove the upload pipeline (parse/tts/concat workers, upload manager, wake-lock, boot-sweep, pre-synth, ingest), AI transforms + pronunciation/outline UI + `lib/crypto` keyring + `lib/ai`, server datasource + `resolve.ts` + `useServerVoices`, upload UI surfaces; prune dead deps. Keep: reader, playback engines, bundle import/export, imported-bundle library, settings subset, backup.
4. **Docs audit** — delete specs whose subject died; keep specs documenting surviving behavior (playback engines, bundle import/export, library, reader UX); retire dead gotchas (IDs stay stable, gaps allowed); CHANGELOG untouched (history).
5. **VISION + ROADMAP + AGENTS rewrite** — native direction: store distribution in scope, OSS TTS engine, web = landing + reader, new effort sequence.
6. **Landing page v1** — apps (coming soon), CLI today, open a `.taletrek` in the reader.

## Decisions (locked — specify phase 2026-08-30; Q&A recorded in the ideas one-pager)

| Area | Decision |
| --- | --- |
| Product shape | Rust kernel (`crates/parse` + `synth` + `worker`) behind UniFFI; native apps per platform |
| Ship order | Desktop synth processor → Android → iOS |
| TTS | OSS only: sherpa-onnx official Rust crate (Piper + Kokoro voices), in-process |
| Distribution | Stores, free downloads (Apple $99/yr accepted) |
| Web role | Landing page + `.taletrek` reader; file-open only; iOS lock-screen pause accepted (demo-class) |
| Server | **Total purge** — code + docs; sync/cloud returns only via a future ADR |
| AI transforms | Purged; revisit as desktop-processor features (they require re-synth) |
| Bundle format | `.taletrek` v1 unchanged — the sole interchange |
| Interim gap | Until `crates/parse` (effort 2), nothing converts ebooks→bundles; the CLI stays bundle→bundle. Accepted (pre-release) |

## Architecture (post-purge)

```
crates/synth/      shared pure core (unchanged)
crates/worker/     host-level voice acquire + pool (unchanged)
desktop/           headless synth CLI (unchanged; gains files-in at effort 2)
web/               landing + reader only:
  src/routes/        landing, library (imported bundles), reader, settings
  src/lib/           db, bundle/, book-audio, playback engines, media-session
docs/              native story; retired specs/gotchas deleted
```

## Commands

```
pnpm verify                    # lint + typecheck + test + build (web)
cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
just --list                    # dev-web / synth / resynth / tests / verify
```

## Testing strategy

- The existing vitest suite is the fence for everything the reader keeps: import/playback/settings/library tests must stay green through the purge.
- Tests co-located with deleted code die with it; the only new tests are landing-page smoke tests.
- Rust gates unchanged (server tests deleted with the crate).

## Boundaries

- **Always:** keep `.taletrek` v1 compat (the reader must open existing bundles); run `pnpm verify` + cargo gates before commits; land ADR-0015 before deletions.
- **Ask first:** deleting any spec/ADR/gotcha beyond the enumerated audit list; new dependencies.
- **Never:** break bundle-format compat; resurrect server code without a new ADR; touch `spike/`; commit secrets.

## Non-goals (this effort)

`crates/parse`, desktop GUI, mobile apps, store submissions, voice work, transforms-on-desktop, migration tooling for server users (pre-release — there are none).

## Risks

- **R1 — Purge breadth in `web/`:** the upload stack touches reader-adjacent modules (`ingest`, `pre-synth`, the datasource seam). Mitigation: typecheck+tests as the fence; delete in dependency order (workers → manager → AI/crypto → datasource → UI).
- **R2 — Interim no-producer gap:** post-purge, only the CLI (bundle→bundle) and existing fixtures produce full bundles. Accepted, pre-release; effort 2 closes it.
- **R3 — Doc archaeology:** dangling links to deleted specs/ADRs. Mitigation: final `rg` sweep (T7) with allowlist (`CHANGELOG.md`, ADR-0015, ROADMAP history lines).
- **R4 — Gotcha renumber churn:** code comments reference G-IDs. Mitigation: retire entries in place, keep surviving IDs stable, note gaps in the gotchas header.

## Success criteria (testable)

1. `cargo build/clippy/test --workspace` green with `server/` gone from workspace members.
2. `pnpm verify` green on the reader-only web app.
3. The reader opens a v1 full `.taletrek` (existing import tests survive).
4. T7 sweep: no server/hosted refs outside the allowlist (CHANGELOG, ADR-0015, ROADMAP history lines).
5. VISION/ROADMAP/AGENTS describe the native direction; the landing page renders with reader entry + app placeholders.

## Open questions

None blocking. Later-effort questions (MOBI timing, egui-vs-Tauri, Apple account ownership) are tracked in the ideas one-pager.
