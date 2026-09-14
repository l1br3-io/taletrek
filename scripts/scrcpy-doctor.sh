#!/usr/bin/env bash
# scrcpy readiness doctor — the single source of truth for every known
# failure mode of the emulator's screen mirror (the emulator boots headless
# on Linux by default; see _android-serve in the justfile):
#   1. not installed            -> snap (Linux — noble's apt 1.25 dies on the
#                                  API 36 guest: SurfaceControl reflection) /
#                                  brew (macOS)
#   2. snap content plugs loose -> one-time `snap connect` (Pop's snapd skips
#                                  the auto-connect for non-Canonical
#                                  publishers; unwired, the renderer dies with
#                                  "GPU wrapper not found")
#   3. older than 2.0           -> same fix as (1)
# Exit 0 = ready, 1 = not ready (fixes printed unless --quiet).
# Callers: just android-setup (full), android-scrcpy (full),
# _android-serve (--quiet — gates the auto-opened mirror).
set -euo pipefail

QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
say() { [ "$QUIET" = 1 ] || echo "$@"; }
fail() { say "$@"; exit 1; }

case "$(uname -s)" in
    Linux)  INSTALL_FIX="sudo snap install scrcpy" ;;
    Darwin) INSTALL_FIX="brew install scrcpy" ;;
    *) fail "scrcpy doctor: unsupported OS $(uname -s)" ;;
esac

command -v scrcpy >/dev/null 2>&1 \
    || fail "scrcpy not installed — fix: $INSTALL_FIX"

# Snap wiring first: connection metadata reads work even while the unwired
# binary can't run (the gpu wrapper aborts `scrcpy --version` itself).
if [ "$(uname -s)" = "Linux" ] && snap list scrcpy >/dev/null 2>&1; then
    UNCONNECTED="$(snap connections scrcpy 2>/dev/null \
        | awk '$2 ~ /^scrcpy:(gpu-2404|ffmpeg-2404|gnome-46-2404)$/ && $3 == "-" {print $2}')"
    [ -z "$UNCONNECTED" ] || fail "scrcpy snap content plugs not connected (one-time; without them the renderer dies: 'GPU wrapper not found') — fix (idempotent, run all three):
  sudo snap connect scrcpy:gpu-2404 mesa-2404
  sudo snap connect scrcpy:ffmpeg-2404 ffmpeg-2404
  sudo snap connect scrcpy:gnome-46-2404 gnome-46-2404"
fi

V="$(scrcpy --version 2>/dev/null | grep -m1 '^scrcpy ' | awk '{print $2}' || true)"
[ "${V%%.*}" -ge 2 ] 2>/dev/null \
    || fail "scrcpy ${V:-unknown} is too old for the API 36 guest (mirror dies on start) — fix: $INSTALL_FIX"

say "scrcpy: ready ($V)"
