#!/usr/bin/env python3
"""Emit deterministic terminal stress scenarios to stdout."""

from __future__ import annotations

import argparse
import os
import termios
import time
import tty

BSU = b"\x1b[?2026h"
ESU = b"\x1b[?2026l"
CHUNK_SCHEDULES = (
    (1, 2, 3, 5, 8, 13, 21),
    (127, 4, 31, 2, 255, 7),
    (9, 1, 1, 1, 64, 3, 17, 5),
)


def record(index: int) -> bytes:
    return f"REC-{index:04d}:abcdefghijklmnopqrstuvwxyz0123456789".encode()


def write_fragmented(payload: bytes, frame: int) -> None:
    schedule = CHUNK_SCHEDULES[frame % len(CHUNK_SCHEDULES)]
    offset = 0
    step = 0
    while offset < len(payload):
        end = min(offset + schedule[step % len(schedule)], len(payload))
        os.write(1, payload[offset:end])
        offset = end
        step += 1


def emit(scenario: str, count: int, marker: str | None = None) -> None:
    for index in range(count):
        complete = record(index)
        partial = complete[: 8 + index % 17]

        if scenario == "progressive":
            # Model token streaming across separate synchronized frames: the
            # partial row becomes visible before a later frame replaces it.
            write_fragmented(BSU + partial + ESU, index)
            time.sleep(0.001)
            tail = BSU + b"\r\x1b[2K" + complete + b"\r\n" + ESU
            write_fragmented(tail, index + 1)
        elif scenario == "timeout" and index % 97 == 0:
            write_fragmented(BSU + partial, index)
            # Intentionally exceed the current 150 ms synchronized-update
            # timeout. The remainder must replace the partial row, not preserve
            # it as an extra logical record.
            time.sleep(0.18)
            tail = b"\r\x1b[2K" + complete + b"\r\n" + ESU
            write_fragmented(tail, index + 1)
        else:
            frame = BSU + partial + b"\r\x1b[2K" + complete + b"\r\n" + ESU
            write_fragmented(frame, index)

        if index % 11 == 0:
            time.sleep(0.001)

    marker = marker or scenario
    os.write(1, f"\r\nTUIC_STRESS_DONE:{marker}:{count}\r\n".encode())


def emit_reflow(count: int) -> None:
    """Scroll a PARTIAL row into history, then print its complete extension.

    This is the exact shape story #498-7e3d reported seeing in a live Claude
    session: a partial sentence in canonical history immediately followed by its
    own complete extension. Emitting it deliberately, with the viewport resized
    underneath it by the runner, separates the three candidate causes named in
    that story — application output, resize reflow, and TUIC grid handling.

    Note what is NOT asserted afterwards: that the partial row disappears. Two
    rows where the second extends the first are BOTH legitimate terminal output
    when the application printed them that way, and the suite says so. What the
    runner checks is that the grid does not MANUFACTURE a copy under reflow.
    """
    for index in range(count):
        complete = record(index)
        # Partial row committed to history with its own newline: nothing can
        # rewrite it afterwards, which is what distinguishes this from the
        # atomic/progressive scenarios where the partial is erased in place.
        os.write(1, complete[: 8 + index % 17] + b"\r\n")
        time.sleep(0.001)
        os.write(1, complete + b"\r\n")
        if index % 11 == 0:
            time.sleep(0.001)

    os.write(1, f"\r\nTUIC_STRESS_DONE:reflow:{count}\r\n".encode())


def emit_scrollout(count: int) -> None:
    """Scroll a LIVE partial row (no newline) out of the viewport, then extend it.

    This is the mechanism `reflow` does NOT model. There the partial row was
    committed with its own newline, so nothing could ever have rewritten it. Here
    the partial row is still the cursor's line — the application could still `\r`
    over it — but enough output arrives to push it into scrollback first. The
    later rewrite therefore lands on a NEW row, and history keeps the partial.

    That is what a real terminal does: carriage return only reaches the current
    line, never one that has already scrolled off. So if TUIC reproduces both
    rows here it is being CORRECT, and the #498-7e3d sighting is the application
    printing both — not the grid duplicating anything.
    """
    for index in range(count):
        complete = record(index)
        # Live partial: no newline, so it is still the cursor's row.
        os.write(1, complete[: 8 + index % 17])
        time.sleep(0.001)
        # Push it out of the 12-row viewport while it is still "rewritable".
        for filler in range(16):
            os.write(1, f"\r\nFILL-{index:04d}-{filler:02d}".encode())
        # Now try to rewrite it. A real terminal cannot reach the scrolled row.
        os.write(1, b"\r\x1b[2K" + complete + b"\r\n")
        if index % 11 == 0:
            time.sleep(0.001)

    os.write(1, f"\r\nTUIC_STRESS_DONE:scrollout:{count}\r\n".encode())


def emit_slash_pressure(count: int) -> None:
    original = termios.tcgetattr(0)
    try:
        # Consume one slash without echoing it into the terminal grid. TUIC's
        # input FSM still enters slash mode, so every subsequent PTY chunk
        # exercises slash-menu parsing exactly like the captured log storm.
        tty.setraw(0)
        os.write(1, b"TUIC_STRESS_READY:slash-pressure\r\n")
        if os.read(0, 1) != b"/":
            raise RuntimeError("slash-pressure handshake did not receive slash")
        emit("atomic", count, marker="slash-pressure")
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, original)


def emit_ink_repaint(count: int) -> None:
    """Model Ink's tall-frame clear-and-reprint behavior.

    Each synchronized update returns home, erases every row, and prints the
    entire frame again. Because the frame is taller than the viewport, earlier
    copies are pushed into normal-screen scrollback before Ink can repaint them.
    A conforming terminal therefore retains exactly the copies present in the
    raw stream; this scenario distinguishes upstream re-emission from grid-made
    duplication.
    """
    frame = [b"TUIC_INK_BANNER"] + [record(index) for index in range(count)]
    for repaint in range(4):
        payload = bytearray(BSU + b"\x1b[H")
        for line in frame:
            payload.extend(b"\x1b[2K")
            payload.extend(line)
            payload.extend(b"\r\n")
        payload.extend(ESU)
        write_fragmented(bytes(payload), repaint)
        time.sleep(0.01)

    os.write(1, f"\r\nTUIC_STRESS_DONE:ink-repaint:{count}\r\n".encode())


def main() -> None:
    parser = argparse.ArgumentParser()
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
        ),
        required=True,
    )
    parser.add_argument("--count", type=int, default=2000)
    args = parser.parse_args()
    if args.count < 1 or args.count > 9999:
        parser.error("--count must be between 1 and 9999")
    if args.scenario == "slash-pressure":
        emit_slash_pressure(args.count)
    elif args.scenario == "reflow":
        emit_reflow(args.count)
    elif args.scenario == "scrollout":
        emit_scrollout(args.count)
    elif args.scenario == "ink-repaint":
        emit_ink_repaint(args.count)
    else:
        emit(args.scenario, args.count)


if __name__ == "__main__":
    main()
