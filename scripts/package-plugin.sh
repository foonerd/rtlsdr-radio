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

# The node modules, installed by the Node version Volumio ships
docker run --rm -v "$PWD/$dist:/plugin" -w /plugin node:20-bookworm-slim sh -c \
  "npm ci --omit=dev --no-audit --no-fund --loglevel=error && chown -R $(id -u):$(id -g) node_modules"

printf '{\n  "version": "%s",\n  "commit": "%s",\n  "built": "%s"\n}\n' \
  "$version" "$(git rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dist/build.json"

zip="dist/rtlsdr_radio-$version.zip"
rm -f "$zip"
(cd "$dist" && zip -qr "../rtlsdr_radio-$version.zip" .)
echo "[OK] $zip: $(stat -c %s "$zip") bytes, sha256 $(sha256sum "$zip" | cut -d' ' -f1)"
