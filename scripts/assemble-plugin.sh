#!/bin/bash
# Put the plugin and the built components together into dist/rtlsdr_radio/,
# the folder as it is installed on a player:
#
#   plugin/                      -> dist/rtlsdr_radio/
#   out/<target>/bin/*           -> dist/rtlsdr_radio/bin/<target>/
#   out/<target>/packages/*.deb  -> dist/rtlsdr_radio/packages/<target>/
#   out/<target>/manifest.json   -> dist/rtlsdr_radio/components.json (all targets)
#
#   scripts/assemble-plugin.sh [--from <dir>] [--store]
#
#   --from <dir>   <dir> holds the <target>/ trees (default: out)
#   --store        the folder as it goes into the plugins repository for the store:
#                  no lock file (and never node modules; the store builds those)
set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/targets.sh

from="out"
store=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) from="$2"; shift 2 ;;
    --store) store=1; shift ;;
    *) echo "error: unknown option '$1'" >&2; exit 1 ;;
  esac
done

for t in $TARGETS; do
  for f in bin/fn-dab bin/fn-dab-scanner bin/fn-redsea manifest.json; do
    [[ -f "$from/$t/$f" ]] || { echo "error: $from/$t/$f is missing; build target '$t' first" >&2; exit 1; }
  done
  ls "$from/$t"/packages/libfn-rtlsdr0_*_"$t".deb "$from/$t"/packages/foonerd-rtlsdr_*_"$t".deb > /dev/null
done

dist="dist/rtlsdr_radio"
rm -rf "$dist"
mkdir -p "$dist"
cp -a plugin/. "$dist/"
# The link to the station logos is made by the plugin where it runs
rm -rf "$dist/logos"

for t in $TARGETS; do
  mkdir -p "$dist/bin/$t" "$dist/packages/$t"
  install -m 755 "$from/$t"/bin/fn-dab "$from/$t"/bin/fn-dab-scanner "$from/$t"/bin/fn-redsea "$dist/bin/$t/"
  install -m 644 "$from/$t"/packages/*.deb "$dist/packages/$t/"
done

python3 - "$from" "$dist" $TARGETS <<'PY'
import json, pathlib, sys
src, dist, targets = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3:]
manifests = {t: json.loads((src / t / "manifest.json").read_text()) for t in targets}
first = manifests[targets[0]]
for t, m in manifests.items():
    if m["sources"] != first["sources"] or m["repository"] != first["repository"]:
        sys.exit(f"error: target '{t}' was built from different sources than '{targets[0]}'")
components = {
    "repository": first["repository"],
    "sources": first["sources"],
    "targets": {t: m["files"] for t, m in manifests.items()},
}
(dist / "components.json").write_text(json.dumps(components, indent=2) + "\n")
PY

if [[ "$store" -eq 1 ]]; then
  rm -f "$dist/package-lock.json"
  rm -rf "$dist/node_modules"
fi

echo "[OK] $dist: plugin $(sed -n 's/^ *"version": *"\(.*\)",*/\1/p' "$dist/package.json" | head -1), targets: $TARGETS"
