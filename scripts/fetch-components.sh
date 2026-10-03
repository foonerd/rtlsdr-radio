#!/bin/bash
# Fetch the built components of every target from the registry into out/<target>/,
# where a local build would have put them.
#
#   scripts/fetch-components.sh [<key>]     the key defaults to scripts/components-key.sh
#
# The registry is ghcr.io/<repository>-components; REPOSITORY names the repository
# (default: foonerd/rtlsdr-radio).
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/targets.sh

key="${1:-$(scripts/components-key.sh)}"
repository="${REPOSITORY:-foonerd/rtlsdr-radio}"

for t in $TARGETS; do
  image="ghcr.io/${repository}-components:$t-$key"
  docker pull -q "$image" > /dev/null || { echo "error: $image is not in the registry; the components workflow builds it" >&2; exit 1; }
  id="$(docker create "$image" -)"
  rm -rf "out/$t"
  mkdir -p "out/$t"
  docker cp "$id:/out/." "out/$t/"
  docker rm "$id" > /dev/null
  echo "[OK] out/$t from $image"
done
