#!/usr/bin/env python3
"""Extract the top-most versioned section from CHANGELOG.md for release notes.

Prints the latest `## [X.Y.Z] - YYYY-MM-DD` section (everything from its
heading up to — but not including — the next `## [` heading) to stdout. Used by
the release flow (see RELEASE.md §5) so `gh release create --notes` gets the
CHANGELOG entry without paste-fragile inline Python in the shell command.

Usage:
    python3 .opencode/harness/scripts/extract-release-notes.py [repo_root]

Exit 1 if CHANGELOG.md is missing or no versioned section is found.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

SECTION_RE = re.compile(r"(## \[\d+\.\d+\.\d+\][^\n]*\n[\s\S]*?)(?=\n## \[)")


def main() -> int:
    repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.cwd()
    changelog = repo_root / "CHANGELOG.md"
    if not changelog.is_file():
        print(f"CHANGELOG.md not found at {changelog}", file=sys.stderr)
        return 1

    m = SECTION_RE.search(changelog.read_text())
    if not m:
        print(
            "No versioned section (## [X.Y.Z]) found in CHANGELOG.md", file=sys.stderr
        )
        return 1

    sys.stdout.write(m.group(1).strip() + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
