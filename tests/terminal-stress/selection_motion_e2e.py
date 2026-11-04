#!/usr/bin/env python3
"""Guarded browser regression for terminal selection during live output.

Prerequisites are an isolated HTTP backend, the instrumented browser proxy, and
a browser opened with ``clipboard_guard.js`` before application code.  This
runner never reads or writes the host clipboard; captured copy payloads remain
inside the page's guard object.

The runtime producer and PTY setup are POSIX-only (macOS/Linux).  Windows is
deliberately rejected rather than implied to be covered.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.parse
import urllib.request


PIXELS_JS = r"""(async()=>{const cs=[...document.querySelectorAll('canvas')],out=[];
for(let i=1;i<=2;i++){const c=cs[i],d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
let nz=0,minX=c.width,minY=c.height,maxX=-1,maxY=-1;
for(let p=0;p<d.length;p+=4)if(d[p+3]){nz++;const q=p/4,x=q%c.width,y=Math.floor(q/c.width);
minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y)}
const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',d))].map(x=>x.toString(16).padStart(2,'0')).join('');
out.push({i,nz,bounds:maxX<0?null:[minX,minY,maxX,maxY],hash})}
return {guard:__tuicClipboardGuard.assertInstalled(),events:__tuicClipboardGuard.events.length,
lastEvent:__tuicClipboardGuard.events.at(-1)?.method??null,canvases:out}})()"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--case", choices=("held", "released"), required=True)
    parser.add_argument("--line", type=int, required=True)
    parser.add_argument("--start-row", type=int, default=8)
    parser.add_argument("--end-row", type=int, default=13)
    parser.add_argument("--backend", default="http://127.0.0.1:9877")
    parser.add_argument("--basic", default="integrity:synthetic-only")
    parser.add_argument("--browser-daemon", default="tuic-selection-browser")
    parser.add_argument("--browser-session", default="tuic-selection-guarded")
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--setup-timeout", type=float, default=120)
    parser.add_argument("--allow-primary", action="store_true")
    return parser.parse_args()


class Harness:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        encoded = base64.b64encode(args.basic.encode()).decode()
        self.headers = {"Authorization": f"Basic {encoded}", "Content-Type": "application/json"}
        self.env = {**os.environ, "AGENT_BROWSER_SESSION": args.browser_daemon}

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            self.args.backend + path, data=data, headers=self.headers, method=method
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)

    def browser(self, *arguments: str) -> str:
        result = subprocess.run(
            ["agent-browser", "--json", "--session-name", self.args.browser_session, *arguments],
            check=True,
            capture_output=True,
            env=self.env,
            text=True,
            timeout=20,
        )
        payload = json.loads(result.stdout)
        if not payload.get("success"):
            raise RuntimeError(payload)
        return payload["data"].get("result")

    def screenshot(self, destination: Path) -> None:
        result = subprocess.run(
            ["agent-browser", "--json", "--session-name", self.args.browser_session, "screenshot"],
            check=True,
            capture_output=True,
            env=self.env,
            text=True,
            timeout=20,
        )
        source = Path(json.loads(result.stdout)["data"]["path"])
        shutil.copy2(source, destination)

    def eval(self, script: str) -> object:
        result = self.browser("eval", script)
        if isinstance(result, str):
            return json.loads(result)
        return result

    def mouse(self, action: str, *arguments: object) -> None:
        self.browser("mouse", action, *(str(value) for value in arguments))

    def latest_grid(self) -> dict:
        records = [json.loads(line) for line in self.args.frames.read_text().splitlines()]
        return next(record["grid"] for record in reversed(records) if record.get("grid"))

    def visible_lines(self) -> list[str]:
        # row-text is viewport-relative. /lines uses retained-buffer indices,
        # which deliberately shift when historyBase advances at scrollback cap.
        rows = (0, self.args.start_row, self.args.end_row, 27)
        return [
            self.request(
                "GET", f"/sessions/{self.args.session_id}/terminal/row-text?row={row}"
            )["text"]
            for row in rows
        ]


def absolute_origin(grid: dict) -> int:
    return grid["historyBase"] + grid["historySize"] - grid["displayOffset"]


def main() -> None:
    if os.name != "posix":
        raise SystemExit("selection_motion_e2e.py requires a POSIX PTY; Windows is not validated")
    args = parse_args()
    parsed_backend = urllib.parse.urlparse(args.backend)
    if parsed_backend.port == 9876 and not args.allow_primary:
        raise SystemExit("refusing primary port 9876; use an isolated backend or --allow-primary")
    harness = Harness(args)
    args.output.mkdir(parents=True, exist_ok=True)

    guard = harness.eval(
        "({installed:__tuicClipboardGuard.assertInstalled(),"
        "webdriver:navigator.webdriver,effectiveIsTauri:Boolean(__TAURI_INTERNALS__)&&!Boolean(__TAURI_SHIM__),"
        "events:__tuicClipboardGuard.events.length})"
    )
    if guard != {"installed": True, "effectiveIsTauri": False, "events": guard["events"]}:
        raise AssertionError(f"unsafe browser/clipboard state: {guard}")

    harness.request(
        "POST", f"/sessions/{args.session_id}/terminal/scroll-to", {"line": args.line}
    )
    time.sleep(0.5)
    before_grid = harness.latest_grid()
    before_lines = harness.visible_lines()
    canvas = harness.eval(
        "(()=>{const cs=[...document.querySelectorAll('canvas')];if(cs.length<3)throw new Error('expected three terminal canvases');"
        "const c=cs[1],r=c.getBoundingClientRect();"
        "return {left:r.left,top:r.top,width:r.width,height:r.height,rows:%d}})()"
        % before_grid["screenRows"]
    )
    start_x = round(canvas["left"] + 32)
    end_x = round(canvas["left"] + 304)
    start_y = round(
        canvas["top"] + ((args.start_row + 0.5) * canvas["height"] / canvas["rows"])
    )
    end_y = round(
        canvas["top"] + ((args.end_row + 0.5) * canvas["height"] / canvas["rows"])
    )

    harness.eval("__tuicClipboardGuard.assertInstalled()")
    if args.case == "held":
        # Reproduce the stale cachedText boundary explicitly: finish a different
        # selection first, then begin the drag which remains held during output.
        seed_start_y = round(
            canvas["top"]
            + ((max(0, args.start_row - 4) + 0.5) * canvas["height"] / canvas["rows"])
        )
        seed_end_y = round(
            canvas["top"]
            + ((max(1, args.start_row - 2) + 0.5) * canvas["height"] / canvas["rows"])
        )
        harness.mouse("move", start_x, seed_start_y)
        harness.mouse("down", "left")
        try:
            harness.mouse("move", end_x, seed_end_y)
        finally:
            harness.eval("__tuicClipboardGuard.assertInstalled()")
            harness.mouse("up", "left")
        time.sleep(0.1)
    harness.eval(
        "(()=>{globalThis.__selectionMotionEvents=[];"
        "for(const type of ['mousedown','mousemove','mouseup'])addEventListener(type,e=>"
        "__selectionMotionEvents.push({type,button:e.button,buttons:e.buttons,isTrusted:e.isTrusted,"
        "visibility:document.visibilityState,time:performance.now()}),true);return true})()"
    )
    harness.mouse("move", start_x, start_y)
    harness.mouse("down", "left")
    mouse_is_down = True
    try:
        harness.mouse("move", end_x, end_y)
        if args.case == "released":
            harness.mouse("up", "left")
            mouse_is_down = False
        time.sleep(0.2)
        before_pixels = harness.eval(PIXELS_JS)
        harness.screenshot(args.output / f"{args.case}-before.png")
        if before_pixels["canvases"][1]["nz"] == 0:
            raise AssertionError("selection overlay was not painted")

        harness.request("POST", f"/sessions/{args.session_id}/write", {"data": "n"})
        if args.case == "held":
            time.sleep(0.08)
            harness.mouse("move", end_x + 8, end_y)
        deadline = time.monotonic() + args.setup_timeout
        while time.monotonic() < deadline:
            progressed_grid = harness.latest_grid()
            if (
                progressed_grid["historyBase"] + progressed_grid["historySize"]
                >= before_grid["historyBase"] + before_grid["historySize"] + 50
            ):
                break
            time.sleep(0.05)
        else:
            raise AssertionError("setup: producer completion unavailable after expected 50 rows")
        time.sleep(0.2)
        after_grid = harness.latest_grid()
        after_lines = harness.visible_lines()
        after_pixels = harness.eval(PIXELS_JS)
        harness.screenshot(args.output / f"{args.case}-after.png")
        held_events = harness.eval("__selectionMotionEvents.slice()")
    finally:
        if mouse_is_down:
            harness.eval("__tuicClipboardGuard.assertInstalled()")
            harness.mouse("up", "left")
    if args.case == "held":
        time.sleep(0.2)
        released = harness.eval(PIXELS_JS)
    else:
        released = after_pixels

    evidence = {
        "case": args.case,
        "guard": guard,
        "before": {"grid": before_grid, "origin": absolute_origin(before_grid), "lines": before_lines, "pixels": before_pixels},
        "after": {"grid": after_grid, "origin": absolute_origin(after_grid), "lines": after_lines, "pixels": after_pixels},
        "eventsBeforeRelease": held_events,
        "released": released,
        "framesSha256": hashlib.sha256(args.frames.read_bytes()).hexdigest(),
    }
    (args.output / f"{args.case}.json").write_text(json.dumps(evidence, indent=2) + "\n")

    assert absolute_origin(after_grid) == absolute_origin(before_grid), (before_grid, after_grid)
    assert (
        after_grid["historyBase"] + after_grid["historySize"]
        >= before_grid["historyBase"] + before_grid["historySize"] + 50
    ), (before_grid, after_grid)
    assert after_lines == before_lines, (before_lines, after_lines)
    assert after_pixels["canvases"][0]["nz"] > 0, after_pixels
    assert after_pixels["canvases"][1]["nz"] > 0, after_pixels
    if args.case == "released":
        assert after_pixels["canvases"] == before_pixels["canvases"], (
            before_pixels,
            after_pixels,
        )
    assert released["events"] == before_pixels["events"] + (1 if args.case == "held" else 0)
    assert released["lastEvent"] == "navigator.clipboard.writeText"
    print(json.dumps({"ok": True, "case": args.case, "origin": evidence["after"]["origin"]}))


if __name__ == "__main__":
    main()
