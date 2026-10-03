#!/bin/bash
# Build the tool that measures the gain a dongle should be set to (fn-rtl-gain).
# Runs in the build container, after libfn-rtlsdr0 and libfn-rtlsdr-dev are installed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

pkg-config --exists libfn-rtlsdr || { echo "error: libfn-rtlsdr is not installed" >&2; exit 1; }
echo "[+] gain: against libfn-rtlsdr $(pkg-config --modversion libfn-rtlsdr)"

# shellcheck disable=SC2086
gcc $TARGET_CFLAGS -O2 -Wall -Wextra -o "$OUT/bin/fn-rtl-gain" "$here/src/fn-rtl-gain.c" \
  $(pkg-config --cflags --libs libfn-rtlsdr) -lm
strip "$OUT/bin/fn-rtl-gain"
echo "[OK] gain: fn-rtl-gain $(stat -c %s "$OUT/bin/fn-rtl-gain") bytes"
