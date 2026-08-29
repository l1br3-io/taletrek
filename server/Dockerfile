# syntax=docker/dockerfile:1
#
# taletrek-server — multi-stage Docker image.
#
#   Builder : rust:1.97.0-bookworm — compiles `taletrek-server --release --locked`
#   Spa     : node:24-slim         — pnpm 10.31 builds `web/dist` (the hosted PWA)
#   Piper   : debian:12-slim       — downloads the official rhasspy/piper tarball
#   Runtime : debian:12-slim       — ffmpeg + the server binary + piper + the SPA
#
# Why debian (glibc), not alpine (musl): Piper is built against glibc and links
# libonnxruntime / libespeak-ng / libpiper_phonemize via `$ORIGIN`. A musl image
# cannot run it without a fragile compat layer. debian-slim keeps the runtime
# small while remaining glibc-compatible. (ADR-0013 risk note.)
#
# Why piper is downloaded, not `apt install piper`: Debian's `piper` package is
# the libratbag *mouse-configuration GUI*, not rhasspy's TTS. The TTS binary
# ships only via GitHub releases, so we fetch the archived final release
# (2023.11.14-2) and extract it intact to /opt/piper (the binary's `RUNPATH` is
# `$ORIGIN`, so it finds its sibling `.so` files + the bundled `espeak-ng-data/`
# without any `LD_LIBRARY_PATH`). See `runbook.md` § Prerequisites.
#
# Voice MODELS are intentionally NOT baked in: the server downloads them on
# first synth into `$TALETREK_VOICES_CACHE_DIR` (default `/data/voices`, i.e. on
# the data volume) via `crates/worker::voices` — same HF + XDG-cache path the
# desktop app uses.

# ---------------------------------------------------------------------------
# Stage 1 — builder: compile the release binary.
# ---------------------------------------------------------------------------
FROM rust:1.97.0-bookworm AS builder

# The workspace pins the exact toolchain via rust-toolchain.toml (copied below);
# the rust:1.97.0 base already matches, and `--locked` enforces Cargo.lock.
WORKDIR /build

# Cache layer 1: manifests + lockfile → `cargo fetch` downloads the dependency
# graph into an image layer. Invalidated only when Cargo.lock changes, so an
# iterative rebuild (a one-line source edit) skips re-fetching the registry.
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY crates/synth/Cargo.toml crates/synth/Cargo.toml
COPY crates/worker/Cargo.toml crates/worker/Cargo.toml
COPY desktop/Cargo.toml desktop/Cargo.toml
COPY server/Cargo.toml server/Cargo.toml
COPY server/askama.toml server/askama.toml
RUN cargo fetch --locked

# Cache layer 2: the actual sources, copied member-by-member. Copying the
# whole context (`COPY . .`) would tie this layer to web/ + docs/ too (they
# ride along since the spa stage needs them in the context), so every SPA
# edit would recompile the Rust workspace. Explicit members keep the Rust
# cache keyed on Rust sources only.
COPY crates crates
COPY desktop desktop
COPY server server
RUN cargo build --release --locked -p taletrek-server

# ---------------------------------------------------------------------------
# Stage 2 — piper: fetch the official rhasspy/piper tarball into /opt/piper.
# ---------------------------------------------------------------------------
FROM debian:12-slim AS piper

# Pinned to the final release of the (now-archived) rhasspy/piper repo, so this
# URL is immutable. The tarball's sha256 is pinned below and verified after
# download — TLS protects the transport, the hash protects the payload (a
# compromise or takeover of the repo must not become native code in the image).
# Bump PIPER_VERSION + PIPER_SHA256 together, after vetting a fork
# (e.g. dharmab/piper).
ARG PIPER_VERSION=2023.11.14-2
ARG PIPER_TARBALL=piper_linux_x86_64.tar.gz
ARG PIPER_SHA256=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL -o /tmp/piper.tar.gz \
        "https://github.com/rhasspy/piper/releases/download/${PIPER_VERSION}/${PIPER_TARBALL}" \
    && echo "${PIPER_SHA256}  /tmp/piper.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/piper.tar.gz -C /opt \
    && rm /tmp/piper.tar.gz \
    && test -x /opt/piper/piper

# ---------------------------------------------------------------------------
# Stage 3 — spa: build the PWA (`web/dist`) with the workspace-pinned pnpm.
# ---------------------------------------------------------------------------
# The image is the full stack: API + login + the SPA served at `/` (T18).
# Node 24 matches the dev toolchain; corepack resolves pnpm exactly from the
# root `packageManager` field (10.31.0), so container builds never drift from
# local ones. Only `web/` is built: `--filter @taletrek/web...` skips the
# throwaway spikes' deps (~100 MB), but their manifests are still COPYied —
# `--frozen-lockfile` validates every workspace importer in pnpm-lock.yaml.
FROM node:24-slim AS spa

# corepack ships with node:24; kill its interactive first-download prompt so
# the initial `pnpm` call resolves silently in CI.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm

WORKDIR /spa

# Cache layer 1: workspace manifests + lockfile → install. Invalidated only
# when a manifest or pnpm-lock.yaml changes, so an iterative SPA edit skips
# re-downloading node_modules. `web/scripts` rides along because the root
# postinstall (`mirror-wasm.mjs`) runs inside install — it copies the pinned
# ORT wasm out of node_modules and downloads the Piper phonemize artifacts
# into web/public/wasm/ (CDN-free inference bytes). A network failure there
# only warns: hosted mode never runs on-device TTS, so the image stays
# functional; a rebuild when online fills the gap. Dependency lifecycle
# scripts stay blocked (pnpm 10 default, same as local dev).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/package.json
COPY web/scripts web/scripts
COPY spike/piper/package.json spike/piper/package.json
COPY spike/web-audio/package.json spike/web-audio/package.json
RUN pnpm --filter @taletrek/web... install --frozen-lockfile

# Cache layer 2: SPA sources → tsc --noEmit + vite build → web/dist.
COPY tsconfig.base.json ./
COPY web web
RUN pnpm --filter @taletrek/web build

# ---------------------------------------------------------------------------
# Stage 4 — runtime: ffmpeg + ca-certificates + the binary + piper + the SPA.
# ---------------------------------------------------------------------------
FROM debian:12-slim AS runtime

# ffmpeg provides libopus (the encoder shells out to `ffmpeg -c:a libopus`);
# ca-certificates is required for the runtime HTTPS download of voice models
# from HuggingFace (crates/worker::voices → ureq TLS); curl powers the
# HEALTHCHECK probe. `--no-install-recommends` keeps the layer lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# The server binary (from the builder) + the piper tree (RUNPATH=$ORIGIN, so the
# whole directory must land together at /opt/piper) + the built SPA as static
# bytes (no Node in the final image — dist is just files).
COPY --from=builder /build/target/release/taletrek-server /usr/local/bin/taletrek-server
COPY --from=piper /opt/piper /opt/piper
COPY --from=spa /spa/web/dist /web-dist

# Non-root user: the server never needs root. UID 1000 (the conventional app
# uid; `-r` would clamp to the <999 system range and warn on the explicit uid),
# home under /data so the single data volume is the only thing it owns.
RUN useradd -m -u 1000 -d /data taletrek \
    && mkdir -p /data \
    && chown -R taletrek:taletrek /data
USER taletrek

# Defaults: bind all interfaces on 7878, store library + db + voice cache under
# /data (one volume). Piper is at its extracted path; ffmpeg resolves on PATH.
# The SPA is baked at /web-dist and served at `/` (T8 default path, made
# explicit so a stray WORKDIR can't move it).
ENV TALETREK_DATA_DIR=/data \
    TALETREK_BIND=0.0.0.0:7878 \
    TALETREK_VOICES_CACHE_DIR=/data/voices \
    TALETREK_PIPER=/opt/piper/piper \
    TALETREK_FFMPEG=ffmpeg \
    TALETREK_STATIC_DIR=/web-dist

EXPOSE 7878
VOLUME /data

# `TALETREK_TOKEN` is required (single-user bearer auth — ADR-0013); supply it
# at `docker run -e TALETREK_TOKEN=...`. Health is the only unauthed route, so
# the container boots + answers /api/health without the token.
HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7878/api/health || exit 1

CMD ["taletrek-server"]
