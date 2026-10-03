#!/bin/bash
# Set the plugin's version wherever the plugin states it.
#
#   scripts/set-version.sh <version> "<changelog line>"
#
# The changelog line is the one the Volumio plugin store shows for the version: it
# names this version and nothing else. The notes of the version must already stand on
# the Changelog page of the project's wiki, as "### v<version>" (see release-notes.sh).
#
# plugin/package-lock.json is left alone: it names the node modules, which a version
# does not change, and the Node image is kept under a key made of it.
set -euo pipefail
cd "$(dirname "$0")/.."

version="${1:?usage: set-version.sh <version> \"<changelog line>\"}"
changelog="${2:?usage: set-version.sh <version> \"<changelog line>\"}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "error: '$version' is not a version like 1.3.11" >&2; exit 1; }
[[ "$changelog" == "v$version - "* ]] || { echo "error: the changelog line must start with 'v$version - '" >&2; exit 1; }
scripts/release-notes.sh "$version" > /dev/null

python3 - "$version" "$changelog" <<'PY'
import json, pathlib, re, sys
version, changelog = sys.argv[1], sys.argv[2]

package = pathlib.Path("plugin/package.json")
text = package.read_text()
data = json.loads(text)
text = text.replace('"version": "%s"' % data["version"], '"version": "%s"' % version, 1)
text = text.replace(json.dumps(data["volumio_info"]["changelog"]), json.dumps(changelog), 1)
assert json.loads(text)["version"] == version and json.loads(text)["volumio_info"]["changelog"] == changelog
package.write_text(text)

install = pathlib.Path("plugin/install.sh")
text, count = re.subn(r'^echo "Version: [0-9.]+"$', 'echo "Version: %s"' % version, install.read_text(), flags=re.M)
assert count == 1, "plugin/install.sh: the line that prints the version was not found"
install.write_text(text)

PY
echo "[OK] version $version"
