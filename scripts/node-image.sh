#!/bin/bash
# Make sure the Node image (docker/Dockerfile.node) is on this machine and print its name.
#
# It is taken from the registry when BUILDER_REGISTRY names one that has it, and built
# here otherwise; with BUILDER_PUSH=1 an image built here is kept in the registry.
set -euo pipefail
cd "$(dirname "$0")/.."

key="$(scripts/builder-key.sh node)"
image="rtlsdr-radio/node:$key"

if ! docker image inspect "$image" > /dev/null 2>&1; then
  kept=""
  if [[ -n "${BUILDER_REGISTRY:-}" ]]; then
    kept="$BUILDER_REGISTRY:node-$key"
  fi
  if [[ -n "$kept" ]] && docker pull -q "$kept" > /dev/null 2>&1; then
    docker tag "$kept" "$image"
  else
    docker build -q -f docker/Dockerfile.node -t "$image" plugin >&2
    if [[ -n "$kept" && "${BUILDER_PUSH:-0}" == 1 ]]; then
      docker tag "$image" "$kept"
      docker push -q "$kept" >&2
    fi
  fi
fi
echo "$image"
