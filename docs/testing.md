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
| Desktop app (GUI + CLI) | `desktop/` | Rust + clap + egui            | `cargo test -p taletrek-desktop`    | yes (`rust`)      |
| shared `synth`    | `crates/synth`  | Rust (pure core + bundle I/O)  | `cargo test -p taletrek-synth`      | yes (`rust`)      |
| shared `reader`   | `crates/reader` | Rust (read-side kernel core)   | `cargo test -p taletrek-reader`     | yes (`rust`)      |
| shared `worker`   | `crates/worker` | Rust (voice/synth pool)        | `cargo test -p taletrek-worker`     | yes (`rust`)      |
| real-piper e2e (desktop) | `#[ignore]`d | cargo `--ignored` | manual or `integration` job | optional (`integration`, non-blocking) |

## Golden rule

**No real `piper` / `ffmpeg` / network in default CI.** Everything that needs
them is behind a `#[ignore]`d Rust integration test, gated on
`TALETREK_VOICE_PATH` (+ optional `TALETREK_PIPER_BIN` / `TALETREK_FFMPEG_BIN`),
and run either by hand or via a non-blocking `workflow_dispatch` job. The SPA
has no equivalent gate — its vitest suite is fully hermetic (jsdom +
`fake-indexeddb`). The in-process sherpa test (`taletrek-synth`, feature
`sherpa`) additionally resolves espeak-ng-data via `TALETREK_ESPEAK_DATA`
(default `~/.cache/taletrek/espeak-ng-data`, seeded by the setup script);
`just test-e2e` wires all of it, including `--features taletrek-synth/sherpa`.

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

Binary `taletrek-desktop`. `clap` CLI (`parse`, `synth`, `resynth`, `gui`;
bare invocation opens the GUI). No HTTP.

### Run

```
cargo test -p taletrek-desktop                      # all non-ignored tests
cargo test -p taletrek-desktop --test synth_e2e -- --ignored --nocapture  # real piper+ffmpeg
```

### Layers

| Layer               | Where                         | What it covers                                                |
| ------------------ | ----------------------------- | ------------------------------------------------------------- |
| Unit (inline)       | `src/bundle_io.rs`, `src/cli.rs` | argument parsing, bundle read/write, error paths              |
| GUI unit (inline)   | `src/gui/**` (`queue.rs`, `executor.rs`, `settings.rs`, `views/`, `theme.rs`) | the pure job-queue state machine + executor cores (voice snapshot, cancel, retry, re-voice, humanized errors, settings persistence snapshots) — no egui types in the tested seams; plus the theme layer (`desktop-ux-refresh`): token tables pinned to the exact web hexes in both themes, WCAG contrast sanity, embedded-font registration incl. the builtin fallback chains (the `◐` cover — Hack is the one builtin face with U+25D0), and `ctx.run_ui` paint passes rendering real views through the production path (egui aborts on layout/font misuse); manual smoke is the release gate |
| Reader unit (inline) | `src/gui/reader/**` (`audio.rs`, `playback.rs`, `scroll.rs`, `session.rs`, `view.rs`, `position_store.rs`) | the read-back loop (`desktop-reader-page`): hermetic OGG/Opus decode of **both** lineages — our native encoder's output round-tripped live, and the committed ffmpeg fixture below; the engine over a stub device (ack/tick/drain/fail events, offset resume, stop semantics); the playback controller over a scripted transport (the same-key re-load race, duration lifecycle, restore seeding); the egui screen through `ctx.run_ui` paint passes with pointer-event geometry probes (highlight, click-to-seek, scrub gestures, follow-vs-free wheel scrolls, restore-scroll landing); position persistence round-trips + corrupt-entry discard; the big-book walk (50×60 paragraphs through the real open path, per-chapter layout invariant + paint bound); the coexistence loop (executor drain/pump + reader render + scripted playback in one frame loop); real-device open is `#[ignore]`d (cpal) |
| Integration (gated) | `tests/synth_e2e.rs`            | spawns itself via `env!("CARGO_BIN_EXE_taletrek-desktop")`, full synth + resynth round-trip (`#[ignore]`d) |
| Integration (gated) | `tests/engine_parity.rs`        | native vs subprocess (`--piper`/`--ffmpeg`) engines → identical cache-key sets (`#[ignore]`d) |

Same `TALETREK_VOICE_PATH` gate as the crates; same `include_bytes!` of the
text-only fixture. The desktop's behavior is the regression gate for the
`crates/worker` extraction — keep these green when touching shared code.

### Reader decode fixtures

- `tests/fixtures/ffmpeg_opus.ogg` — 3 s of 440 Hz sine at 16 kHz mono,
  encoded with the **exact** `OpusEncoder` subprocess invocation, so the
  decode path is pinned against the `--ffmpeg` lineage without keeping
  ffmpeg in CI. Regenerate (only when the invocation changes — the bytes
  are the contract, don't churn them):

  ```sh
  # 1. produce wav (3 s, 440 Hz, 16 kHz, mono, s16le) — any tool
  # 2. the production invocation (crates/synth/src/encode.rs):
  ffmpeg -hide_banner -loglevel error -i pipe:0 \
         -c:a libopus -b:a 24000 -f opus pipe:1 < in.wav \
         > desktop/tests/fixtures/ffmpeg_opus.ogg
  ```

---

## 3. Shared crates

### `crates/synth` — pure core ( Effort 1, shipped )

- **Integration tests:** `tests/{bundle_round_trip,cache_key_parity,fixtures_conformance,synth_integration}.rs`
- **Fixtures (cross-language):** `tests/fixtures/{book-text-only,book-full}.taletrek`, `library.taletrek-lib` — consumed by both the SPA's `parity.test.ts` and the desktop e2e tests. Regenerate via `examples/gen_fixtures.rs`.
- **Inline tests:** `cache_key.rs`, `encode.rs`, `normalize.rs`, `pcm.rs`, `synth.rs`.
- `cache_key_parity.rs` pins **exact SHA-256 values** — the foundation of cross-app audio dedup.

### `crates/reader` — read-side kernel core ( Effort 3.6, shipped )

- **Inline tests:** `src/{index,state,position}.rs` — `BookIndex` build +
  navigation totality, the `PlayerState` event matrix (boundaries, races,
  skip-on-fail, text-only absorption), `Position` round-trip + key
  derivation.
- **Anti-drift (`tests/anti_drift.rs`):** a real bundle written with
  writer-shaped audio reads back with archive key set ≡ `BookIndex`-derived
  key set — the cross-platform guarantee efforts 4–5 inherit.
- Zero deps beyond `taletrek-synth` — no UI, audio, hardware, or fs.

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

## Loop budgets

The feedback loops around these suites (effort `fast-test-loops`): scoped
loops answer in seconds, the instrumented matrix shards across two emulators,
and the pre-ship matrix runs once — in parallel. Numbers below are this-host
measurements (62 GB / 32 cores, KVM); the source of truth with per-run detail
and the structural findings is the fast-test-loops effort record
(`git log --grep fast-test-loops`).

| Loop | Recipe | Baseline | After | Notes |
| --- | --- | --- | --- | --- |
| Android JVM, cold (after `gradlew clean`) | `just android-test` | 10 s | **1 s** | gradle build cache (26 tasks `FROM-CACHE`); warm was already ~1 s |
| Android JVM, scoped class | `just android-test-class <fqcn>` | n/a | **~2 s** | `--tests` filter + ktlint; a wrong filter fails non-zero |
| Rust, warm full | `just test-rust` | 78 s | ~75–100 s | nextest runs binaries in parallel; the wall is the 10k-paragraph `peak_memory` proof (74–100 s solo) — runner is not the lever |
| Rust, scoped crate | `just test-rust-pkg ffi` | n/a (full gate 78–100 s) | **1–4 s** | the real dev-loop win |
| Rust gates | `just verify-rust` | 80 s | ~119 s* | clippy + nextest + doc-tests; *same pole variance, see baseline |
| Instrumented, 1 device | `just android-instrumented` | **237 s** median | unchanged (fallback path) | serial, AGP-connected |
| Instrumented, 2 devices (sharded) | `just android-instrumented` | (baseline above) | **125 s** (117 s on-device) | 42/42; halves count-summed against the source `@Test` total |
| Pre-ship matrix | `just verify-all` | ~331 s serial sum | parallel (all four legs at once) | per-suite PASS/FAIL + timing; `JOBS=serial` to debug |

To re-measure (bash `SECONDS`, suite must exit 0 or the number doesn't count):

```sh
T0=$SECONDS; just <recipe> >/tmp/loop.log 2>&1; echo "rc=$? $((SECONDS-T0))s"
# android-test cold first:  android/gradlew --project-dir android clean -q
# rust touch-cold first:     touch crates/{parse,reader,synth,worker,ffi}/src/lib.rs desktop/src/main.rs
```

Sharding notes (why `android-instrumented` is hand-rolled): AGP's
multi-device `connectedDebugAndroidTest` **duplicates** the full suite on
every device (no time saved), and its class-filter property **mangles comma
lists** (runs only the first class; raw `am instrument` handles them fine).
The recipe therefore does one gradle install pass + two parallel raw
`am instrument` halves; new test classes auto-append to the lighter half.

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
3. **Desktop reader loop** (`desktop-reader-page`): `just gui` → convert a
   document → **Read** on the done row → hear audio with the highlight
   tracking and the pane following → click a paragraph / outline entry /
   scrub → **Back to queue** and re-open (position resumes at the paragraph)
   → close the app mid-book and relaunch → re-open (position restored) →
   *Open bundle…* on a text-only `.taletrek` (reads fully, transport
   disabled with the hint) and on an arbitrary disk bundle. Convert another
   file while a book plays — playback must not stall.

Run these before declaring an effort shipped, and whenever you touch the
bundle pipeline, the playback engines, the reader, or the shared
`crates/worker` stamp path.
