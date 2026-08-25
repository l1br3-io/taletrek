# TaleTrek dev tasks — `just` with no args lists everything.
# Native deps (piper + seeded voice) come from `just setup`; everything that
# needs them resolves the same ~/.cache/taletrek layout, env-overridable.

cache_dir   := env_var_or_default('XDG_CACHE_HOME', home_directory() / '.cache') / 'taletrek'
piper_bin   := env_var_or_default('PIPER_BIN', cache_dir / 'piper' / 'piper')
voice_onnx  := env_var_or_default('VOICE_PATH', cache_dir / 'voices' / 'en_US-hfc_female-medium.onnx')
server_token := env_var_or_default('TALETREK_TOKEN', 'dev-secret')

default:
    @just --list

# One-time setup: workspace deps + native piper/voice into ~/.cache/taletrek
setup:
    pnpm install
    pnpm setup:native

# SPA dev server → http://localhost:8253 (unique port; strict — no silent hopping)
dev-web:
    @echo "→ TaleTrek SPA: http://localhost:8253"
    pnpm dev

# Personal server (debug build) → http://127.0.0.1:7878 — token: dev-secret (TALETREK_TOKEN to override).
# Binds loopback explicitly: the binary's default is 0.0.0.0 (Docker needs it);
# a dev token must never answer the LAN. Serves the SPA at / from web/dist
# when it's built (pnpm build) — missing dist just logs a warning.
dev-server:
    @echo "→ TaleTrek server: http://127.0.0.1:7878  (UI login / bearer token: {{server_token}})"
    @echo "  health check: curl -fsS http://127.0.0.1:7878/api/health"
    TALETREK_BIND=127.0.0.1:7878 TALETREK_TOKEN={{server_token}} TALETREK_PIPER={{piper_bin}} TALETREK_STATIC_DIR=web/dist cargo run -p taletrek-server

# Desktop: synth a text-only bundle → full Opus bundle (voice auto-resolves from the seeded cache)
synth INPUT OUTPUT:
    cargo run -p taletrek-desktop -- synth --piper {{piper_bin}} --input {{INPUT}} --output {{OUTPUT}}

# Desktop: re-voice an existing full bundle
resynth INPUT VOICE OUTPUT:
    cargo run -p taletrek-desktop -- resynth --piper {{piper_bin}} --input {{INPUT}} --voice {{VOICE}} --output {{OUTPUT}}

# Convenience: synth the committed fixture → /tmp/book.synth.taletrek
synth-fixture:
    @just synth crates/synth/tests/fixtures/book-text-only.taletrek /tmp/book.synth.taletrek

# Personal server via Docker → http://127.0.0.1:7878 (token: dev-secret; data in tt-data volume).
# The port maps to loopback only — publish to the LAN deliberately (-p 7878:7878) with a real token.
docker-server:
    @echo "→ building taletrek-server image…"
    docker build -f server/Dockerfile -t taletrek-server .
    @echo "→ TaleTrek server (Docker): http://127.0.0.1:7878  (UI login / bearer token: {{server_token}})"
    docker run --rm -it -p 127.0.0.1:7878:7878 -e TALETREK_TOKEN={{server_token}} -v tt-data:/data taletrek-server

# SPA tests (vitest)
test-web:
    pnpm test

# Rust workspace tests (hermetic — no piper/ffmpeg)
test-rust:
    cargo test --workspace

# Real-piper/ffmpeg e2e (the #[ignore]d tests) — gate env pre-wired to the setup cache
test-e2e:
    TALETREK_PIPER_BIN={{piper_bin}} TALETREK_VOICE_PATH={{voice_onnx}} cargo test --workspace -- --ignored --nocapture

# SPA gates: lint + typecheck + test + build
verify:
    pnpm verify

# Rust gates: clippy -D warnings + tests
verify-rust:
    cargo clippy --workspace --all-targets -- -D warnings
    cargo test --workspace
