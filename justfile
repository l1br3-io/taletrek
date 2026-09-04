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
