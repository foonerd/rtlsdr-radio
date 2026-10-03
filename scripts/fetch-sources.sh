#!/bin/bash
# Fetch every upstream source named in a lock file into .cache/src/<name>,
# at exactly the commit the lock names. Runs on the host; the build itself is offline.
#
# A lock file (components/<component>/<name>.lock) holds:
#   URL=<git repository>
#   COMMIT=<full commit id>
#   REF=<tag or description, for people; not used to fetch>
set -euo pipefail
cd "$(dirname "$0")/.."

CACHE=".cache/src"
mkdir -p "$CACHE"

for lock in components/*/*.lock; do
  name="$(basename "$lock" .lock)"
  # Read as text, not sourced: a lock file is data.
  URL="$(sed -n 's/^URL=//p' "$lock")"
  COMMIT="$(sed -n 's/^COMMIT=//p' "$lock")"
  REF="$(sed -n 's/^REF=//p' "$lock")"
  if [[ -z "$URL" || ! "$COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
    echo "error: $lock needs URL and a full COMMIT" >&2
    exit 1
  fi

  dest="$CACHE/$name"
  if [[ -d "$dest/.git" && "$(git -C "$dest" rev-parse HEAD 2>/dev/null)" == "$COMMIT" ]] \
     && [[ -z "$(git -C "$dest" status --porcelain)" ]]; then
    echo "[=] $name at ${COMMIT:0:12} ($REF)"
    continue
  fi

  echo "[+] $name: fetching ${COMMIT:0:12} ($REF) from $URL"
  rm -rf "$dest"
  git init -q "$dest"
  git -C "$dest" remote add origin "$URL"
  git -C "$dest" fetch -q --depth 1 origin "$COMMIT"
  git -C "$dest" -c advice.detachedHead=false checkout -q FETCH_HEAD
  if [[ "$(git -C "$dest" rev-parse HEAD)" != "$COMMIT" ]]; then
    echo "error: $name: fetched commit does not match the lock" >&2
    exit 1
  fi
done
