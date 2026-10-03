#!/bin/bash
# The plugin as the zip a player installs: dist/rtlsdr_radio-<version>.zip, with the
# plugin's files at its root, its node modules, the built components of every target,
# and build.json naming the commit it was made from.
#
#   scripts/package-plugin.sh [--from <dir>]
set -euo pipefail
cd "$(dirname "$0")/.."

scripts/assemble-plugin.sh "$@"
dist="dist/rtlsdr_radio"
version="$(sed -n 's/^ *"version": *"\(.*\)",*/\1/p' "$dist/package.json" | head -1)"

# The node modules, as the Node image holds them (docker/Dockerfile.node): installed
# once from the lock file by the Node version Volumio ships, not fetched again here
image="$(scripts/node-image.sh)"
docker run --rm --network none -v "$PWD/$dist:/plugin" "$image" sh -c \
  "cp -a /opt/plugin/node_modules /plugin/ && chown -R $(id -u):$(id -g) /plugin/node_modules"

printf '{\n  "version": "%s",\n  "commit": "%s",\n  "built": "%s"\n}\n' \
  "$version" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dist/build.json"

zip="dist/rtlsdr_radio-$version.zip"
rm -f "$zip"
(cd "$dist" && zip -qr "../rtlsdr_radio-$version.zip" .)
echo "[OK] $zip: $(stat -c %s "$zip") bytes, sha256 $(sha256sum "$zip" | cut -d' ' -f1)"
