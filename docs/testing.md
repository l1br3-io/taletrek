# Testing

> Single source of truth for how each TaleTrek component is tested. Two
> shippable components — **SPA** (`web/`), **desktop** (`desktop/`) — plus two
> shared Rust crates (`crates/synth`, `crates/worker`). For the architectural
> shape, see [ADR-0013](adrs/0013-off-device-synth-and-portable-bundles.md) and
> [ADR-0015](adrs/0015-native-pivot-rust-kernel-and-native-apps.md).

## Components at a glance

| Component         | Location    | Stack                              | Default test command                | In CI?            |
| ---------------- | ----------- | ---------------------------------- | ----------------------------------- | ----------------- |
| SPA / PWA         | `web/`      | Vite 8 + React 19 + TS             | `pnpm test` (vitest)                | yes (`web`)       |
| Desktop CLI       | `desktop/`  | Rust + clap (headless)             | `cargo test -p taletrek-desktop`    | yes (`rust`)      |
| shared `synth`    | `crates/synth`  | Rust (pure core + bundle I/O)  | `cargo test -p taletrek-synth`      | yes (`rust`)      |
| shared `worker`   | `crates/worker` | Rust (voice/synth pool)        | `cargo test -p taletrek-worker`     | yes (`rust`)      |
| real-piper e2e (desktop) | `#[ignore]`d | cargo `--ignored` | manual or `integration` job | optional (`integration`, non-blocking) |

## Golden rule

**No real `piper` / `ffmpeg` / network in default CI.** Everything that needs
them is behind a `#[ignore]`d Rust integration test, gated on
`TALETREK_VOICE_PATH` (+ optional `TALETREK_PIPER_BIN` / `TALETREK_FFMPEG_BIN`),
and run either by hand or via a non-blocking `workflow_dispatch` job. The SPA
has no equivalent gate — its vitest suite is fully hermetic (jsdom +
`fake-indexeddb`).

## Local setup for real-synth work

One command installs the native deps into user caches (no sudo, idempotent):

```
pnpm setup:native        # = bash scripts/setup-native.sh
```

Installs piper → `~/.cache/taletrek/piper/`, pre-seeds the default voice
(`en_US-hfc_female-medium`) → `~/.cache/taletrek/voices/` (the same dir the
apps' curated auto-download uses), and checks `ffmpeg` (libopus). It prints the
`PATH` / `TALETREK_VOICE_PATH` exports to use for the `#[ignore]`d tests and
runbooks.

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

### Layers (co-located `*.test.{ts,tsx}` files)

| Layer            | Where                                  | Tooling                              |
| ---------------- | -------------------------------------- | ------------------------------------ |
| Pure logic       | `web/src/lib/**` (bundle, playback, audio, db) | plain vitest                         |
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

Full gotcha detail (incl. dormant/retired browser-facts): [`docs/gotchas.md`](gotchas.md).

---

## 2. Desktop — `desktop/`

Binary `taletrek-desktop`. Headless `clap` CLI with `synth` and `resynth`
subcommands. No HTTP.

### Run

```
cargo test -p taletrek-desktop                      # all non-ignored tests
cargo test -p taletrek-desktop --test synth_e2e -- --ignored --nocapture  # real piper+ffmpeg
```

### Layers

| Layer               | Where                         | What it covers                                                |
| ------------------ | ----------------------------- | ------------------------------------------------------------- |
| Unit (inline)       | `src/bundle_io.rs`, `src/cli.rs` | argument parsing, bundle read/write, error paths              |
| Integration (gated) | `tests/synth_e2e.rs`            | spawns itself via `env!("CARGO_BIN_EXE_taletrek-desktop")`, full synth + resynth round-trip (`#[ignore]`d) |

Same `TALETREK_VOICE_PATH` gate as the crates; same `include_bytes!` of the
text-only fixture. The desktop's behavior is the regression gate for the
`crates/worker` extraction — keep these green when touching shared code.

---

## 3. Shared crates

### `crates/synth` — pure core ( Effort 1, shipped )

- **Integration tests:** `tests/{bundle_round_trip,cache_key_parity,fixtures_conformance,synth_integration}.rs`
- **Fixtures (cross-language):** `tests/fixtures/{book-text-only,book-full}.taletrek`, `library.taletrek-lib` — consumed by both the SPA's `parity.test.ts` and the desktop e2e tests. Regenerate via `examples/gen_fixtures.rs`.
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

## 4. CI matrix

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs three jobs:

| Job            | Trigger                          | Blocks PR? | What it runs                                                                                              |
| -------------- | -------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------- |
| `web`            | push / PR                        | yes        | `pnpm lint && typecheck && test && build`                                                                   |
| `rust`           | push / PR                        | yes        | `cargo build --workspace --all-targets` + `clippy -- -D warnings` + `cargo test --workspace`                   |
| `integration`    | **`workflow_dispatch` only**     | **no** (`continue-on-error`) | installs piper+ffmpeg+voice, runs `cargo test --workspace -- --ignored` (the `#[ignore]`d e2e tests) |

The `integration` job installs the same `2023.11.14-2` piper tarball and
`en_US-hfc_female-medium` voice model documented in the setup script, so it
mirrors the manual gate.

---

## Manual end-to-end runbook

The assertions no test can make — *"synthesized audio actually plays"* and
*"the SPA imports and plays a real bundle"* — are covered by hand:

1. **Desktop synth loop:** the [desktop-synth-app runbook](specs/desktop-synth-app/runbook.md)
   (synth → inspect manifest → listen to an `audio/*.opus` entry).
2. **SPA loop:** `just synth-fixture`, then `pnpm dev` (or `pnpm preview`),
   import `/tmp/book.synth.taletrek` in the library, and play it — on a real
   phone for lock-screen behavior (gotcha #5).

Run these before declaring an effort shipped, and whenever you touch the
bundle pipeline, the playback engines, or the shared `crates/worker` stamp
path.
