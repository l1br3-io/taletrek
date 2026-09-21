#!/usr/bin/env bash
# Boot TWO emulator instances for the sharded instrumented matrix (fast-test-loops).
#
#   instance 1 → AVD `taletrek`  on -port 5554 (the everyday dev AVD)
#   instance 2 → AVD `taletrek2` on -port 5556 (created here if missing —
#                same system image, so zero new downloads; a second AVD is
#                required because the emulator locks an AVD to one instance)
#
# Both boot HEADLESS, cold (-no-snapshot), with an explicit resolver
# (-dns-server — G31: the headless AVD sometimes boots with an empty resolver
# and every CDN-dependent instrumented suite fails on hostname lookup) on
# software GL (the hybrid-GPU host trap; override via TT_EMULATOR_GPU).
# Idempotent: an already-booted instance is reused, only missing ones boot.
# Stop everything with: just android-emulator-stop
#
# Usage: just android-emulators-up   (or: bash scripts/emulators-up.sh)
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/jdk}"
EMU="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"
AVDMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager"
IMAGE="system-images;android-36;google_apis;x86_64"
GPU="${TT_EMULATOR_GPU:-swiftshader_indirect}"
DNS="-dns-server 8.8.8.8,1.1.1.1"

[ -x "$EMU" ] || { echo "emulator: MISSING at $EMU — run: just android-setup"; exit 1; }
[ -e /dev/kvm ] || [ "$(uname -s)" != "Linux" ] || { echo "/dev/kvm missing — the emulator needs KVM on Linux"; exit 1; }

booted() { "$ADB" devices | awk -v s="$1" '$1 == s && $2 == "device" {found=1} END {exit !found}'; }

wait_ready() {  # $1 = serial, $2 = label
    local T0=$SECONDS
    "$ADB" -s "$1" wait-for-device
    for _ in $(seq 1 150); do
        [ "$("$ADB" -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] && break
        sleep 2
    done
    [ "$("$ADB" -s "$1" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')" = "1" ] \
        || { echo "$2: boot timed out (5 min) — check ${XDG_CACHE_HOME:-$HOME/.cache}/taletrek/emulator-$1.log"; exit 1; }
    echo "$2: ready in $((SECONDS-T0))s ($1)"
    # G31 sanity — the resolver can take a few seconds after boot_completed;
    # only warn if it never comes up (CDN suites would fail for real)
    for _ in $(seq 1 5); do
        "$ADB" -s "$1" shell ping -c1 -W2 huggingface.co >/dev/null 2>&1 && break
        sleep 2
    done
    "$ADB" -s "$1" shell ping -c1 -W2 huggingface.co >/dev/null 2>&1 \
        || echo "$2: WARNING — hostname lookup failed (G31); CDN-dependent suites will fail"
}

# Second AVD (only if missing) — same image, so this is seconds, not a download
if [ ! -f "$HOME/.android/avd/taletrek2.ini" ]; then
    [ -x "$AVDMANAGER" ] || { echo "avdmanager: MISSING — run: just android-emulator-setup"; exit 1; }
    echo "avd:     creating taletrek2 (pixel_6, same system image as taletrek)"
    echo no | JAVA_HOME="$JAVA_HOME" "$AVDMANAGER" create avd -n taletrek2 -k "$IMAGE" --device pixel_6
else
    echo "avd:     taletrek2 already exists"
fi

mkdir -p "${XDG_CACHE_HOME:-$HOME/.cache}/taletrek"
T0=$SECONDS
for spec in "taletrek 5554" "taletrek2 5556"; do
    read -r AVD PORT <<<"$spec"
    SERIAL="emulator-$PORT"
    if booted "$SERIAL"; then
        echo "$AVD:    already running ($SERIAL)"
        continue
    fi
    echo "$AVD:    cold-booting headless on $SERIAL — takes a minute or two"
    nohup "$EMU" -avd "$AVD" -port "$PORT" -no-window -no-snapshot $DNS -gpu "$GPU" \
        > "${XDG_CACHE_HOME:-$HOME/.cache}/taletrek/emulator-$SERIAL.log" 2>&1 &
done
wait_ready emulator-5554 taletrek
wait_ready emulator-5556 taletrek2

echo "emulators: both up in $((SECONDS-T0))s — stop with: just android-emulator-stop"
