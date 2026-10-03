#!/bin/bash
# The notes of one version, as the plugin's README lists them under "Version History".
#
#   scripts/release-notes.sh <version>
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:?usage: release-notes.sh <version>}"
notes="$(awk -v v="### v$version" '
  index($0, v) == 1 && (length($0) == length(v) || substr($0, length(v) + 1, 1) == " ") { on = 1; next }
  on && /^### v/ { exit }
  on { print }
' plugin/README.md)"
[[ -n "${notes//[[:space:]]/}" ]] || { echo "error: plugin/README.md has no notes for v$version" >&2; exit 1; }
printf '%s\n' "$notes"
