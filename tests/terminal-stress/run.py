#!/usr/bin/env python3
"""Drive terminal stress scenarios through a real FastAF HTTP API."""

from __future__ import annotations

import argparse
import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path


class Client:
    def __init__(self, base_url: str, auth: str | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        # The headless `tuic-remote` binary has no desktop loopback bypass, so it
        # demands Basic Auth even on 127.0.0.1. A desktop `make dev` instance does
        # not, which is why this is optional.
        self.headers = {"Content-Type": "application/json"}
        if auth:
            token = base64.b64encode(auth.encode()).decode()
            self.headers["Authorization"] = f"Basic {token}"

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(
            self.base_url + path,
            data=data,
            method=method,
            headers=self.headers,
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def request_bytes(self, path: str) -> bytes:
        request = urllib.request.Request(
            self.base_url + path, method="GET", headers=self.headers
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.read()


def expected_record(index: int) -> str:
    return f"REC-{index:04d}:abcdefghijklmnopqrstuvwxyz0123456789"


def read_all_lines(client: Client, session_id: str) -> list[str]:
    info = client.request("GET", f"/sessions/{session_id}/terminal/scroll-info")
    total = int(info["total_lines"])
    lines: list[str] = []
    for start in range(0, total, 500):
        end = min(start + 500, total)
        query = urllib.parse.urlencode({"start": start, "end": end})
        payload = client.request(
            "GET", f"/sessions/{session_id}/terminal/lines?{query}"
        )
        lines.extend(payload["lines"])
    return lines


def verify(lines: list[str], count: int, scenario: str) -> None:
    expected = {expected_record(index) for index in range(count)}
    observed = Counter(line for line in lines if line.startswith("REC-"))
    missing = sorted(expected - observed.keys())
    duplicates = sorted(line for line, occurrences in observed.items() if occurrences != 1)
    unexpected = sorted(observed.keys() - expected)
    truncated = sorted(
        line
        for line in observed
        if line.startswith("REC-") and len(line) != len(expected_record(0))
    )
    if missing or duplicates or unexpected or truncated:
        raise AssertionError(
            f"{scenario} failed: missing={missing[:20]}, "
            f"duplicates={duplicates[:20]}, unexpected={unexpected[:20]}, "
            f"truncated={truncated[:20]}"
        )


def verify_reflow(lines: list[str], count: int) -> None:
    """The reflow scenario prints a partial row AND its complete extension.

    Both are legitimate output — the producer really emitted both, so requiring
    the partial to vanish would be asserting the grid should silently discard
    terminal history. What must hold is that the grid does not MANUFACTURE a
    copy: every complete record appears exactly once even though the viewport
    was resized underneath it while the rows were being written.
    """
    expected = {expected_record(index) for index in range(count)}
    observed = Counter(line for line in lines if line in expected)
    missing = sorted(expected - observed.keys())
    duplicates = sorted(line for line, seen in observed.items() if seen != 1)
    truncated = sorted(
        line
        for line in lines
        if line.startswith("REC-")
        and line not in expected
        and len(line) > len(expected_record(0))
    )
    problems = []
    if missing:
        problems.append(f"missing={missing[:5]} ({len(missing)} total)")
    if duplicates:
        problems.append(f"duplicated={duplicates[:5]} ({len(duplicates)} total)")
    if truncated:
        problems.append(f"overlong={truncated[:5]} ({len(truncated)} total)")
    if problems:
        raise AssertionError("reflow: " + "; ".join(problems))


def verify_scrollout(lines: list[str], count: int) -> None:
    """Report what the grid did with a live partial row that scrolled away.

    Deliberately diagnostic rather than pass/fail on the partial: the point is to
    establish WHICH behaviour TUIC has, so #498-7e3d's cause can be named. The
    hard assertion is only that every complete record exists exactly once — the
    grid must not manufacture copies. Whether the orphaned partial ALSO survives
    is printed, because that is the reported shape and a real terminal keeps it.
    """
    expected = {expected_record(index) for index in range(count)}
    observed = Counter(line for line in lines if line in expected)
    missing = sorted(expected - observed.keys())
    duplicates = sorted(line for line, seen in observed.items() if seen != 1)
    if missing or duplicates:
        raise AssertionError(
            f"scrollout: missing={missing[:5]} duplicated={duplicates[:5]}"
        )

    # An orphaned partial is a REC- row that is a strict prefix of its complete
    # form — exactly the #498-7e3d shape.
    orphans = [
        line
        for line in lines
        if line.startswith("REC-")
        and line not in expected
        and any(full.startswith(line) for full in expected)
    ]
    print(
        f"PASS scrollout: {count} complete records, none manufactured; "
        f"{len(orphans)} orphaned partial row(s) retained in history"
    )
    if orphans:
        print(
            "  -> retaining them is correct: carriage return cannot reach a row "
            "that already scrolled off, so both rows are real output"
        )


def verify_ink_repaint(lines: list[str], raw: bytes, count: int) -> None:
    """Prove that every apparent duplicate was already emitted by Ink."""
    expected_copies = 4
    raw_banners = raw.count(b"TUIC_INK_BANNER")
    grid_banners = sum(line == "TUIC_INK_BANNER" for line in lines)
    if raw_banners != expected_copies or grid_banners != raw_banners:
        raise AssertionError(
            "ink-repaint banner provenance failed: "
            f"expected={expected_copies} raw={raw_banners} grid={grid_banners}"
        )

    expected = {expected_record(index) for index in range(count)}
    observed = Counter(line for line in lines if line in expected)
    bad_raw = sorted(
        line for line in expected if raw.count(line.encode()) != expected_copies
    )
    missing = sorted(line for line in expected if observed[line] == 0)
    manufactured = sorted(
        line for line in expected if observed[line] > raw.count(line.encode())
    )
    if bad_raw or missing or manufactured:
        raise AssertionError(
            "ink-repaint record provenance failed: "
            f"bad_raw={bad_raw[:10]} missing={missing[:10]} "
            f"manufactured={manufactured[:10]}"
        )

    distribution = Counter(observed.values())
    print(
        f"PASS ink-repaint: {count} records x {expected_copies} raw emissions; "
        f"canonical copies={dict(sorted(distribution.items()))}, none manufactured"
    )

def run_scenario(
    client: Client,
    repo_root: Path,
    scenario: str,
    count: int,
    timeout_seconds: float,
) -> None:
    created = client.request(
        "POST",
        "/sessions",
        {"rows": 12, "cols": 72, "shell": "/bin/zsh", "cwd": str(repo_root)},
    )
    session_id = created["session_id"]
    try:
        command = (
            "python3 tests/terminal-stress/producer.py "
            f"--scenario {scenario} --count {count}"
        )
        # Wait for the login shell to render its first prompt. Writing at a
        # fixed short delay is racy under load: zsh initialization can still be
        # replacing the line discipline and the command may be partially lost.
        shell_deadline = time.monotonic() + min(timeout_seconds, 10.0)
        while time.monotonic() < shell_deadline:
            initial = client.request(
                "GET", f"/sessions/{session_id}/output?limit=256&format=text"
            )
            if initial.get("data", "").strip():
                break
            time.sleep(0.05)
        else:
            raise TimeoutError("login shell did not render an initial prompt")

        # Mirror sendCommand's split text/Enter delivery. Ink agents require a
        # real gap; keeping the same contract here also avoids LF being treated
        # as printable input by a PTY.
        client.request("POST", f"/sessions/{session_id}/write", {"data": command})
        time.sleep(0.01)
        client.request("POST", f"/sessions/{session_id}/write", {"data": "\r"})

        if scenario == "slash-pressure":
            ready_marker = "TUIC_STRESS_READY:slash-pressure"
            ready_deadline = time.monotonic() + timeout_seconds
            while time.monotonic() < ready_deadline:
                output = client.request(
                    "GET", f"/sessions/{session_id}/output?limit=256&format=text"
                )
                if ready_marker in output.get("data", ""):
                    break
                time.sleep(0.02)
            else:
                raise TimeoutError("slash-pressure producer did not become ready")
            client.request("POST", f"/sessions/{session_id}/write", {"data": "/"})

        deadline = time.monotonic() + timeout_seconds
        iteration = 0
        done_marker = f"TUIC_STRESS_DONE:{scenario}:{count}"
        last_output = ""
        while time.monotonic() < deadline:
            # Exercise the same coalesced scroll path used by wheel/scrollbar
            # input while the producer continues writing.
            client.request(
                "POST",
                f"/sessions/{session_id}/terminal/scroll-to-offset",
                {"offset": (iteration * 37) % 400},
            )
            rows = 12 + iteration % 9
            cols = 72 + (iteration * 13) % 57
            client.request(
                "POST", f"/sessions/{session_id}/resize", {"rows": rows, "cols": cols}
            )
            output = client.request(
                "GET", f"/sessions/{session_id}/output?limit=4096&format=text"
            )
            last_output = output.get("data", "")
            if done_marker in last_output:
                break
            iteration += 1
            time.sleep(0.02)
        else:
            tail = last_output[-1000:].replace("\n", "\\n")
            raise TimeoutError(
                f"{scenario} did not finish in {timeout_seconds}s; output tail={tail!r}"
            )

        client.request(
            "POST",
            f"/sessions/{session_id}/terminal/scroll-to-offset",
            {"offset": 0},
        )
        time.sleep(0.25)
        raw = client.request_bytes(f"/sessions/{session_id}/raw-ring")
        lines = read_all_lines(client, session_id)
        if scenario == "reflow":
            verify_reflow(lines, count)
            print(f"PASS reflow: {count} complete records, none manufactured by reflow")
        elif scenario == "scrollout":
            verify_scrollout(lines, count)
        elif scenario == "ink-repaint":
            verify_ink_repaint(lines, raw, count)
        else:
            verify(lines, count, scenario)
            print(f"PASS {scenario}: {count} complete unique records")
    finally:
        try:
            client.request("DELETE", f"/sessions/{session_id}")
        except (urllib.error.URLError, TimeoutError):
            pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:9877")
    parser.add_argument("--allow-primary", action="store_true")
    parser.add_argument("--count", type=int, default=2000)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument(
        "--auth",
        metavar="USER:PASS",
        help="Basic Auth credentials, required against a headless tuic-remote instance",
    )
    parser.add_argument(
        "--scenario",
        choices=(
            "atomic",
            "progressive",
            "timeout",
            "slash-pressure",
            "reflow",
            "scrollout",
            "ink-repaint",
            "all",
        ),
        default="all",
    )
    args = parser.parse_args()

    parsed = urllib.parse.urlparse(args.base_url)
    if parsed.port == 9876 and not args.allow_primary:
        parser.error("port 9876 requires --allow-primary")
    if args.count < 1 or args.count > 9999:
        parser.error("--count must be between 1 and 9999")

    repo_root = Path(__file__).resolve().parents[2]
    client = Client(args.base_url, args.auth)
    scenarios = (
        (
            "atomic",
            "progressive",
            "timeout",
            "slash-pressure",
            "reflow",
            "scrollout",
            "ink-repaint",
        )
        if args.scenario == "all"
        else (args.scenario,)
    )
    for scenario in scenarios:
        run_scenario(client, repo_root, scenario, args.count, args.timeout)


if __name__ == "__main__":
    main()
