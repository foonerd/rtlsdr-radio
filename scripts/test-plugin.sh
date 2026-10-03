#!/bin/bash
# Check the plugin's JavaScript and run its tests, in a throwaway container with the
# Node version Volumio ships and the plugin's node modules (docker/Dockerfile.node).
# The container has no network: nothing is fetched, and no test can reach outside.
# Nothing outside the container is written.
set -euo pipefail
cd "$(dirname "$0")/.."

image="$(scripts/node-image.sh)"

docker run --rm --network none -v "$PWD:/src:ro" "$image" bash -c '
  set -e
  cp -r /src/plugin /src/tests /tmp/ && cd /tmp/plugin
  ln -s /opt/plugin/node_modules node_modules
  # The image was made from the lock file: every module the plugin names must be in it
  node -e "Object.keys(require(\"./package.json\").dependencies).forEach(function(name) { if (!require(\"fs\").existsSync(\"node_modules/\" + name + \"/package.json\")) { console.error(\"error: \" + name + \" is not in the Node image; rebuild it\"); process.exit(1); } })"
  echo "[OK] modules"
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
