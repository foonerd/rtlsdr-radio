#!/bin/bash
# Check the plugin's JavaScript and run its tests, in a throwaway container with the
# Node version Volumio ships. Nothing outside the container is written.
set -euo pipefail
cd "$(dirname "$0")/.."

docker run --rm -v "$PWD:/src:ro" node:20-bookworm-slim bash -c '
  set -e
  cp -r /src/plugin /src/tests /tmp/ && cd /tmp/plugin
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  for f in index.js lib/*.js; do node --check "$f"; done
  echo "[OK] syntax"
  for f in i18n/*.json config.json UIConfig.json region.json package.json; do node -e "JSON.parse(require(\"fs\").readFileSync(\"$f\", \"utf8\"))"; done
  echo "[OK] json"
  # Stand-ins for the decoders and the audio tools, found before any real ones
  export PATH=/tmp/tests/fakes:$PATH
  # One file after another: the tuner removes processes named like the decoders,
  # and test files running side by side would remove those of each other
  cd /tmp && NODE_PATH=/tmp/plugin/node_modules node --test --test-concurrency=1 --test-timeout=40000 tests/
'
