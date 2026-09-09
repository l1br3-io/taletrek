# Releasing

> How a tag becomes downloadable artifacts. The workflow is
> [`.github/workflows/release.yml`](../.github/workflows/release.yml)
> (effort `desktop-synth-gui` T10) — hand-rolled, no cargo-dist.

## Tag → release

1. Ensure CI is green on the branch you're tagging.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the tag must match the
   workspace version in root `Cargo.toml`.
3. The workflow builds a release artifact per target (matrix below) and
   attaches them to the tag's GitHub release. Free downloads, no store.

Artifacts are named `taletrek-<version>-<target>` —
`.tar.gz` on Linux/macOS, `.zip` on Windows — and each contains the single
`taletrek-desktop` binary. Linux/macOS users: `chmod +x` after extract.

| Target | OS | Status |
| --- | --- | --- |
| `x86_64-unknown-linux-gnu` | ubuntu | **first-class** — smoke-tested (`--version` + a real `parse` on a fixture) before upload |
| `aarch64-unknown-linux-gnu` | ubuntu (cross) | best-effort (`continue-on-error`) |
| `x86_64-pc-windows-msvc` | windows | best-effort |
| `aarch64-apple-darwin` | macos (arm64) | best-effort |

**glibc, not musl** (spike outcome, T1/T2): onnxruntime, espeak-ng,
piper_phonemize and libopus all statically link under the `gnu` target, so the
binary depends only on baseline system libs — musl would add risk (k2-fsa's
prebuilt sherpa archives) for zero portability gain.

## Dry runs

`workflow_dispatch` on any branch runs the same build + smoke + artifact
upload without creating a release — use it to test workflow changes:

```
gh workflow run Release --ref <branch>
```

Artifacts land on the run page (not on any release).

## Build requirements (what CI installs)

Nothing beyond a Rust toolchain, **cmake + a C compiler** for the `opus`
crate's bundled libopus (T2), **`libasound2-dev`** for cpal's alsa-sys
(reader effort T1), and — for the aarch64-linux cross only — the
`gcc-aarch64-linux-gnu` cross toolchain plus the arm64 multiarch
`libasound2-dev:arm64` with `PKG_CONFIG_LIBDIR` pointed at the arm64 pc
dir (CI does the `dpkg --add-architecture arm64` dance). sherpa-onnx
statically links its own prebuilt archive; no
cmake/libclang/onnxruntime system deps (T1).

## Android artifacts (`taletrek-<version>-android*`)

The `android` job (effort `android-app` T10) mirrors the CI android job:
kernel `.so` cross-build via cargo-ndk, then `gradlew bundleRelease
assembleRelease`. On a **tag push** it attaches two artifacts to the
release:

- `taletrek-<version>-android.aab` — the signed bundle (store-ready for
  a later Play submission; submission itself is out of scope)
- `taletrek-<version>-android-universal.apk` — the signed universal APK
  (both ABIs, side-load friendly; this is what the landing page links to)

Dry runs (`workflow_dispatch`) build the same artifacts **unsigned** and
attach them to the run only — never a release (the workflow's existing
convention).

### Signing

The keystore never lives in the repo. One-time, ask-first setup
(create it yourself; keep a backup — a lost keystore means a new app
identity on any future store listing):

```
keytool -genkeypair -v \
  -keystore taletrek-release.jks -alias taletrek \
  -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 taletrek-release.jks   # → the TALETREK_ANDROID_KEYSTORE secret
```

GitHub secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `TALETREK_ANDROID_KEYSTORE` | base64 of the `.jks` (no newlines stripped) |
| `TALETREK_ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `TALETREK_ANDROID_KEY_ALIAS` | `taletrek` (per the command above) |
| `TALETREK_ANDROID_KEY_PASSWORD` | the key password |

The tag build decodes the keystore into `$RUNNER_TEMP` and exports the
four as env vars — Gradle's signing config is env-driven and opt-in
(`android/app/build.gradle.kts`); without them the same commands produce
the unsigned dry-run artifacts.
