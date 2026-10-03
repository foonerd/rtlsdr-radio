#!/bin/bash
# Build every component for the given targets (default: all) into out/<target>/.
#
#   ./build.sh            all targets
#   ./build.sh arm x64    the named ones
#
# Needs Docker with emulation for the foreign architectures (qemu binfmt).
set -euo pipefail
cd "$(dirname "$0")"
. scripts/targets.sh

if [[ $# -gt 0 ]]; then targets=("$@"); else read -r -a targets <<< "$TARGETS"; fi
for t in "${targets[@]}"; do
  target_platform "$t" > /dev/null || { echo "error: unknown target '$t' (known: $TARGETS)" >&2; exit 1; }
done

scripts/fetch-sources.sh

for t in "${targets[@]}"; do
  platform="$(target_platform "$t")"
  base="$(target_base "$t")"
  echo ""
  echo "########## $t ($platform, $base)"
  if [[ "$base" == rtlsdr-radio/raspbian:* ]]; then
    docker build --platform "$platform" -f docker/Dockerfile.raspbian -t "$base" docker
  fi
  docker build --platform "$platform" --build-arg BASE="$base" \
    -f docker/Dockerfile.build -t "rtlsdr-radio/build:$t" docker
  mkdir -p "out/$t"
  docker run --rm --platform "$platform" \
    -v "$PWD:/src:ro" -v "$PWD/out/$t:/out" \
    -e TARGET="$t" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    "rtlsdr-radio/build:$t" bash /src/scripts/build-target.sh 2>&1 | tee "out/$t/build.log"
  # No warning passes unread: each one is on the reviewed list, or the build fails
  python3 scripts/check-warnings.py "out/$t/build.log"
  python3 scripts/write-manifest.py "$t"
done

echo ""
echo "[OK] built: ${targets[*]}"
