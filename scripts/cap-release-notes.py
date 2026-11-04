#!/usr/bin/env python3
"""Bound a UTF-8 release body and link to the complete commit comparison."""

import argparse
from pathlib import Path


# A byte bound is conservative for GitHub's 125000-character body limit,
# including Unicode subjects. Leave room for differences in server counting.
MAX_BYTES = 120000


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("notes", type=Path)
    parser.add_argument("compare_url")
    args = parser.parse_args()
    notes = args.notes.read_bytes()
    if len(notes) <= MAX_BYTES:
        return

    footer = (
        "\n\n---\n\n"
        f"Notes truncated. [View all changes]({args.compare_url}).\n"
    ).encode("utf-8")
    budget = MAX_BYTES - len(footer)
    if budget <= 0:
        parser.error("compare URL exceeds the release body budget")

    # Keep complete Markdown lines; never split a commit subject or UTF-8 code point.
    end = notes.rfind(b"\n", 0, budget + 1)
    prefix = notes[: end + 1].rstrip(b"\n") if end >= 0 else b""
    args.notes.write_bytes(prefix + footer)


if __name__ == "__main__":
    main()
