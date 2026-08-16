#!/usr/bin/env bash
# Sets up the native deps for local development of desktop/ + server/:
#   piper (rhasspy TTS)  → ~/.cache/taletrek/piper/
#   default voice model  → ~/.cache/taletrek/voices/   (same dir the apps' curated auto-download uses)
#   ffmpeg               → checked only (install via your package manager if missing)
#
# Idempotent — safe to re-run; skips anything already present.
# Usage: bash scripts/setup-native.sh
set -euo pipefail

CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/taletrek"
PIPER_DIR="$CACHE/piper"
VOICES_DIR="$CACHE/voices"
VOICE=en_US-hfc_female-medium
VOICE_BASE=https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium

case "$(uname -m)" in
  x86_64) PIPER_TARBALL=piper_linux_x86_64.tar.gz ;;
  aarch64) PIPER_TARBALL=piper_linux_aarch64.tar.gz ;;
  *) echo "unsupported arch: $(uname -m) (piper releases ship x86_64 + aarch64 only)"; exit 1 ;;
esac
PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/$PIPER_TARBALL"

if "$PIPER_DIR/piper" --help >/dev/null 2>&1; then
  echo "piper: already installed at $PIPER_DIR/piper"
else
  echo "piper: downloading $PIPER_URL"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/$PIPER_TARBALL" "$PIPER_URL"
  mkdir -p "$PIPER_DIR"
  tar -xzf "$tmp/$PIPER_TARBALL" -C "$tmp"
  # tarball top-level dir is `piper/` — its RUNPATH=$ORIGIN needs siblings, so move the dir intact
  rm -rf "$PIPER_DIR"
  mv "$tmp/piper" "$PIPER_DIR"
  "$PIPER_DIR/piper" --help >/dev/null
  echo "piper: installed → $PIPER_DIR/piper"
fi

if [[ -f "$VOICES_DIR/$VOICE.onnx" && -f "$VOICES_DIR/$VOICE.json" ]]; then
  echo "voice:  $VOICE already in $VOICES_DIR"
else
  echo "voice:  downloading $VOICE (.onnx + .onnx.json → cached as .json)"
  mkdir -p "$VOICES_DIR"
  curl -fsSL -o "$VOICES_DIR/$VOICE.onnx" "$VOICE_BASE/$VOICE.onnx"
  curl -fsSL -o "$VOICES_DIR/$VOICE.json" "$VOICE_BASE/$VOICE.onnx.json"
  echo "voice:  installed → $VOICES_DIR/$VOICE.onnx"
fi

if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version 2>/dev/null | grep -qi libopus; then
  echo "ffmpeg: OK ($(ffmpeg -version | head -1 | cut -d' ' -f3), libopus enabled)"
else
  echo "ffmpeg: MISSING or built without libopus — install it, e.g.: sudo apt-get install -y ffmpeg"
fi

cat <<EOF

Done. To use the local piper + pre-seeded voice, export:

  export PATH="$PIPER_DIR:\$PATH"
  export TALETREK_VOICE_PATH="$VOICES_DIR/$VOICE.onnx"   # only needed for the #[ignore]d e2e tests

The desktop and server find piper on PATH by default; first synth now hits the
pre-seeded voice cache (no download).
EOF
