# Developing locally

> The dev-loop companion to [`docs/testing.md`](testing.md) (what to *run*)
> and the per-effort runbooks (full smoke loops). Everything below assumes
> [`just`](https://github.com/casey/just) (`cargo install just`, or your
> package manager) — `just` alone lists every recipe.

## Quickstart

| App            | Command                | URL                            | Needs                        |
| -------------- | ---------------------- | ------------------------------ | ---------------------------- |
| SPA / PWA      | `just dev-web`         | <http://localhost:8253>        | nothing                      |
| Desktop (GUI)  | `just gui`             | native window (egui)           | `just setup` (voice + espeak-ng-data; no external binaries) |
| Desktop (CLI)  | `just parse IN OUT` / `just synth IN OUT` | writes a `.taletrek` file      | `just setup` (voice + espeak-ng-data; no external binaries)     |

First time in the repo: `just setup` (pnpm install + the seeded voice +
espeak-ng-data the in-process engine needs, plus piper/ffmpeg for the
subprocess overrides and e2e tests — no sudo, idempotent).

> **Post-pivot shape (ADR-0015):** the SPA no longer synthesizes — it imports
> pre-synthesized `.taletrek` bundles and plays them. To get audio into the SPA
> locally, synth a bundle with the desktop CLI and import it in the library.

## SPA — `just dev-web`

- Vite dev server on **:8253** (spells "TALE" on a keypad — project-unique, so
  it never collides with other dev servers; `strictPort` fails loudly rather
  than silently hopping). The throwaway spikes keep 5174/5175.
- Fully self-contained: reader + playback of imported bundles; no native deps.
- Prod build / preview: `pnpm build` then `pnpm preview`.

## Desktop — `just parse` / `just synth` / `just resynth`

The desktop app is a headless CLI (no long-running process), so "dev-desktop"
is a one-shot parse or synth:

```
# source document → text-only bundle (txt/md/html/epub/docx/pdf)
just parse crates/parse/testdata/plain.txt /tmp/plain.taletrek
# or the shortcut:
just parse-fixture

# text-only bundle → full audio bundle
just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek
# or the shortcut:
just synth-fixture

# chained one-command: source document → full audio bundle (parse + synth in memory)
just synth crates/parse/testdata/plain.txt /tmp/plain.synth.taletrek
# or the shortcut:
just chain-fixture
```

- Synthesis runs **in-process by default** — the sherpa-onnx TTS engine + the
  vendored libopus encoder, no piper/ffmpeg on `PATH`. The voice auto-resolves
  from the seeded cache (no download on first run). `--piper <bin>` /
  `--ffmpeg <bin>` independently demote either side back to the subprocess
  engines (e.g. `just synth` + A/B-ing encoders). Default `--jobs`: 2 for the
  native engine (each job holds a ~212 MB model), CPU count for `--piper`;
  explicit `--jobs` always wins.
- `synth --input` accepts a source document (`.txt`/`.md`/`.html`/`.epub`/
  `.docx`/`.pdf`) as well as a `.taletrek` bundle — sources are parsed in
  memory first, so nothing intermediate hits disk; the default output keeps
  the synth naming rule (`<stem>.synth.taletrek`). `resynth` stays
  bundle-only.
- Re-voice an existing full bundle:
  `just resynth /tmp/book.synth.taletrek en_US-ryan-medium /tmp/book.ryan.taletrek`
- Verify + listen:
  `unzip -p /tmp/book.synth.taletrek manifest.json | python3 -m json.tool`
  then extract an `audio/*.opus` entry and play it (`ffplay`/`mpv`).
- Full guide: the [desktop-synth-app runbook](specs/desktop-synth-app/runbook.md).

## Desktop GUI — `just gui`

The windowed app (egui): **Add files…** → pick documents (`.epub`/`.txt`/
`.md`/`.html`/`.docx`/`.pdf`, or a text-only `.taletrek`) → each converts to
a full bundle written beside its source (`<stem>.synth.taletrek`, the CLI
naming rule). The voice auto-resolves like the CLI — seeded cache first,
blocking download on first use (progress shown on the job row). Jobs run
one at a time (FIFO); closing the window mid-job waits for that job to
finish so the bundle is never half-written. Bare `taletrek-desktop` (no
subcommand) opens the same window. The renderer is wgpu (Vulkan/GL) by
default; `TALETREK_RENDERER=glow` selects the GLX fallback for
Vulkan-less environments (Xvfb, some VMs/remote sessions).

The same window reads books back (`desktop-reader-page`): **Read** on a
done row, or **Open bundle…** in the top bar for any `.taletrek` on disk.
The book opens with a chapter outline and a serif text pane; narrated
bundles play paragraph-synced (highlight follows the voice, the pane
follows the highlight until you scroll elsewhere; paragraphs and outline
entries are click-to-seek; the scrub slider restarts the current
paragraph at a decoded offset). Position persists per book — resume
survives Back, close, and relaunch. Text-only bundles read with the
transport disabled. Conversions keep running in the queue while a book
is open. The full manual smoke loop: [`docs/testing.md`](testing.md) §
Manual end-to-end runbook.

## Android — `just android` (effort 4)

The player app (`android/`, hand-rolled Gradle — no cargo-mobile2) wraps the
Rust kernel via UniFFI: `just android-kernel` cross-builds `crates/ffi` for
`arm64-v8a` + `x86_64` (cargo-ndk) into `android/app/src/main/jniLibs/`, and
the checked-in generated Kotlin (`android/app/src/main/java/dev/l1br3/taletrek/ffi/`,
regenerated by `just android-bindings`) calls it — Gradle never invokes Cargo.

One-time setup: **`just android-setup`** — idempotent and converging, it
installs everything below user-local (JDK + SDK under `~/.local/share`,
matching the recipes' `JAVA_HOME`/`ANDROID_HOME` defaults) and prints exact
commands for the few actions it can't run (KVM group, snap connect); re-run
until the summary says ready. Linux and macOS. Manual equivalent (versions
are the current pins; see the `android-app` task-002 Outcome for the pairing
rationale):

- **JDK 21** — Temurin; `JAVA_HOME` must point at it (the `just` recipes
  default to `~/.local/share/jdk`).
- **Android SDK** with `platform-tools`, `platforms;android-37`, `build-tools;36.0.0`,
  and `ndk;28.2.13676358` (r28c — also AGP 9's default). `ANDROID_HOME` must
  point at it (recipes default to `~/.local/share/android-sdk`). A user-local
  install works fine: cmdline-tools zip from
  `developer.android.com/studio#command-line-tools-only`, then
  `sdkmanager --licenses` + the packages above.
- **Rust Android targets**: `rustup target add aarch64-linux-android x86_64-linux-android`
- **cargo-ndk** (`cargo install cargo-ndk --locked`)
- **uniffi-bindgen** (bindings regen only): `cargo install uniffi --features cli --version 0.32.0 --locked`
  — the version must match the `uniffi` crate dep exactly (API checksums are
  verified at library load).

```
just android-setup         # one-time: JDK + SDK/NDK + cargo tools + emulator + AVD + scrcpy stack
just android               # kernel .so + gradle assembleDebug → APK
just android-serve-dev    # daily: build → emulator up (boot only if needed) → install → force-stop + relaunch TaleTrek (fast, no emulator reboot)
just android-serve-fresh  # clean slate: stop emulator → cold-boot (no quickboot resume) → install → relaunch
just android-fixtures     # push the test .taletrek bundles to the emulator's Download folder (manual import testing)
just android-push FILE    # push any file from your machine into the emulator's Download folder
just android-test         # JVM unit tests + ktlintCheck
just android-instrumented # kernel round-trip on device (ffi smoke)
just android-bindings     # regen the checked-in UniFFI Kotlin
```

JVM unit tests are pure-Kotlin only (the `.so` does not load on the JVM —
kernel-touching tests are instrumented by design); ktlint excludes the
generated `ffi/` package. Instrumented suites (`just android-instrumented`)
need a real device or emulator via adb — ffi round-trips, the playback walk,
the corrupt-segment walk, and the Compose reader/UI suites all run there;
with no device attached, the headless gates (`just android-test`,
`assembleDebug`) are the local loop, exactly like CI.

**Emulator:** works out of the box — the kernel `.so` is cross-built for
both `arm64-v8a` and `x86_64`, and the x86_64 ABI runs natively on standard
emulator system images (no ARM translation). Linux needs KVM.

```
just android-emulator-setup    # one-time: emulator + android-36 google_apis x86_64 image + `taletrek` AVD (pixel_6; idempotent, ~1.5 GB)
just android-serve-dev         # build → emulator up (boot only if needed) → install → relaunch TaleTrek (left running)
just android-serve-fresh       # same, but stops the emulator first and cold-boots (no quickboot resume)
just android-emulator-stop     # shut it down cleanly
```

(`scripts/setup-android-emulator.sh` behind the setup recipe wraps the raw
`sdkmanager`/`avdmanager` commands — binaries live under
`$ANDROID_HOME/cmdline-tools/latest/bin` and `$ANDROID_HOME/emulator` if you
need them directly. Windowed boots render via SwiftShader software GL
(`-gpu swiftshader_indirect`): the default host-GL pipe can show a black
window on hybrid-GPU laptops — override with `TT_EMULATOR_GPU=host`. Boot
log: `~/.cache/taletrek/emulator.log`.)
With the emulator up, `just android-instrumented` runs the on-device suites.
An emulator covers the ffi round-trips, playback/corrupt walks, Compose UI
suites, and most of the manual smoke (import → play → seek → kill → resume);
audio focus, real lock-screen behavior, and OEM background-killing are
device-only signal — the spec's final smoke stays a hardware checklist.

## Ports at a glance

| Port | What                       | Why                                        |
| ---- | -------------------------- | ------------------------------------------ |
| 8253 | SPA dev server             | unique ("TALE"), `strictPort`              |
| 5174 | spike/piper (throwaway)    | historical                                 |
| 5175 | spike/web-audio (throwaway)| historical                                 |

## Tests & gates

`just test-web` · `just test-rust` (hermetic) · `just test-e2e` (real
piper+ffmpeg, gate pre-wired) · `just verify` (SPA gates) · `just verify-rust`
(clippy `-D warnings` + tests). Details per layer: [`docs/testing.md`](testing.md).

## Releasing

Tag push → CI matrix → GitHub-release artifacts (`taletrek-<version>-<target>`):
see [`docs/releasing.md`](releasing.md).
