# Testing

> Single source of truth for how each TaleTrek component is tested. Three
> shippable components — **SPA** (`web/`), **personal server** (`server/`),
> **desktop** (`desktop/`) — plus two shared Rust crates (`crates/synth`,
> `crates/worker`). For the architectural shape of each, see
> [`docs/off-device-synth-track.md`](off-device-synth-track.md) and
> [ADR-0013](adrs/0013-off-device-synth-and-portable-bundles.md).

## Components at a glance

| Component         | Location    | Stack                              | Default test command                | In CI today?      |
| ----------------- | ----------- | ---------------------------------- | ----------------------------------- | ----------------- |
| SPA / PWA         | `web/`      | Vite 8 + React 19 + TS             | `pnpm test` (vitest)                | yes               |
| Personal server   | `server/`   | Rust + axum + tokio + rusqlite     | `cargo test -p taletrek-server`     | **no (planned)**  |
| Desktop CLI       | `desktop/`  | Rust + clap (headless)             | `cargo test -p taletrek-desktop`    | **no (planned)**  |
| shared `synth`    | `crates/synth`  | Rust (pure core + bundle I/O)  | `cargo test -p taletrek-synth`      | **no (planned)**  |
| shared `worker`   | `crates/worker` | Rust (voice/synth pool)        | `cargo test -p taletrek-worker`     | **no (planned)**  |
| server Docker image | `server/Dockerfile` | Docker               | `docker build -f server/Dockerfile` | **no (planned)**  |

## Golden rule

**No real `piper` / `ffmpeg` / network in default CI.** Everything that needs
them is behind a `#[ignore]`d Rust integration test, gated on
`TALETREK_VOICE_PATH` (+ optional `TALETREK_PIPER_BIN` / `TALETREK_FFMPEG_BIN`),
and run either by hand or via a non-blocking `workflow_dispatch` job (planned).
The SPA has no equivalent gate — its vitest suite is fully hermetic (jsdom +
`fake-indexeddb`).

---

## 1. SPA — `web/`

### Run

```
pnpm test            # vitest run (one-shot; what CI uses)
pnpm test:watch      # vitest watch (dev)
pnpm verify          # lint + typecheck + test + build — run before commits
```

### Config

- Runner: **vitest** 4.x, configured at [`web/vite.config.ts`](../web/vite.config.ts) (`test` block).
- Environment: `jsdom`; `globals: true` (`describe`/`it`/`expect` available without imports).
- Setup file: [`web/test-setup.ts`](../web/test-setup.ts) — registers `fake-indexeddb/auto` + `@testing-library/jest-dom/vitest`.

### Layers (~90 co-located `*.test.{ts,tsx}` files)

| Layer            | Where                                  | Tooling                              |
| ---------------- | -------------------------------------- | ------------------------------------ |
| Pure logic       | `web/src/lib/**` (tts, ai, parse, bundle, crypto, audio, upload, transform) | plain vitest                         |
| Hooks            | `web/src/hooks/`, `web/src/routes/**/use*.test.ts` | `@testing-library/react` `renderHook` |
| Components       | `web/src/components/`, `web/src/routes/**`        | Testing Library (`render` + queries) |
| Route integration | `web/src/routes/*.test.tsx` (landing, library, reader, settings) | Testing Library + fake-indexeddb    |

### Cross-language conformance (load-bearing)

[`web/src/lib/bundle/parity.test.ts`](../web/src/lib/bundle/parity.test.ts)
walks up to the **committed Rust fixtures** at
`crates/synth/tests/fixtures/` and proves every paragraph's SPA-derived
`audioCacheKey(voice, text)` matches the audio entry name the Rust crate
embedded. This is the canonical guard against Rust↔TS format drift
(ADR-0013 risk #1). **A fixture change on the Rust side intentionally breaks
this test.** The symmetric Rust pin lives at
`crates/synth/tests/cache_key_parity.rs`.

### Gotchas (test-specific)

- **G7** — `pdfjs-dist` must be lazy-imported; `DOMMatrix` crashes jsdom.
- **G8** — send file **bytes**, not the `File`, to a worker.
- **G14** — WebAuthn PRF cannot be unit-tested in jsdom; those paths are
  manual-only.

Full detail in [`docs/gotchas.md`](gotchas.md).

---

## 2. Personal server — `server/`

Binary `taletrek-server`. Docker-first HTTP server (axum + tokio + rusqlite).

### Run

```
cargo test -p taletrek-server                    # all non-ignored tests
cargo test -p taletrek-server --test server_e2e -- --ignored --nocapture  # real piper+ffmpeg
```

### Layers

| Layer                | Where                          | What it covers                                                                 |
| -------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| Unit (inline)        | `src/config.rs`, `src/db.rs`, `src/store.rs`, `src/http/{auth,books,ui,health}.rs` | stub `PiperRunner`/`Encoder`, in-memory `Store`/`Db`; no real synth/network |
| HTTP handler         | `src/http/**`                    | `tower::ServiceExt::oneshot` against the router — status codes, auth reject, round-trips |
| Integration (gated)  | `tests/server_e2e.rs`            | spins the **real binary** on an ephemeral port, drives the full loop over HTTP with `ureq` (`#[ignore]`d) |

Trait seams (`PiperRunner`, `Encoder`, `VoiceSource`, `Store`, `Db`) keep real
piper/ffmpeg/network out of unit tests — the pattern mandated by
[`docs/specs/personal-server/spec.md`](specs/personal-server/spec.md) § Testing strategy.

### The `#[ignore]` contract

`tests/server_e2e.rs` has two `#[ignore]`d tests
(`real_synth_produces_full_opus_bundle`, `real_resynth_revoices_full_bundle`).
They soft-skip unless the gate resolves, and encode the full upload → synth →
poll → download loop (asserting every segment carries `OggS` magic). They
`include_bytes!` the committed text-only fixture, so no hand-built bundle is
needed. The **only** assertion they cannot make is "audio plays on the phone" —
that's the manual runbook (below).

```
export TALETREK_VOICE_PATH=/abs/path/to/en_US-hfc_female-medium.onnx
# optional:
# export TALETREK_PIPER_BIN=/opt/piper/piper
# export TALETREK_FFMPEG_BIN=/usr/bin/ffmpeg
cargo test -p taletrek-server --test server_e2e -- --ignored --nocapture
```

---

## 3. Desktop — `desktop/`

Binary `taletrek-desktop`. Headless `clap` CLI with `synth` and `resynth`
subcommands. No HTTP.

### Run

```
cargo test -p taletrek-desktop                      # all non-ignored tests
cargo test -p taletrek-desktop --test synth_e2e -- --ignored --nocapture  # real piper+ffmpeg
```

### Layers

| Layer               | Where                         | What it covers                                                |
| ------------------- | ----------------------------- | ------------------------------------------------------------- |
| Unit (inline)       | `src/bundle_io.rs`, `src/cli.rs` | argument parsing, bundle read/write, error paths              |
| Integration (gated) | `tests/synth_e2e.rs`            | spawns itself via `env!("CARGO_BIN_EXE_taletrek-desktop")`, full synth + resynth round-trip (`#[ignore]`d) |

Same `TALETREK_VOICE_PATH` gate as the server; same `include_bytes!` of the
text-only fixture. The desktop's behavior is the regression gate for the
`crates/worker` extraction — keep these green when touching shared code.

---

## 4. Shared crates

### `crates/synth` — pure core ( Effort 1, shipped )

- **Integration tests:** `tests/{bundle_round_trip,cache_key_parity,fixtures_conformance,synth_integration}.rs`
- **Fixtures (cross-language):** `tests/fixtures/{book-text-only,book-full}.taletrek`, `library.taletrek-lib` — consumed by both the SPA's `parity.test.ts` and the desktop/server e2e tests. Regenerate via `examples/gen_fixtures.rs`.
- **Inline tests:** `cache_key.rs`, `encode.rs`, `normalize.rs`, `pcm.rs`, `synth.rs`.
- `cache_key_parity.rs` pins **exact SHA-256 values** — the foundation of cross-app audio dedup.

### `crates/worker` — host-level voice/synth pool ( Effort 4 )

- Inline `#[cfg(test)]` modules in `src/{voices,synth_job,stamp,progress}.rs`.
- All tests use stub `PiperRunner` + stub `VoiceSource` — no network.

Workspace-wide:

```
cargo build --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Toolchain pinned to **1.97.0** ([`rust-toolchain.toml`](../rust-toolchain.toml));
workspace lints (`unsafe_code = forbid`, `missing_docs = warn`, clippy
`all`+`cargo`) inherited from the root [`Cargo.toml`](../Cargo.toml).

---

## 5. Docker — server image

```
docker build -f server/Dockerfile -t taletrek-server .
docker run -p 7878:7878 -e TALETREK_TOKEN=... -v tt-data:/data taletrek-server
curl -fsS http://127.0.0.1:7878/api/health   # → ok (the only unauthenticated route)
```

The image bakes in `piper` + `ffmpeg`; voice models download on first synth
into the `/data/voices` volume. Image is ~865 MiB (dominated by apt `ffmpeg`).
See [`docs/specs/personal-server/runbook.md`](specs/personal-server/runbook.md) §3.

---

## 6. CI matrix

Today [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the **SPA
only** (`pnpm lint/typecheck/test/build`). The Rust workspace + Docker image
are **not** in CI yet — that's the next planned step (adds `rust`, `docker`,
and a non-blocking `integration` job for the `#[ignore]`d tests). When it
lands, this section becomes the authoritative job map.

---

## Manual end-to-end runbook

The one assertion no test can make — *"synthesized audio actually plays on the
phone"* — is covered by the human runbook at
[`docs/specs/personal-server/runbook.md`](specs/personal-server/runbook.md).
Run it before declaring an effort shipped, and whenever you touch the server's
synth runner, HTTP handlers, or the shared `crates/worker` stamp path.
