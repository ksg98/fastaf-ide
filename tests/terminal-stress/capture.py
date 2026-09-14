#!/usr/bin/env python3
"""Snapshot everything needed to diagnose a terminal-grid anomaly, in one shot.

Story #498-7e3d stalled for a concrete reason: a partial row was seen immediately
followed by its own complete extension in canonical rows, but by the time anyone
went looking the raw ring had already rotated past the bytes that produced it. A
grid anomaly is only diagnosable from three things TOGETHER — the raw bytes, the
dimensions they were rendered at, and the canonical rows they produced — and two
of the three are volatile.

Run this the moment you see one:

    python3 tests/terminal-stress/capture.py --session <id> -o capture-dir \\
        [--base-url http://127.0.0.1:9876] [--auth user:pass]

It writes `raw.bin`, `canonical.txt` and `meta.json` (dimensions, scroll info,
timestamps, the requested row window). Attach the directory to the story.
"""

from __future__ import annotations

import argparse
import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


class Client:
    def __init__(self, base_url: str, auth: str | None) -> None:
        self.base_url = base_url.rstrip("/")
        self.headers = {"Content-Type": "application/json"}
        if auth:
            token = base64.b64encode(auth.encode()).decode()
            self.headers["Authorization"] = f"Basic {token}"

    def get(self, path: str) -> dict:
        request = urllib.request.Request(
            self.base_url + path, method="GET", headers=self.headers
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.load(response)

    def get_bytes(self, path: str) -> bytes:
        request = urllib.request.Request(
            self.base_url + path, method="GET", headers=self.headers
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.read()


def capture_raw_ring(client: Client, session_id: str, out: Path) -> bytes:
    """Fetch and persist the byte-exact flight recorder before other requests."""
    endpoint = f"/sessions/{session_id}/raw-ring"
    try:
        raw = client.get_bytes(endpoint)
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError(f"failed to fetch raw flight recorder from {endpoint}: {exc}") from exc
    if not raw:
        raise RuntimeError(f"raw flight recorder for session {session_id} is empty")
    (out / "raw.bin").write_bytes(raw)
    return raw


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--base-url", default="http://127.0.0.1:9876")
    parser.add_argument("--auth", metavar="USER:PASS")
    parser.add_argument("-o", "--out", default="terminal-capture")
    parser.add_argument(
        "--rows",
        type=int,
        default=2000,
        help="how many canonical rows to keep, counting back from the newest",
    )
    args = parser.parse_args()

    client = Client(args.base_url, args.auth)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    # Raw ring FIRST — it is the volatile one. Every extra request is more
    # output arriving and more chance the bytes we came for have rotated out.
    raw = capture_raw_ring(client, args.session, out)

    info = client.get(f"/sessions/{args.session}/terminal/scroll-info")
    total = int(info["total_lines"])
    start = max(0, total - args.rows)
    query = urllib.parse.urlencode({"start": start, "end": total})
    lines = client.get(f"/sessions/{args.session}/terminal/lines?{query}")["lines"]
    (out / "canonical.txt").write_text("\n".join(lines), encoding="utf-8")

    meta = {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "session_id": args.session,
        "base_url": args.base_url,
        "scroll_info": info,
        "canonical_range": {"start": start, "end": total},
        "raw_length": len(raw),
    }
    (out / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # Surface adjacent duplicates immediately: the reported shape is a partial
    # row followed by its own extension, so a prefix match on the NEXT row is
    # the signal worth eyeballing before the terminal moves on.
    suspects = [
        (start + i, a, b)
        for i, (a, b) in enumerate(zip(lines, lines[1:]))
        if a.strip() and a.strip() != b.strip() and b.strip().startswith(a.strip())
    ]
    print(f"captured -> {out}/  ({total} canonical rows, raw {meta['raw_length']} bytes)")
    if suspects:
        print(f"{len(suspects)} adjacent row(s) where the next EXTENDS the previous:")
        for row, a, b in suspects[:10]:
            print(f"  row {row}: {a.strip()[:60]!r}")
            print(f"  row {row + 1}: {b.strip()[:60]!r}")
    else:
        print("no adjacent prefix-extension pairs in the captured window")


if __name__ == "__main__":
    main()
