#!/bin/bash
# Build every component for one target. Runs in the build container, started by build.sh:
# the repository is mounted read-only at /src, the target's output directory at /out, the
# upstream sources are in the image at /opt/src, and there is no network.
set -euo pipefail
. /src/scripts/targets.sh

: "${TARGET:?TARGET is not set}"
export TARGET
export SRC_CACHE=/opt/src
export WORK=/tmp/work
export OUT=/out
TARGET_CFLAGS="$(target_cflags "$TARGET")"
TARGET_MACHINE="$(target_machine "$TARGET")"
TARGET_TRIPLET="$(target_triplet "$TARGET")"
export TARGET_CFLAGS TARGET_MACHINE TARGET_TRIPLET

rm -rf "$OUT/bin" "$OUT/packages"
mkdir -p "$WORK" "$OUT/bin" "$OUT/packages"
trap 'chown -R "${HOST_UID:-0}:${HOST_GID:-0}" "$OUT"' EXIT

echo "=== $TARGET: $(uname -m), gcc $(gcc -dumpversion), flags: ${TARGET_CFLAGS:-none} ==="

# Order matters: the DAB decoder links against the library built first.
bash /src/components/rtlsdr/build.sh
dpkg -i "$WORK"/rtlsdr/libfn-rtlsdr0_*_"$(dpkg --print-architecture)".deb \
        "$WORK"/rtlsdr/libfn-rtlsdr-dev_*_"$(dpkg --print-architecture)".deb
bash /src/components/dab/build.sh
bash /src/components/redsea/build.sh
bash /src/components/gain/build.sh

echo "=== $TARGET: checking what was built ==="
check="$WORK/check"
rm -rf "$check"; mkdir -p "$check"
cp -a "$OUT/bin" "$check/bin"
for deb in "$OUT"/packages/*.deb; do
  dpkg-deb -x "$deb" "$check/$(basename "$deb" .deb)"
done
bash /src/scripts/check-elf.sh "$TARGET" "$check"

# The binaries must start on the architecture they were built for.
"$OUT/bin/fn-redsea" --version
"$OUT/bin/fn-dab" -h >/dev/null 2>&1 || true
# The gain tool, asked for nothing, says how it is used and leaves with 2
"$OUT/bin/fn-rtl-gain" > /dev/null 2>&1 && { echo "error: fn-rtl-gain took no arguments for an answer" >&2; exit 1; } || [ $? -eq 2 ]
ldd "$OUT/bin/fn-dab" | grep -q 'not found' && { echo "error: fn-dab has unresolved libraries" >&2; exit 1; }
echo "[OK] $TARGET built"
