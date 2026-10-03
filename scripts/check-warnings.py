#!/usr/bin/env python3
"""Check a build's output for compiler and tool warnings nobody has looked at.

    scripts/check-warnings.py <build log>

Every line of the log that carries a warning (and every warning of CMake, which
writes them over several lines) must match an entry of
components/warnings-reviewed.txt, where each entry stands with the reason it is
harmless. A warning that matches none fails the build: it is either a fault to fix or a
new entry to write, and in both cases someone has read it.
"""
import pathlib
import re
import sys

REVIEWED = pathlib.Path(__file__).resolve().parent.parent / "components" / "warnings-reviewed.txt"


def reviewed():
    patterns = []
    for line in REVIEWED.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(re.compile(line))
    return patterns


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    patterns = reviewed()
    unread = {}
    total = 0
    lines = pathlib.Path(sys.argv[1]).read_text(errors="replace").splitlines()
    for at, line in enumerate(lines):
        if line.startswith("CMake Warning"):
            # CMake says what it warns of on the indented lines that follow
            said = [line]
            for more in lines[at + 1:at + 12]:
                if more and not more.startswith(" "):
                    break
                said.append(more.strip())
            line = " ".join(part for part in said if part)
        elif "warning:" not in line.lower():
            continue
        total += 1
        if not any(p.search(line) for p in patterns):
            # The same warning from the same place counts once
            unread[line.strip()] = unread.get(line.strip(), 0) + 1
    if unread:
        print(f"error: {len(unread)} warning(s) not in {REVIEWED.name}:", file=sys.stderr)
        for line, count in unread.items():
            print(f"  {count}x {line}", file=sys.stderr)
        sys.exit(1)
    print(f"[OK] warnings: {total}, all reviewed")


if __name__ == "__main__":
    main()
