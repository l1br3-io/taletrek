#!/usr/bin/env bash
# One-command Android dev environment (just android-setup): idempotent,
# converges, everything user-local — no sudo for anything it installs
# (JDK + SDK under ~/.local/share, matching the just recipes' JAVA_HOME /
# ANDROID_HOME defaults; cargo tools under ~/.cargo). The few actions that
# do need sudo (KVM group, snap connect) are printed as exact commands;
# re-run until the summary says ready. Linux + macOS; Windows is out of
# scope (the just recipes assume a unix shell).
#
# Steps: JDK 21 -> Android SDK (cmdline-tools + platform-tools + platform
# android-37 + build-tools 36.0.0 + NDK r28c) -> Rust android targets +
# cargo-ndk + uniffi-bindgen -> emulator + system image + AVD (existing
# setup-android-emulator.sh) -> KVM -> scrcpy mirror stack (Linux).
set -euo pipefail

OS="$(uname -s)"
case "$OS" in Linux | Darwin) ;; *) echo "unsupported OS: $OS" >&2; exit 1 ;; esac
ARCH="$(uname -m)"
case "$ARCH" in
    x86_64)            JARCH=x64 ;;
    aarch64 | arm64)   JARCH=aarch64 ;;
    *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/android-sdk}"
JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/jdk}"
PENDING=0
PENDING_CMDS=()
java_major() { "$1" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/'; }

# --- JDK 21 (Temurin) -------------------------------------------------------
# The just recipes pass JAVA_HOME=<pinned path> to gradlew, so that path must
# hold a JDK: reuse it if valid, else symlink to a system JDK >= 17, else
# download Temurin 21 (Adoptium's latest-21 redirect is a stable API).
if [ -x "$JAVA_HOME/bin/java" ] && [ "$(java_major "$JAVA_HOME/bin/java")" -ge 17 ] 2>/dev/null; then
    echo "jdk:    ok ($JAVA_HOME)"
elif command -v java >/dev/null 2>&1 && [ "$(java_major java)" -ge 17 ] 2>/dev/null; then
    SYS_HOME="$(java -XshowSettings:properties -version 2>&1 \
        | awk -F'= ' '/^ *java.home/ {print $2; exit}')"
    [ -n "$SYS_HOME" ] || { echo "jdk: could not resolve system java home" >&2; exit 1; }
    mkdir -p "$(dirname "$JAVA_HOME")"
    ln -sfn "$SYS_HOME" "$JAVA_HOME"
    echo "jdk:    ok (symlinked $JAVA_HOME -> $SYS_HOME)"
else
    case "$OS" in Linux) ADOPT_OS=linux ;; Darwin) ADOPT_OS=mac ;; esac
    echo "jdk:    downloading Temurin 21 ($ADOPT_OS/$JARCH) -> $JAVA_HOME"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fL -o "$TMP/jdk.tar.gz" \
        "https://api.adoptium.net/v3/binary/latest/21/ga/$ADOPT_OS/$JARCH/jdk/hotspot/normal/eclipse"
    tar xf "$TMP/jdk.tar.gz" -C "$TMP"
    mkdir -p "$(dirname "$JAVA_HOME")"
    mv "$TMP"/jdk-21* "$JAVA_HOME"
    "$JAVA_HOME/bin/java" -version
    trap - EXIT
    rm -rf "$TMP"
fi
export JAVA_HOME

# --- Android SDK + NDK ------------------------------------------------------
# cmdline-tools pin (per-OS build numbers, both verified live 2026-09-14 —
# Google keeps old repository artifacts alive, so the pin only rots forward).
# A tools release that predates the current repository XML cannot see newer
# packages (v19's parser choked on android-37), so readiness is checked
# FUNCTIONALLY: if this sdkmanager can't list android-37, upgrade it.
case "$OS" in
    Linux) CLT_OS=linux; CLT_VER=16111833 ;;
    Darwin) CLT_OS=mac; CLT_VER=15641748 ;;
esac
CLT_URL="https://dl.google.com/android/repository/commandlinetools-${CLT_OS}-${CLT_VER}_latest.zip"
install_clt() {
    echo "sdk:    downloading cmdline-tools ($CLT_VER)"
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    curl -fL -o "$TMP/clt.zip" "$CLT_URL"
    unzip -q "$TMP/clt.zip" -d "$TMP"
    mkdir -p "$ANDROID_HOME/cmdline-tools"
    rm -rf "$ANDROID_HOME/cmdline-tools/latest" "$ANDROID_HOME/cmdline-tools/latest.new"
    mv "$TMP/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
    trap - EXIT
    rm -rf "$TMP"
}
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
    install_clt
elif ! "$SDKMANAGER" --list 2>/dev/null | grep -q 'platforms;android-37'; then
    echo "sdk:    cmdline-tools too old to see current packages — upgrading"
    install_clt
else
    echo "sdk:    cmdline-tools ok"
fi

# Filesystem checks keep the (slow-starting) sdkmanager out of the happy
# path; AGP 9 auto-installs platforms/build-tools itself once licenses are
# accepted, so only platform-tools + NDK failures are fatal here.
CORE=""; SOFT=""
[ -x "$ANDROID_HOME/platform-tools/adb" ]                       || CORE="$CORE platform-tools"
[ -d "$ANDROID_HOME/ndk/28.2.13676358" ]                        || CORE="$CORE ndk;28.2.13676358"
[ -d "$ANDROID_HOME/platforms/android-37" ] \
    || [ -d "$ANDROID_HOME/platforms/android-37.0" ]             || SOFT="$SOFT platforms;android-37"
[ -d "$ANDROID_HOME/build-tools/36.0.0" ]                       || SOFT="$SOFT build-tools;36.0.0"
if [ -n "$CORE$SOFT" ]; then
    yes | "$SDKMANAGER" --licenses >/dev/null || true
    if [ -n "$CORE" ]; then
        echo "sdk:    installing:$CORE (NDK is the big one — ~2 GB unpacked)"
        # shellcheck disable=SC2086
        "$SDKMANAGER" $CORE
    fi
    if [ -n "$SOFT" ]; then
        echo "sdk:    installing:$SOFT (if the manager can't, AGP fetches them on first build)"
        # shellcheck disable=SC2086
        "$SDKMANAGER" $SOFT || true
    fi
else
    echo "sdk:    platform-tools + android-37 + build-tools 36.0.0 + ndk r28c ok"
fi

# --- Rust side --------------------------------------------------------------
if command -v rustup >/dev/null 2>&1; then
    for target in aarch64-linux-android x86_64-linux-android; do
        rustup target list --installed | grep -qx "$target" || rustup target add "$target"
    done
    echo "rust:   android targets ok (aarch64 + x86_64)"
    command -v cargo-ndk >/dev/null 2>&1 \
        || { echo "rust:   installing cargo-ndk"; cargo install cargo-ndk --locked; }
    command -v uniffi-bindgen >/dev/null 2>&1 \
        || { echo "rust:   installing uniffi-bindgen 0.32 (must match crates/ffi uniffi dep)"; \
             cargo install uniffi --features cli --version 0.32.0 --locked; }
    echo "rust:   cargo-ndk + uniffi-bindgen ok"
else
    echo "rust:   ACTION — rustup missing (install from https://rustup.rs), then re-run: just android-setup"
    PENDING_CMDS+=("install rustup: https://rustup.rs")
    PENDING=$((PENDING + 1))
fi

# --- Emulator + system image + AVD (the existing idempotent script) ---------
JAVA_HOME="$JAVA_HOME" ANDROID_HOME="$ANDROID_HOME" \
    bash "$(dirname "$0")/setup-android-emulator.sh"

# --- KVM (Linux only) ---------------------------------------------------------
if [ "$OS" = "Linux" ] && [ ! -e /dev/kvm ]; then
    echo "kvm:    ACTION — /dev/kvm missing (emulator unusably slow without it):"
    echo "          sudo apt install qemu-kvm && sudo usermod -aG kvm $USER   # then re-login"
    PENDING_CMDS+=("sudo apt install qemu-kvm" "sudo usermod -aG kvm $USER   # then re-login")
    PENDING=$((PENDING + 1))
fi

# --- Screen mirror stack ------------------------------------------------------
if [ "$OS" = "Linux" ]; then
    if DOCTOR_OUT="$(bash "$(dirname "$0")/scrcpy-doctor.sh" 2>&1)"; then
        echo "$DOCTOR_OUT"
    else
        echo "$DOCTOR_OUT"
        while IFS= read -r line; do
            case "$line" in *sudo* | *brew* | *install*) PENDING_CMDS+=("$line") ;; esac
        done <<< "$DOCTOR_OUT"
        PENDING=$((PENDING + 1))
    fi
else
    echo "screen: emulator boots windowed on $OS (no mirror needed); scrcpy optional: brew install scrcpy"
fi

echo
if [ "$PENDING" -gt 0 ]; then
    echo "android-setup: $PENDING action(s) need you — run these, then re-run 'just android-setup':"
    printf '  %s\n' "${PENDING_CMDS[@]}"
else
    echo "android-setup: ready — just android-serve-dev"
fi
