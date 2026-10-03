#!/bin/bash
# The key the built components are kept under: a digest of everything they are built
# from. The same sources give the same key, so a build is made once and is used by
# every build of the plugin until one of the sources changes.
set -euo pipefail
cd "$(dirname "$0")/.."
git ls-files -s -- build.sh components docker \
  scripts/build-target.sh scripts/check-elf.sh scripts/check-warnings.py \
  scripts/fetch-sources.sh scripts/targets.sh scripts/write-manifest.py | sha256sum | cut -c1-16
