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
android-kernel:
    ANDROID_HOME={{android_home}} cargo ndk -t arm64-v8a -t x86_64 \
        -o android/app/src/main/jniLibs build -p taletrek-ffi --lib --release

# Regenerate the checked-in UniFFI Kotlin bindings for crates/ffi into the
# app's ffi package (task 002 consumes; Gradle never invokes Cargo).
# One-time prerequisite: cargo install uniffi --features cli --version 0.32.0 --locked
# (host cdylib carries the proc-macro metadata; Linux names it .so)
android-bindings:
    cargo build -p taletrek-ffi --lib
    uniffi-bindgen generate --library target/debug/libtaletrek_ffi.so --language kotlin \
        --config crates/ffi/uniffi.toml --no-format --out-dir android/app/src/main/java

# Build debug APK (kernel + gradle assembleDebug)
android: android-kernel
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android assembleDebug

# Install debug build on connected device/emulator
android-install: android
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android installDebug

# Kotlin JVM unit tests + ktlint (gradlew testDebugUnitTest — pure-Kotlin only;
# the .so does not load on the JVM — instrumented is where kernel code runs)
android-test:
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android testDebugUnitTest ktlintCheck

# Instrumented tests on connected device (kernel round-trip, Compose UI)
android-instrumented:
    JAVA_HOME={{java_home}} ANDROID_HOME={{android_home}} android/gradlew --project-dir android connectedDebugAndroidTest
