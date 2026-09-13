# TaleTrek dev tasks — `just` with no args lists everything.
# The default synth engine is in-process (sherpa-onnx + vendored libopus — no
# external binaries); it needs the seeded voice + espeak-ng-data from
# `just setup`. piper/ffmpeg binaries are only needed for the `--piper`/
# `--ffmpeg` subprocess overrides and the #[ignore]d e2e tests.

cache_dir   := env_var_or_default('XDG_CACHE_HOME', home_directory() / '.cache') / 'taletrek'
piper_bin   := env_var_or_default('PIPER_BIN', cache_dir / 'piper' / 'piper')
voice_onnx  := env_var_or_default('VOICE_PATH', cache_dir / 'voices' / 'en_US-hfc_female-medium.onnx')

default:
    @just --list

# One-time setup: workspace deps + seeded voice/espeak-ng-data (native engine) + piper (overrides/e2e) into ~/.cache/taletrek
setup:
    pnpm install
    pnpm setup:native

# SPA dev server → http://localhost:8253 (unique port; strict — no silent hopping)
dev-web:
    @echo "→ TaleTrek SPA: http://localhost:8253"
    pnpm dev

# Desktop: synth a text-only bundle → full Opus bundle (in-process engines; voice auto-resolves from the seeded cache)
synth INPUT OUTPUT:
    cargo run -p taletrek-desktop -- synth --input {{INPUT}} --output {{OUTPUT}}

# Desktop: re-voice an existing full bundle (in-process engines by default)
resynth INPUT VOICE OUTPUT:
    cargo run -p taletrek-desktop -- resynth --input {{INPUT}} --voice {{VOICE}} --output {{OUTPUT}}

# Convenience: synth the committed fixture → /tmp/book.synth.taletrek
synth-fixture:
    @just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek

# Desktop: parse a source document (txt/md/html/epub/docx/pdf) → text-only .taletrek bundle
parse INPUT OUTPUT:
    cargo run -p taletrek-desktop -- parse --input {{INPUT}} --output {{OUTPUT}}

# Convenience: parse the committed TXT fixture → /tmp/plain.taletrek
parse-fixture:
    @just parse crates/parse/testdata/plain.txt /tmp/plain.taletrek

# Convenience: chained one-shot — synth straight from the committed TXT source → /tmp/plain.synth.taletrek
chain-fixture:
    @just synth crates/parse/testdata/plain.txt /tmp/plain.synth.taletrek

# Desktop GUI (egui): pick documents → queue → convert → .taletrek beside each
# source (voice auto-resolves from the seeded cache or downloads on first use)
gui:
    cargo run -p taletrek-desktop -- gui

# SPA tests (vitest)
test-web:
    pnpm test

# Rust workspace tests (hermetic — no piper/ffmpeg)
test-rust:
    cargo test --workspace

# Real-piper/ffmpeg/sherpa e2e (the #[ignore]d tests) — gate env pre-wired to the setup cache
test-e2e:
    TALETREK_PIPER_BIN={{piper_bin}} TALETREK_VOICE_PATH={{voice_onnx}} TALETREK_ESPEAK_DATA={{cache_dir}}/espeak-ng-data cargo test --workspace --features taletrek-synth/sherpa -- --ignored --nocapture

# SPA gates: lint + typecheck + test + build
verify:
    pnpm verify

# Rust gates: clippy -D warnings + tests
verify-rust:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace

# --- Android (effort 4) --------------------------------------------------------

# Android toolchain locations (docs/developing.md § Android — override via env)
android_home := env_var_or_default('ANDROID_HOME', home_directory() / '.local' / 'share' / 'android-sdk')
java_home    := env_var_or_default('JAVA_HOME', home_directory() / '.local' / 'share' / 'jdk')

# Kernel → .so for both ABIs, placed into android jniLibs (cargo-ndk; NDK r28c)
#
# GOTCHA (three linking traps, all hit in android-pipeline T1 — fat .so):
# 1. opusic-sys (bundled libopus via cmake) only switches to the NDK toolchain
#    file when ANDROID_NDK_HOME is exported — cargo-ndk sets just ANDROID_HOME,
#    and without it system cmake's Android-Determine fails ("Neither the NDK
#    or a standalone toolchain was found").
# 2. sherpa-onnx-sys forces SHARED linking on Android and its prebuilt archive
#    extracts jniLibs/ with NO top-level dir, while its build script expects
#    <stem>/jniLibs/<abi>/ and panics otherwise ("Downloaded archive did not
#    contain a lib directory") — pre-arrange that layout here (archive
#    downloaded once, extracted into the stem dir; its early-return path then
#    skips its own download). Version derives from Cargo.lock so a sherpa bump
#    flows through.
# 3. Shared linking means libtaletrek_ffi.so carries DT_NEEDED on
#    libsherpa-onnx-c-api.so + libonnxruntime.so — both must be copied into
#    jniLibs or the APK installs but fails to load (skip -jni/-cxx-api: the
#    app never loads those two, ~5 MB/ABI saved).
# GOTCHA: just backticks do not interpolate {{...}} — keep variable-free.
sherpa_ver := `grep -A1 'name = "sherpa-onnx-sys"' Cargo.lock | grep version | cut -d'"' -f2`

android-kernel:
    #!/usr/bin/env bash
    set -euo pipefail
    ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
    NDK="$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)"
    SHERPA=target/sherpa-onnx-prebuilt
    STEM="sherpa-onnx-v{{sherpa_ver}}-android"
    if [ ! -d "$SHERPA/$STEM/jniLibs/arm64-v8a" ]; then
        mkdir -p "$SHERPA/$STEM"
        if [ ! -f "$SHERPA/$STEM.tar.bz2" ]; then
            curl -fL -o "$SHERPA/$STEM.tar.bz2" \
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v{{sherpa_ver}}/$STEM.tar.bz2"
        fi
        tar -xjf "$SHERPA/$STEM.tar.bz2" -C "$SHERPA/$STEM"
    fi
    ANDROID_HOME="$ANDROID_HOME" ANDROID_NDK_HOME="$NDK" \
        cargo ndk -t arm64-v8a -t x86_64 \
        -o android/app/src/main/jniLibs build -p taletrek-ffi --lib --release
    for abi in arm64-v8a x86_64; do
        cp "$SHERPA/$STEM/jniLibs/$abi/libsherpa-onnx-c-api.so" \
           "$SHERPA/$STEM/jniLibs/$abi/libonnxruntime.so" \
           "android/app/src/main/jniLibs/$abi/"
    done

# Regenerate the checked-in UniFFI Kotlin bindings for crates/ffi into the
# app's ffi package (task 002 consumes; Gradle never invokes Cargo).
# One-time prerequisite: cargo install uniffi --features cli --version 0.32.0 --locked
# (host cdylib carries the proc-macro metadata; Linux names it .so)
android-bindings:
    cargo build -p taletrek-ffi --lib
    uniffi-bindgen generate --library target/debug/libtaletrek_ffi.so --language kotlin \
        --config crates/ffi/uniffi.toml --no-format --out-dir android/app/src/main/java

# One-time: emulator + system image + `taletrek` AVD (idempotent; ~1.5 GB download)
android-emulator-setup:
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} bash scripts/setup-android-emulator.sh

# The daily dev command (dev-web's counterpart): build the debug APK, make
# sure a windowed emulator is up (cold-boot only if none), reinstall, and
# force-stop + relaunch TaleTrek — app-level restart, no emulator reboot
android-serve-dev: android
    just _android-serve fast

# Clean-slate variant: also stops any running emulator and cold-boots fresh
# (-no-snapshot — no quickboot resume) before reinstall + relaunch
android-serve-fresh: android
    just _android-serve fresh

# Workhorse behind the serve recipes; mode = fast | fresh. Boot always uses
# software GL (swiftshader_indirect) — on hybrid-GPU hosts (Intel+NVIDIA) the
# default host-GL pipe renders a black window (guest fine, window dead);
# override via TT_EMULATOR_GPU.
_android-serve mode:
    #!/usr/bin/env bash
    set -euo pipefail
    EMU="{{android_home}}/emulator/emulator"
    ADB="{{android_home}}/platform-tools/adb"
    [ -x "$EMU" ] || { echo "emulator not installed — run: just android-emulator-setup"; exit 1; }
    "$EMU" -list-avds | grep -qx taletrek || { echo "AVD 'taletrek' missing — run: just android-emulator-setup"; exit 1; }
    [ -e /dev/kvm ] || { echo "/dev/kvm missing — the emulator needs KVM on Linux"; exit 1; }
    running() { "$ADB" devices | grep -q '^emulator-'; }
    if running && { [ "{{mode}}" = "fresh" ] || pgrep -f 'qemu-system-.*-headless' >/dev/null; }; then
        echo "emulator: stopping previous instance"
        "$ADB" emu kill || true
        for _ in $(seq 1 30); do running || break; sleep 1; done
        running && { echo "emulator: did not stop within 30s — run: just android-emulator-stop, then retry"; exit 1; }
    fi
    if ! running; then
        mkdir -p "{{cache_dir}}"
        nohup "$EMU" -avd taletrek -no-snapshot -gpu "${TT_EMULATOR_GPU:-swiftshader_indirect}" \
            > "{{cache_dir}}/emulator.log" 2>&1 &
        echo "emulator: cold-booting (windowed) — takes a minute or two (log: {{cache_dir}}/emulator.log)"
    fi
    "$ADB" wait-for-device
    for _ in $(seq 1 150); do
        [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] && break
        sleep 2
    done
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] \
        || { echo "emulator: boot timed out (5 min) — check the emulator window"; exit 1; }
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android installDebug
    "$ADB" shell am force-stop dev.l1br3.taletrek
    "$ADB" shell am start -n dev.l1br3.taletrek/.MainActivity
    echo "taletrek: relaunched (fresh process) — emulator stays up (stop: just android-emulator-stop)"

# Push a file from your machine into the emulator's Download folder — then
# in TaleTrek tap Import and pick it from the Downloads root in the picker
android-push file:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    FILE="{{file}}"
    "$ADB" devices | grep -q '^emulator-' || { echo "no device — run: just android-serve-dev first"; exit 1; }
    "$ADB" push "$FILE" /sdcard/Download/
    "$ADB" shell content call --uri content://media/none/media_scanner \
        --method scan_volume --arg external_primary >/dev/null 2>&1 || true
    echo "pushed: $FILE — in the app tap Import, then pick Downloads in the picker"

# Push the test .taletrek bundles into the emulator's Download folder — for
# manually testing Library import (picker → Downloads root). Idempotent.
android-fixtures:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    "$ADB" devices | grep -q '^emulator-' || { echo "no device — run: just android-serve-dev first"; exit 1; }
    for f in crates/synth/tests/fixtures/*.taletrek; do
        "$ADB" push "$f" /sdcard/Download/ >/dev/null
        echo "pushed: $(basename "$f")"
    done
    "$ADB" shell content call --uri content://media/none/media_scanner \
        --method scan_volume --arg external_primary >/dev/null 2>&1 || true
    echo "fixtures: /sdcard/Download — in the app tap Import, then pick Downloads in the picker"

# Shut the running emulator down cleanly (adb emu kill)
android-emulator-stop:
    @"{{android_home}}/platform-tools/adb" emu kill && echo "emulator: stopped" || echo "emulator: not running"

# Build debug APK (kernel + gradle assembleDebug)
android: android-kernel
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android assembleDebug

# Kotlin JVM unit tests + ktlint (gradlew testDebugUnitTest — pure-Kotlin only;
# the .so does not load on the JVM — instrumented is where kernel code runs)
android-test:
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android testDebugUnitTest ktlintCheck

# Instrumented tests on connected device (kernel round-trip, Compose UI)
android-instrumented:
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android connectedDebugAndroidTest
