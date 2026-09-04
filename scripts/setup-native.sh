#!/usr/bin/env bash
# Sets up the native deps for local development of desktop/:
#   default voice model  → ~/.cache/taletrek/voices/   (the in-process engine's curated cache)
#   espeak-ng-data       → ~/.cache/taletrek/          (the in-process sherpa engine needs it at runtime)
#   piper (rhasspy TTS)  → ~/.cache/taletrek/piper/    (only for --piper overrides + e2e tests; espeak-ng-data is copied out of its tarball)
#   ffmpeg               → checked only (only for --ffmpeg overrides + e2e tests; install via your package manager if missing)
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

# espeak-ng-data for the in-process sherpa engine (feature `sherpa`): the
# piper tarball ships it next to the binary — copy it out once so
# SherpaRunner's default cache location is seeded. Never MOVE it: the piper
# binary needs it as a sibling at runtime.
if [ -d "$CACHE/espeak-ng-data" ]; then
  echo "espeak-ng-data: already present at $CACHE/espeak-ng-data"
elif [ -d "$PIPER_DIR/espeak-ng-data" ]; then
  cp -r "$PIPER_DIR/espeak-ng-data" "$CACHE/espeak-ng-data"
  echo "espeak-ng-data: copied from piper install → $CACHE/espeak-ng-data"
else
  echo "espeak-ng-data: MISSING (expected inside the piper install)"
fi

if command -v ffmpeg >/dev/null 2>&1 && ffmpeg -version 2>/dev/null | grep -qi libopus; then
  echo "ffmpeg: OK ($(ffmpeg -version | head -1 | cut -d' ' -f3), libopus enabled)"
else
  echo "ffmpeg: MISSING or built without libopus — install it, e.g.: sudo apt-get install -y ffmpeg"
fi

cat <<EOF

Done. The desktop synth/resynth default to the in-process engines (no external
binaries): they need the seeded voice + espeak-ng-data above, nothing else.

piper + ffmpeg are now OPTIONAL — only for the subprocess overrides and the
#[ignore]d e2e tests. To use them, export:

  export PATH="$PIPER_DIR:\$PATH"
  export TALETREK_VOICE_PATH="$VOICES_DIR/$VOICE.onnx"   # only needed for the #[ignore]d e2e tests

The #[ignore]d sherpa test finds espeak-ng-data at $CACHE/espeak-ng-data
(set TALETREK_ESPEAK_DATA to override; the CLI honors it too).
EOF
