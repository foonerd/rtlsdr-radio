#!/usr/bin/env python3
"""Write out/<target>/manifest.json: what was built, from which sources, with checksums."""
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parent.parent
target = sys.argv[1]
out = root / "out" / target


def lock(path):
    entry = {}
    for line in path.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            entry[key.strip().lower()] = value.strip()
    return entry


def git(*args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    return result.stdout.strip()


files = {}
for path in sorted(out.rglob("*")):
    if path.is_file() and path.name not in ("manifest.json", "build.log"):
        files[str(path.relative_to(out))] = {
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "size": path.stat().st_size,
        }

manifest = {
    "target": target,
    "repository": {
        "commit": git("rev-parse", "HEAD"),
        "describe": git("describe", "--tags", "--always", "--dirty"),
    },
    "sources": {p.stem: lock(p) for p in sorted(root.glob("components/*/*.lock"))},
    "files": files,
}
(out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"[OK] {out / 'manifest.json'}: {len(files)} files")
