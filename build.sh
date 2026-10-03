#!/bin/bash
# Build every component for the given targets (default: all) into out/<target>/.
#
#   ./build.sh            all targets
#   ./build.sh arm x64    the named ones
#
# Needs Docker, and a machine that can run the targets' programs: an x86-64 one with
# emulation (qemu binfmt) for the ARM targets, or a 64-bit ARM one, which runs the three
# ARM targets natively and needs emulation only for x64.
#
# A build image holds the build tools and the upstream sources at their locked commits,
# so the build itself fetches nothing. The images are built here unless BUILDER_REGISTRY
# names a registry that has them (as <registry>:<target>-<key>, the key from
# scripts/builder-key.sh); with BUILDER_PUSH=1 an image built here is kept there.
set -euo pipefail
cd "$(dirname "$0")"
. scripts/targets.sh

if [[ $# -gt 0 ]]; then targets=("$@"); else read -r -a targets <<< "$TARGETS"; fi
for t in "${targets[@]}"; do
  target_platform "$t" > /dev/null || { echo "error: unknown target '$t' (known: $TARGETS)" >&2; exit 1; }
done

for t in "${targets[@]}"; do
  platform="$(target_platform "$t")"
  base="$(target_base "$t")"
  echo ""
  echo "########## $t ($platform, $base)"
  builder="rtlsdr-radio/build:$t"
  kept=""
  if [[ -n "${BUILDER_REGISTRY:-}" ]]; then
    kept="$BUILDER_REGISTRY:$t-$(scripts/builder-key.sh toolchain)"
  fi
  if [[ -n "$kept" ]] && docker pull -q --platform "$platform" "$kept" > /dev/null 2>&1; then
    echo "[OK] build image: $kept"
    docker tag "$kept" "$builder"
  else
    scripts/fetch-sources.sh
    if [[ "$base" == rtlsdr-radio/raspbian:* ]]; then
      docker build --platform "$platform" -f docker/Dockerfile.raspbian -t "$base" docker
    fi
    docker build --platform "$platform" --build-arg BASE="$base" \
      -f docker/Dockerfile.build -t "rtlsdr-radio/tools:$t" docker
    printf 'FROM rtlsdr-radio/tools:%s\nCOPY . /opt/src/\n' "$t" \
      | docker build --platform "$platform" -t "$builder" -f - .cache/src
    if [[ -n "$kept" && "${BUILDER_PUSH:-0}" == 1 ]]; then
      docker tag "$builder" "$kept"
      docker push -q "$kept"
      echo "[OK] build image kept: $kept"
    fi
  fi

  # A 32-bit target presents itself as a 32-bit machine to whatever asks
  personality=()
  case "$t" in arm|armv7) personality=(linux32) ;; esac

  mkdir -p "out/$t"
  docker run --rm --platform "$platform" --network none \
    -v "$PWD:/src:ro" -v "$PWD/out/$t:/out" \
    -e TARGET="$t" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    "$builder" "${personality[@]}" bash /src/scripts/build-target.sh 2>&1 | tee "out/$t/build.log"
  # No warning passes unread: each one is on the reviewed list, or the build fails
  python3 scripts/check-warnings.py "out/$t/build.log"
  python3 scripts/write-manifest.py "$t"
done

echo ""
echo "[OK] built: ${targets[*]}"
