# Claude resize capture — 1407-1ab2

Recorded from Claude Code 2.1.286 (real Ink PTY, Sonnet over OpenRouter)
on 2026-10-07 using isolated headless TUICommander build c0b28fd0e4332c36ea81e3f09b9ffd5ae18368e26a827a902acf40f5485c469a.
Initial geometry: 24 rows, 120 columns. The prompt requests twenty invented
planet descriptions with unique R1407-001 through R1407-020 markers.
The assistant transcript contains each marker once.

The streaming capture widens 120 -> 160 while the answer is streaming,
then narrows to 60 and returns to 120. Before the fix, the terminal lines API
contains R1407-009 through R1407-018 twice. The idle capture resizes after the
answer finishes and also duplicates markers in history.

Each resize timeline is [cumulative output bytes, rows, columns], recorded
from the flushed capture file immediately before the resize API call.
Input records are kept as recorded, but are not fed to the output parser.
The final streaming resize is at EOF: its reflow is observed without a
subsequent child repaint. Capture bytes and geometry are unmodified.
No authentication headers or environment variables are in the PTY stream.
