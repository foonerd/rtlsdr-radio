#!/bin/bash
# The notes of one version, as the project's wiki lists them on its Changelog page.
#
#   scripts/release-notes.sh <version>
#
# The wiki is a repository of its own (<repository>.wiki.git). It is read from a clone
# beside this repository (../rtlsdr-radio.wiki, or the folder WIKI_DIR names) when there
# is one, and fetched for the occasion otherwise, as on GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
version="${1:?usage: release-notes.sh <version>}"

wiki="${WIKI_DIR:-$(cd .. && pwd)/rtlsdr-radio.wiki}"
if [[ ! -f "$wiki/Changelog.md" ]]; then
  wiki="$(mktemp -d)"
  trap 'rm -rf "$wiki"' EXIT
  git clone -q --depth 1 "https://github.com/${GITHUB_REPOSITORY:-foonerd/rtlsdr-radio}.wiki.git" "$wiki" \
    || { echo "error: the wiki could not be fetched" >&2; exit 1; }
fi
[[ -f "$wiki/Changelog.md" ]] || { echo "error: the wiki has no Changelog page" >&2; exit 1; }

notes="$(awk -v v="### v$version" '
  index($0, v) == 1 && (length($0) == length(v) || substr($0, length(v) + 1, 1) == " ") { on = 1; next }
  on && /^### v/ { exit }
  on { print }
' "$wiki/Changelog.md")"
[[ -n "${notes//[[:space:]]/}" ]] || { echo "error: the wiki's Changelog has no notes for v$version" >&2; exit 1; }
printf '%s\n' "$notes"
