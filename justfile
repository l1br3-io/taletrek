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
    @pnpm install
    @pnpm setup:native

# SPA dev server → http://localhost:8253 (unique port; strict — no silent hopping)
dev-web:
    @echo "→ TaleTrek SPA: http://localhost:8253"
    @pnpm dev

# Desktop: synth a text-only bundle → full Opus bundle (in-process engines; voice auto-resolves from the seeded cache)
synth INPUT OUTPUT:
    @cargo run -p taletrek-desktop -- synth --input {{INPUT}} --output {{OUTPUT}}

# Desktop: re-voice an existing full bundle (in-process engines by default)
resynth INPUT VOICE OUTPUT:
    @cargo run -p taletrek-desktop -- resynth --input {{INPUT}} --voice {{VOICE}} --output {{OUTPUT}}

# Convenience: synth the committed fixture → /tmp/book.synth.taletrek
synth-fixture:
    @just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek

# Desktop: parse a source document (txt/md/html/epub/docx/pdf) → text-only .taletrek bundle
parse INPUT OUTPUT:
    @cargo run -p taletrek-desktop -- parse --input {{INPUT}} --output {{OUTPUT}}

# Convenience: parse the committed TXT fixture → /tmp/plain.taletrek
parse-fixture:
    @just parse crates/parse/testdata/plain.txt /tmp/plain.taletrek

# Convenience: chained one-shot — synth straight from the committed TXT source → /tmp/plain.synth.taletrek
chain-fixture:
    @just synth crates/parse/testdata/plain.txt /tmp/plain.synth.taletrek

# Desktop GUI (egui): pick documents → queue → convert → .taletrek beside each
# source (voice auto-resolves from the seeded cache or downloads on first use)
gui:
    @cargo run -p taletrek-desktop -- gui

# SPA tests (vitest)
test-web:
    @pnpm test

# Rust workspace tests (hermetic — no piper/ffmpeg). cargo-nextest runs the
# test binaries in parallel when on $PATH (fallback: plain cargo test);
# nextest never runs doc-tests — the verify-rust gate covers those.
test-rust:
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v cargo-nextest >/dev/null 2>&1; then
        cargo nextest run --workspace
    else
        cargo test --workspace
    fi

# Scoped Rust dev loop: pkg is the crate suffix (ffi → taletrek-ffi, empty =
# whole workspace). Convenience only — never replaces the full gate.
test-rust-pkg pkg="":
    #!/usr/bin/env bash
    set -euo pipefail
    if command -v cargo-nextest >/dev/null 2>&1; then
        if [ -n "{{pkg}}" ]; then cargo nextest run -p "taletrek-{{pkg}}"; else cargo nextest run --workspace; fi
    else
        if [ -n "{{pkg}}" ]; then cargo test -p "taletrek-{{pkg}}"; else cargo test --workspace; fi
    fi

# Real-piper/ffmpeg/sherpa e2e (the #[ignore]d tests) — gate env pre-wired to the setup cache
test-e2e:
    @TALETREK_PIPER_BIN={{piper_bin}} TALETREK_VOICE_PATH={{voice_onnx}} TALETREK_ESPEAK_DATA={{cache_dir}}/espeak-ng-data cargo test --workspace --features taletrek-synth/sherpa -- --ignored --nocapture

# SPA gates: lint + typecheck + test + build
verify:
    @pnpm verify

# Rust gates: clippy -D warnings + tests. When nextest serves the unit run,
# cargo test --workspace --doc always finishes the gate (nextest doesn't run
# doc-tests) — the gate can never silently narrow.
verify-rust:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo clippy --workspace --all-targets -- -D warnings
    if command -v cargo-nextest >/dev/null 2>&1; then
        cargo nextest run --workspace
        cargo test --workspace --doc
    else
        cargo test --workspace
    fi

# The pre-ship full matrix in one command: verify-rust + android-test +
# test-web + android-instrumented — in PARALLEL by default with per-suite
# wall time and PASS/FAIL (non-zero exit if any leg fails; logs kept under
# /tmp/taletrek-verify-all/). The instrumented leg needs devices: fewer than
# two connected and the pair boots first via android-emulators-up (the
# sharded gate). JOBS=serial runs the legs one-by-one for debugging. Scoped
# recipes are dev conveniences — this is the matrix; nothing here replaces
# anything narrower.
verify-all:
    #!/usr/bin/env bash
    set -uo pipefail
    RUN_DIR=/tmp/taletrek-verify-all
    rm -rf "$RUN_DIR"; mkdir -p "$RUN_DIR"
    leg() {  # $1 = name, rest = command; records "name rc seconds"
        local NAME="$1"; shift
        local T0=$SECONDS RC=0
        "$@" > "$RUN_DIR/$NAME.log" 2>&1 || RC=$?
        echo "$NAME $RC $((SECONDS-T0))s" >> "$RUN_DIR/results"
    }
    ADB="{{android_home}}/platform-tools/adb"
    if ! "$ADB" devices | awk '/^emulator-.*device$/{n++} END{exit !(n>=2)}'; then
        echo "verify-all: fewer than 2 devices up — booting the pair (takes ~1 min)"
        just android-emulators-up
    fi
    if [ "${JOBS:-parallel}" = serial ]; then
        leg rust  just verify-rust
        leg jvm   just android-test
        leg web   just test-web
        leg instr just android-instrumented
    else
        leg rust  just verify-rust & P1=$!
        leg jvm   just android-test & P2=$!
        leg web   just test-web & P3=$!
        leg instr just android-instrumented & P4=$!
        wait "$P1" || true; wait "$P2" || true; wait "$P3" || true; wait "$P4" || true
    fi
    RC=0
    echo "verify-all:"
    while read -r NAME LRC DT; do
        ST=PASS; [ "$LRC" = 0 ] || { ST=FAIL; RC=1; }
        printf '  %-6s %-4s %-6s log: %s/%s.log\n' "$NAME" "$ST" "$DT" "$RUN_DIR" "$NAME"
    done < <(sort "$RUN_DIR/results")
    exit $RC

# --- Android (effort 4) --------------------------------------------------------

# Android toolchain locations (docs/developing.md § Android — override via env)
android_home := env_var_or_default('ANDROID_HOME', home_directory() / '.local' / 'share' / 'android-sdk')
java_home    := env_var_or_default('JAVA_HOME', home_directory() / '.local' / 'share' / 'jdk')
# The emulator's own window hard-froze a COSMIC/hybrid-GPU Linux host
# (2026-09-14, cosmic-comp texture import) — on Linux the emulator boots
# headless and scrcpy is the screen (see android-scrcpy); other OSes keep
# the window. TT_EMULATOR_WINDOWED=1 overrides either way.
android_headless_default := if os() == 'linux' { '1' } else { '0' }

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
    # Payload check, not dir check: a warm rust-cache restore can bring back
    # a hollow prebuilt tree (fingerprints + dirs, no .so payload) while the
    # cached build-script output still injects the -L — the relink then
    # dangles (the 2026-09 CI trap). Any missing .so → clean re-extract.
    if ! { [ -f "$SHERPA/$STEM/jniLibs/arm64-v8a/libsherpa-onnx-c-api.so" ] &&
           [ -f "$SHERPA/$STEM/jniLibs/arm64-v8a/libonnxruntime.so" ] &&
           [ -f "$SHERPA/$STEM/jniLibs/x86_64/libsherpa-onnx-c-api.so" ] &&
           [ -f "$SHERPA/$STEM/jniLibs/x86_64/libonnxruntime.so" ]; }; then
        rm -rf "$SHERPA/$STEM"
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
    @cargo build -p taletrek-ffi --lib
    @uniffi-bindgen generate --library target/debug/libtaletrek_ffi.so --language kotlin \
        --config crates/ffi/uniffi.toml --no-format --out-dir android/app/src/main/java

# One-time setup for a fresh machine (Linux or macOS): JDK 21 + Android SDK/
# NDK + Rust android targets + cargo tools + emulator + AVD + the scrcpy
# mirror stack. Idempotent, converges, installs everything user-local; the
# few sudo actions (KVM group, snap connect) are printed as exact commands —
# re-run until the summary says ready. Manual detail/fallback: docs/developing.md
# § Android. Emulator-only subset: just android-emulator-setup.
android-setup:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} bash scripts/setup-android.sh

# One-time: emulator + system image + `taletrek` AVD (idempotent; ~1.5 GB download)
android-emulator-setup:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} bash scripts/setup-android-emulator.sh

# The daily dev command (dev-web's counterpart): build the debug APK, make
# sure a headless emulator is up (cold-boot only if none), reinstall, and
# force-stop + relaunch TaleTrek — then open the scrcpy mirror as the screen
# (the emulator itself stays windowless). App-level restart, no emulator reboot
android-serve-dev: android
    @just _android-serve fast

# Clean-slate variant: also stops any running emulator and cold-boots fresh
# (-no-snapshot — no quickboot resume) before reinstall + relaunch
android-serve-fresh: android
    @just _android-serve fresh

# The single-command dev loop: initial build + relaunch, then watch Android
# and kernel sources and rebuild + relaunch on every save (Ctrl-C to stop).
# Poll-based (find -newer, 1 s) so nothing extra must be installed; jniLibs
# and build/ are pruned or the build's own outputs would retrigger forever.
# Rust saves are covered via crates/ (cargo no-ops in ~seconds when only
# Kotlin changed); a failed build is reported and the loop keeps watching.
android-watch:
    #!/usr/bin/env bash
    set -euo pipefail
    STAMP="$(mktemp)"
    trap 'rm -f "$STAMP"' EXIT
    build() { just android-serve-dev; }
    echo "taletrek watch: initial build + relaunch — then watching android/app/src + crates (Ctrl-C to stop)"
    build || echo "taletrek watch: initial build failed — fix and save to retry"
    while true; do
        sleep 1
        CHANGED="$(find android/app/src crates \
            \( -name jniLibs -o -name build -o -name .gradle \) -prune \
            -o -type f -newer "$STAMP" -print -quit || true)"
        [ -n "$CHANGED" ] || continue
        touch "$STAMP"
        echo "── change: $CHANGED → rebuild + relaunch"
        build || echo "taletrek watch: build failed — fix and save to retry"
    done

# Workhorse behind the serve recipes; mode = fast | fresh. On Linux boot is
# HEADLESS by default — GOTCHA (2026-09-14, this host): the emulator's
# Qt/XWayland window wedges the whole COSMIC session on this hybrid
# Intel+NVIDIA box (cosmic-comp fails the window's texture import across DRM
# devices; the desktop hard-freezes the moment the window maps, before any
# app load — guest and app stay fully healthy). See the screen via `just
# android-scrcpy` instead. On other OSes the window is the default (no such
# compositor bug there); TT_EMULATOR_WINDOWED=1 overrides either way.
# GL is also software (swiftshader_indirect) — the default host-GL pipe
# renders a black window on hybrid-GPU hosts (guest fine, window dead);
# override via TT_EMULATOR_GPU.
_android-serve mode:
    #!/usr/bin/env bash
    set -euo pipefail
    EMU="{{android_home}}/emulator/emulator"
    ADB="{{android_home}}/platform-tools/adb"
    HEADLESS="{{android_headless_default}}"
    [ -n "${TT_EMULATOR_WINDOWED:-}" ] && HEADLESS=0
    [ -x "$EMU" ] || { echo "emulator not installed — run: just android-setup"; exit 1; }
    "$EMU" -list-avds | grep -qx taletrek || { echo "AVD 'taletrek' missing — run: just android-setup"; exit 1; }
    [ -e /dev/kvm ] || [ "$(uname -s)" != "Linux" ] || { echo "/dev/kvm missing — the emulator needs KVM on Linux"; exit 1; }
    running() { "$ADB" devices | grep -q '^emulator-'; }
    RUNNING_HEADLESS=0; pgrep -f 'qemu-system-.*-headless' >/dev/null && RUNNING_HEADLESS=1
    if running && { [ "{{mode}}" = "fresh" ] || [ "$RUNNING_HEADLESS" != "$HEADLESS" ]; }; then
        echo "emulator: stopping previous instance"
        "$ADB" emu kill || true
        for _ in $(seq 1 30); do running || break; sleep 1; done
        running && { echo "emulator: did not stop within 30s — run: just android-emulator-stop, then retry"; exit 1; }
    fi
    if ! running; then
        mkdir -p "{{cache_dir}}"
        WINDOW_FLAGS=""; [ "$HEADLESS" = 1 ] && WINDOW_FLAGS="-no-window"
        MODE_NOTE=windowed; [ "$HEADLESS" = 1 ] && MODE_NOTE=headless
        nohup "$EMU" -avd taletrek -no-snapshot $WINDOW_FLAGS \
            -gpu "${TT_EMULATOR_GPU:-swiftshader_indirect}" \
            > "{{cache_dir}}/emulator.log" 2>&1 &
        echo "emulator: cold-booting ($MODE_NOTE) — takes a minute or two (log: {{cache_dir}}/emulator.log)"
    fi
    "$ADB" wait-for-device
    for _ in $(seq 1 150); do
        [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] && break
        sleep 2
    done
    [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] \
        || { echo "emulator: boot timed out (5 min) — check the emulator log: {{cache_dir}}/emulator.log"; exit 1; }
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android installDebug
    "$ADB" shell am force-stop dev.l1br3.taletrek
    "$ADB" shell am start -n dev.l1br3.taletrek/.MainActivity
    # The headless boot's screen: open the scrcpy mirror once per session —
    # skipped while one is live so android-watch's rebuilds never stack
    # windows. Readiness has a single source (scripts/scrcpy-doctor.sh —
    # missing / too old / snap unwired); not-ready is a hint pointing at
    # `just android-scrcpy`, never a serve failure.
    if [ "$HEADLESS" = 1 ] && ! pgrep -x scrcpy >/dev/null; then
        if bash scripts/scrcpy-doctor.sh --quiet; then
            SERIAL="$("$ADB" devices | awk '/^emulator-.*device$/{print $1; exit}')"
            nohup scrcpy --serial "$SERIAL" --stay-awake \
                > "{{cache_dir}}/scrcpy.log" 2>&1 &
            echo "screen: scrcpy mirror opened (reopen after closing: just android-scrcpy)"
        else
            echo "screen: scrcpy not ready — run: just android-scrcpy for the exact fix"
        fi
    fi
    echo "taletrek: relaunched (fresh process) — emulator stays up (stop: just android-emulator-stop)"

# Push a file from your machine into the emulator's Download folder — then
# in TaleTrek tap Add and pick it from the Downloads root in the picker
android-push file:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    FILE="{{file}}"
    "$ADB" devices | grep -q '^emulator-' || { echo "no device — run: just android-serve-dev first"; exit 1; }
    "$ADB" push "$FILE" /sdcard/Download/
    "$ADB" shell content call --uri content://media/none/media_scanner \
        --method scan_volume --arg external_primary >/dev/null 2>&1 || true
    echo "pushed: $FILE — in the app tap Add, then pick Downloads in the picker"

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
    echo "fixtures: /sdcard/Download — in the app tap Add, then pick Downloads in the picker"

# Shut every running emulator down cleanly (adb emu kill per instance)
android-emulator-stop:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    SERIALS="$("$ADB" devices | awk '/^emulator-.*device$/{print $1}')"
    if [ -z "$SERIALS" ]; then echo "emulator: not running"; exit 0; fi
    for S in $SERIALS; do "$ADB" -s "$S" emu kill && echo "emulator: stopped $S"; done
    for _ in $(seq 1 30); do "$ADB" devices | grep -q '^emulator-.*device$' || break; sleep 1; done
    "$ADB" devices | grep -q '^emulator-.*device$' \
        && { echo "emulator: some instance did not stop within 30s"; exit 1; } \
        || true

# Boot BOTH emulator instances for the sharded instrumented matrix: taletrek
# on :5554 + taletrek2 on :5556 (created if missing — same image, no new
# downloads), headless, cold, -dns-server per G31. Idempotent — already-up
# instances are reused. ~2-3 GB extra RAM. Stop all: android-emulator-stop.
android-emulators-up:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} bash scripts/emulators-up.sh

# Reopen the headless emulator's screen mirror by hand (scrcpy) — the serve
# recipes open one automatically; this is for after you've closed it. The
# emulator's own window stays off this hybrid-GPU COSMIC host (it is what
# hard-froze the desktop); scrcpy's simple client surface composes fine, and
# on >= 2.0 audio rides along, so playback testing still has sound. Every
# readiness failure mode (missing / too old / snap unwired) is diagnosed by
# scripts/scrcpy-doctor.sh with its exact fix printed.
android-scrcpy:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    bash scripts/scrcpy-doctor.sh
    SERIAL="$("$ADB" devices | awk '/^emulator-.*device$/{print $1; exit}')"
    [ -n "$SERIAL" ] || { echo "no device — run: just android-serve-dev first"; exit 1; }
    exec scrcpy --serial "$SERIAL" --stay-awake

# Build debug APK (kernel + gradle assembleDebug)
android: android-kernel
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android assembleDebug

# Kotlin JVM unit tests + ktlint (gradlew testDebugUnitTest — pure-Kotlin only;
# the .so does not load on the JVM — instrumented is where kernel code runs)
android-test:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android testDebugUnitTest ktlintCheck

# Scoped Kotlin JVM dev loop: --tests filter (glob or FQCN, quoted), ktlint
# still gates. Convenience only — never replaces the full android-test gate.
android-test-class filter:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android testDebugUnitTest --tests "{{filter}}" ktlintCheck

# Instrumented matrix on connected devices (kernel round-trip, Compose UI).
# With ≥2 devices up (just android-emulators-up) the matrix SHARDS: one
# gradle build+install pass, then two parallel `am instrument` runs — one per
# device — over class halves balanced by measured per-class time. Why hand-
# rolled: AGP's multi-device connectedDebugAndroidTest DUPLICATES the full
# suite on every device (measured 42/42 on both, wall ≈ single-device
# serial), and its -Pandroid.testInstrumentationRunnerArguments.class mangles
# comma lists (runs only the first class; raw am instrument handles them
# fine) — details in the fast-test-loops effort record (git log --grep
# fast-test-loops). Classes
# discovered in the source tree but unknown to the halves are appended to the
# lighter half (printed), and the run fails unless the halves' combined test
# count equals the source's @Test total — the sharded gate can never
# silently drop a suite. One device → the plain full gradle run, unchanged.
android-instrumented:
    #!/usr/bin/env bash
    set -euo pipefail
    ADB="{{android_home}}/platform-tools/adb"
    DEVS="$(mktemp)"; trap 'rm -f "$DEVS"' EXIT
    "$ADB" devices | awk '/^emulator-.*device$/{print $1}' > "$DEVS"
    if [ "$(wc -l < "$DEVS")" -lt 2 ]; then
        exec env JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} \
            android/gradlew --project-dir android connectedDebugAndroidTest
    fi
    D1="$(sed -n 1p "$DEVS")"; D2="$(sed -n 2p "$DEVS")"
    # Balanced halves (baseline per-class seconds in parentheses), A ≈ 108s / B ≈ 110s:
    HALF_A="CorruptWalkTest(4) ExportTest(12) FillStatesTest(42) ImportScanTest(0.1) PlaybackWalkTest(6) ProgressiveListenTest(18) ReaderSyncTest(2) SourceImportMatrixTest(24)"
    HALF_B="FfiSmokeTest(0) FirstRunTest(14) HardeningTest(17) PerfDatapointsTest(6) PositionStoreTest(0) ProgressiveResumeTest(38) ReaderScreenTest(11) RestoreFlowTest(0) SynthServiceSmokeTest(1) VoiceFlowTest(23)"
    names() { for w in $1; do echo "${w%%(*}"; done; }
    A="$(names "$HALF_A")"; B="$(names "$HALF_B")"
    SRC=android/app/src/androidTest/java/dev/l1br3/taletrek
    for f in "$SRC"/*Test.kt; do
        n="$(basename "$f" .kt)"
        grep -qx "$n" <<<"$A" || grep -qx "$n" <<<"$B" || {
            if [ "$(grep -c . <<<"$B")" -le "$(grep -c . <<<"$A")" ]; then B="$B $n"; else A="$A $n"; fi
            echo "shard: new class $n not in the balanced halves — appended to the lighter half (rebalance in the justfile when convenient)"
        }
    done
    join_fqcn() { local out=""; for n in $1; do out+=",dev.l1br3.taletrek.$n"; done; echo "${out#,}"; }
    # Expected total = every @Test in the source tree — the halves must sum to it
    EXPECTED=$(grep -ho '@Test' "$SRC"/*Test.kt | wc -l)
    # Build + install both APKs on every attached device in one gradle pass
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} \
        android/gradlew --project-dir android installDebug installDebugAndroidTest >/dev/null
    run_half() {  # $1 = serial, $2 = comma FQCNs → /tmp/taletrek-instrumented-<serial>.count
        local T0=$SECONDS OUT="/tmp/taletrek-instrumented-$1.log"
        if timeout 1800 "$ADB" -s "$1" shell am instrument -w -e class "$2" \
            dev.l1br3.taletrek.test/androidx.test.runner.AndroidJUnitRunner > "$OUT" 2>&1 \
            && grep -q '^OK (' "$OUT"; then
            echo "$(grep -oE '\([0-9]+ tests?\)' "$OUT" | grep -oE '[0-9]+' | head -1) tests in $((SECONDS-T0))s"
        else
            echo FAIL
        fi > "/tmp/taletrek-instrumented-$1.count"
    }
    echo "shard: $D1 ← $(echo $A | tr ' ' ',')  |  $D2 ← $(echo $B | tr ' ' ',')"
    T0=$SECONDS
    run_half "$D1" "$(join_fqcn "$A")" & P1=$!
    run_half "$D2" "$(join_fqcn "$B")" & P2=$!
    wait "$P1" || true; wait "$P2" || true
    C1="$(cat "/tmp/taletrek-instrumented-$D1.count")"; C2="$(cat "/tmp/taletrek-instrumented-$D2.count")"
    RC=0
    [ "$C1" = FAIL ] && { RC=1; echo "shard: FAILED on $D1 — tail of /tmp/taletrek-instrumented-$D1.log:"; tail -25 "/tmp/taletrek-instrumented-$D1.log"; }
    [ "$C2" = FAIL ] && { RC=1; echo "shard: FAILED on $D2 — tail of /tmp/taletrek-instrumented-$D2.log:"; tail -25 "/tmp/taletrek-instrumented-$D2.log"; }
    N1=0; [ "$C1" != FAIL ] && N1="${C1%% *}"
    N2=0; [ "$C2" != FAIL ] && N2="${C2%% *}"
    N1="${N1:-0}"; N2="${N2:-0}"
    TOTAL=$((N1 + N2))
    echo "shard: $D1 ran $C1  |  $D2 ran $C2"
    echo "shard: $TOTAL/$EXPECTED tests in $((SECONDS-T0))s (expected $EXPECTED)"
    [ "$TOTAL" = "$EXPECTED" ] || { echo "shard: test count mismatch — a suite may have been dropped"; RC=1; }
    exit $RC

# Scoped instrumented dev loop: one test class (FQCN) on one device — for
# iterating on a failing suite without paying the whole matrix. Targets every
# connected device; set ANDROID_SERIAL=emulator-XXXX to pin one. Convenience
# only — never replaces the full android-instrumented gate.
android-instrumented-class cls:
    @JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class={{cls}}

# ---- iOS (ios-app) ------------------------------------------------------------

# Host cdylib extension: Linux names it .so, macOS .dylib — the bindgen
# reads the proc-macro metadata back out of whichever host built it.
host_dylib := "libtaletrek_ffi." + if os() == "macos" { "dylib" } else { "so" }

# Regenerate the checked-in UniFFI Swift bindings for crates/ffi under
# ios/TaleTrek/FFI (ios-app task 002). Same mechanics as android-bindings —
# the host-built cdylib carries the metadata — with `--language swift`.
# Xcode never invokes Cargo (the Gradle-never-invokes-Cargo doctrine,
# transposed); compile validation is the Xcode project's (task 003).
# The modulemap rename is load-bearing: clang auto-discovers only
# `module.modulemap` in SWIFT_INCLUDE_PATHS dirs — the generated
# `<module>FFI.modulemap` name is invisible to `import` (the CI trap).
# One-time prerequisite: cargo install uniffi --features cli --version 0.32.0 --locked
ios-bindings:
    @cargo build -p taletrek-ffi --lib
    @uniffi-bindgen generate --library target/debug/{{host_dylib}} --language swift \
        --config crates/ffi/uniffi.toml --no-format --out-dir ios/TaleTrek/FFI
    @mv ios/TaleTrek/FFI/taletrek_ffiFFI.modulemap ios/TaleTrek/FFI/module.modulemap

# iOS kernel static libs (device + simulator) + the sherpa xcframework, into
# ios/TaleTrek/Vendor/ (gitignored — populated per machine, like jniLibs).
# TRAP LEDGER (extend here as the Mac session finds them, android-T1 style):
# - sherpa-onnx-sys on iOS forces SHARED mode and auto-downloads
#   sherpa-onnx-v<ver>-ios-shared-onnxruntime-static.xcframework.zip from the
#   `xcframework` release tag into target/sherpa-onnx-prebuilt/; onnxruntime
#   is statically INSIDE the SherpaOnnxC dylib (no separate onnxruntime to
#   link); it wires lib/ (device) vs lib-sim/ (sim) symlink dirs itself.
# - `--crate-type staticlib` drops rustc link directives: the app supplies
#   -ltaletrek_ffi -lc++ and embeds the framework (pbxproj settings).
# - libopus (the `opus` crate) cross-builds via cmake; the cmake crate maps
#   Apple triples — unverified on a real Mac until task 003's run.
# - Payload check, not dir check (the android 2026-09 trap, iOS edition): a
#   warm rust-cache restore can bring back a hollow prebuilt tree (dirs +
#   fingerprints, no dylib payload) while the cached build-script output
#   keeps the sys crate from re-extracting (`lib/` dir exists → short-
#   circuit) — the Vendor copy then ships a shell Xcode rejects with "no
#   Info.plist found". Any missing payload → clean re-extract from the
#   cached zip (download-free when rust-cache kept the ~200 MB zip).
ios-kernel:
    #!/usr/bin/env bash
    set -euo pipefail
    PREBUILT=target/sherpa-onnx-prebuilt
    STEM="sherpa-onnx-v{{sherpa_ver}}-ios-shared-onnxruntime-static"
    XCF="$PREBUILT/$STEM/SherpaOnnxC.xcframework"
    if ! { [ -f "$XCF/Info.plist" ] && find "$XCF" -name '*.dylib' -print -quit | grep -q .; }; then
        rm -rf "$PREBUILT/$STEM"
        mkdir -p "$PREBUILT/$STEM"
        if [ ! -f "$PREBUILT/$STEM.xcframework.zip" ]; then
            curl -fL -o "$PREBUILT/$STEM.xcframework.zip" \
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/xcframework/$STEM.xcframework.zip"
        fi
        unzip -q "$PREBUILT/$STEM.xcframework.zip" -d "$PREBUILT/$STEM"
    fi
    for t in aarch64-apple-ios aarch64-apple-ios-sim; do
        cargo rustc -p taletrek-ffi --lib --crate-type staticlib --release --target "$t"
    done
    VENDOR=ios/TaleTrek/Vendor
    mkdir -p "$VENDOR/iphoneos" "$VENDOR/iphonesimulator"
    cp target/aarch64-apple-ios/release/libtaletrek_ffi.a "$VENDOR/iphoneos/"
    cp target/aarch64-apple-ios-sim/release/libtaletrek_ffi.a "$VENDOR/iphonesimulator/"
    rm -rf "$VENDOR/SherpaOnnxC.xcframework"
    cp -R "$XCF" "$VENDOR/"

# Simulator destination for ios/ios-test (override: IOS_SIM_DEST='platform=iOS Simulator,name=iPhone 18 Pro')
ios_sim_dest := env_var_or_default('IOS_SIM_DEST', 'platform=iOS Simulator,name=iPhone 18 Pro')

# Kernel + xcodebuild build (simulator)
ios: ios-kernel
    @xcodebuild -project ios/TaleTrek.xcodeproj -scheme TaleTrek \
        -destination 'generic/platform=iOS Simulator' build

# Swift unit tests on the simulator (app-hosted — the kernel rides the app binary).
# TEST_RUNNER_TALETREK_FRESH_RUN=1 additionally runs the CDN-touching FirstRunTest
# (Mac-local; the TEST_RUNNER_ prefix is xcodebuild's pass-through — plain env
# vars never cross into the simulator's app process).
ios-test: ios-kernel
    @xcodebuild -project ios/TaleTrek.xcodeproj -scheme TaleTrek \
        -destination '{{ios_sim_dest}}' test

# XCUITest integration suites on the simulator (reader/library UI over the real kernel).
ios-ui-test: ios-kernel
    @xcodebuild -project ios/TaleTrek.xcodeproj -scheme TaleTrek \
        -destination '{{ios_sim_dest}}' -only-testing:TaleTrekUITests test

# Build for a connected iPhone (dev signing): needs IOS_DEVICE_ID (xcrun devicectl
# list devices) + DEVELOPMENT_TEAM; then install:
#   xcrun devicectl device install app --device "$IOS_DEVICE_ID" <product path>
ios-install:
    @xcodebuild -project ios/TaleTrek.xcodeproj -scheme TaleTrek \
        -destination "platform=iOS,id=${IOS_DEVICE_ID:?set IOS_DEVICE_ID}" \
        DEVELOPMENT_TEAM="${DEVELOPMENT_TEAM:?set DEVELOPMENT_TEAM}" build
