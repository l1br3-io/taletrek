#!/usr/bin/env bash
# Fetch the shared espeak-ng-data dir (voice-independent) from the piper release.
# Run once before `cargo run --release`.
set -euo pipefail
cd "$(dirname "$0")"

if [ -d assets/espeak-ng-data ]; then
  echo "assets/espeak-ng-data already present"
else
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -sL "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz" -o "$tmp/piper.tar.gz"
  mkdir -p assets
  tar xzf "$tmp/piper.tar.gz" -C "$tmp"
  mv "$tmp"/piper/espeak-ng-data assets/espeak-ng-data
  echo "fetched $(du -sh assets/espeak-ng-data | cut -f1) of espeak-ng-data"
fi

# sherpa needs `sample_rate` ONNX metadata; k2-fsa's mirrors carry it. Pull the
# metadata-stamped copies of the two seeded voices (json stays in the voice cache).
for voice in en_US-hfc_female-medium en_US-ryan-medium; do
  if [ ! -f "assets/$voice.onnx" ]; then
    curl -sL "https://huggingface.co/csukuangfj/vits-piper-$voice/resolve/main/$voice.onnx" -o "assets/$voice.onnx"
  fi
done
echo "fetched metadata-stamped voice models"
