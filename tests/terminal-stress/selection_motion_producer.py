#!/usr/bin/env python3
"""Deterministic PTY producer for guarded canvas-selection regressions."""

from __future__ import annotations

import os
import argparse
import sys
import time

if os.name == "posix":
    import termios
    import tty


INITIAL_ROWS = 180
BATCH_ROWS = 48


def write(data: str) -> None:
    encoded = data.encode()
    offset = 0
    while offset < len(encoded):
        offset += os.write(1, encoded[offset:])


def row(index: int) -> str:
    return f"SEL-{index:05d}|stationary-selection-integrity|payload-{index:05d}"


def emit_rows(start: int, count: int, delay: float) -> int:
    for index in range(start, start + count):
        write(f"\x1b[2K{row(index)}\r\n")
        if delay:
            time.sleep(delay)
    return start + count


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--initial-rows", type=int, default=INITIAL_ROWS)
    parser.add_argument("--batch-rows", type=int, default=BATCH_ROWS)
    parser.add_argument("--batch-delay", type=float, default=0.008)
    return parser.parse_args()


def main() -> None:
    if os.name != "posix":
        raise SystemExit(
            "selection_motion_producer.py requires a POSIX PTY (macOS/Linux); "
            "the guarded browser regression has not been validated on Windows"
        )
    args = parse_args()
    if args.initial_rows < 1 or args.batch_rows < 1 or args.batch_delay < 0:
        raise SystemExit("row counts must be positive and batch delay non-negative")
    original = termios.tcgetattr(0)
    tty.setraw(0)
    next_row = 0
    batch = 0
    try:
        write("\x1bc")
        next_row = emit_rows(next_row, args.initial_rows, 0)
        write("\x1b[2KSEL-CONTROL|READY\r\n")
        while True:
            command = os.read(0, 1)
            if command == b"q" or not command:
                break
            if command != b"n":
                continue
            write(f"\x1b[2KSEL-CONTROL|BATCH-{batch:03d}-START\r\n")
            next_row = emit_rows(next_row, args.batch_rows, args.batch_delay)
            write(f"\x1b[2KSEL-CONTROL|BATCH-{batch:03d}-END\r\n")
            batch += 1
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, original)


if __name__ == "__main__":
    main()
