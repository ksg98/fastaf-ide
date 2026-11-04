# Recorded ego intent cells

Recorded on 2026-10-16 from the managed ego session
`0db70350-e300-426a-9c91-55c8cc650335` through a read-only
`terminal_styled_rows` IPC request (`start: 0`, `count: 300`).
The live session runs ego 0.1.0 on macOS.

The JSON contains the unchanged 11-byte styled cells of absolute rows 41 and 42.
An owned full-frame envelope renumbers them to viewport rows 0 and 1 and pads
the remaining 24-row viewport with default blanks. No captured cell is edited.
Ego hard-wraps this paragraph with cursor moves: the second row is neither
soft-wrapped nor indented. It is retained as observed, not invented as a wrap.

The mounted regression uses this frame with fixture-only IPC and never connects
to a live TUIC instance.
The recorded intent is already classified at column zero before the fix;
the defect is that the painter discards intent blocks, not a missing prefix.
