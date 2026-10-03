#!/bin/bash
# The key an image is kept under in the registry: a digest of what the image is made of.
#
#   scripts/builder-key.sh toolchain   the images the components are built in: the build
#                                      tools and the upstream sources at their locked commits
#   scripts/builder-key.sh node        the image the tests run in and a packed plugin takes
#                                      its node modules from
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
  toolchain)
    git ls-files -s -- docker/Dockerfile.build docker/Dockerfile.raspbian \
      'components/*/*.lock' scripts/fetch-sources.sh | sha256sum | cut -c1-16 ;;
  node)
    # The lock file says which modules; the plugin's version in package.json does not
    git ls-files -s -- docker/Dockerfile.node plugin/package-lock.json | sha256sum | cut -c1-16 ;;
  *)
    echo "usage: builder-key.sh toolchain|node" >&2; exit 1 ;;
esac
