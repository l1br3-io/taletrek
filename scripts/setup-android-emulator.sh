#!/usr/bin/env bash
# One-time emulator setup for the Android player (android/):
#   emulator       → $ANDROID_HOME/emulator        (the QEMU-based runner)
#   system image   → $ANDROID_HOME/system-images   (android-36 google_apis x86_64 — any API ≥ 26 works, minSdk 26;
#                                                   the x86_64 kernel .so runs natively on it, no ARM translation)
#   AVD `taletrek` → ~/.android/avd/               (pixel_6 profile)
#
# Idempotent — safe to re-run; skips anything already present.
# Usage: just android-emulator-setup   (or: bash scripts/setup-android-emulator.sh)
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/jdk}"
export ANDROID_HOME
# sdkmanager/avdmanager are Java tools — prefer the repo-pinned JDK, fall back to PATH java
if [ -d "$JAVA_HOME" ]; then export JAVA_HOME; fi

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
IMAGE="system-images;android-36;google_apis;x86_64"
AVD=taletrek
IMG_DIR="$ANDROID_HOME/system-images/android-36/google_apis/x86_64"

if [ ! -x "$SDKMANAGER" ]; then
  echo "sdkmanager: MISSING at $SDKMANAGER — install cmdline-tools first (docs/developing.md § Android)"
  exit 1
fi
if ! { [ -d "$JAVA_HOME" ] && "$JAVA_HOME/bin/java" -version >/dev/null 2>&1; } && ! command -v java >/dev/null 2>&1; then
  echo "java: MISSING — sdkmanager/avdmanager need a JDK (docs/developing.md § Android)"
  exit 1
fi
if [ "$(uname)" = "Linux" ] && [ ! -e /dev/kvm ]; then
  echo "kvm:    WARNING — /dev/kvm missing; the emulator boots unusably slowly without it (install the kvm modules / add yourself to the kvm group)"
fi

if [ -x "$ANDROID_HOME/emulator/emulator" ] && [ -d "$IMG_DIR" ]; then
  echo "packages: emulator + $IMAGE already installed"
else
  echo "packages: installing emulator + $IMAGE (~1.5 GB download)"
  yes | "$SDKMANAGER" --licenses >/dev/null || true
  "$SDKMANAGER" "emulator" "$IMAGE"
fi

if [ -f "$HOME/.android/avd/$AVD.ini" ]; then
  echo "avd:     $AVD already exists (~/.android/avd/$AVD.ini)"
else
  echo "avd:     creating $AVD (pixel_6 profile)"
  echo no | "$AVDMANAGER" create avd -n "$AVD" -k "$IMAGE" --device pixel_6
fi

cat <<EOF

Done. Run the app with:

  just android-serve-dev          # build APK -> boot emulator (headless on Linux; screen: just android-scrcpy) -> install -> launch TaleTrek
EOF
