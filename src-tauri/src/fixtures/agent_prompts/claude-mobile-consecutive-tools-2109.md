# Claude consecutive tool capture

Recorded 2026-10-21 from Claude Code 2.1.304, Haiku 5.5, in an owned isolated agent-test PTY in a scratch repository. The capture wrapper is retained at `~/Gits/.tmp/results/tuic-b6-capture-claude.py`; process and argv evidence is in `tuic-b6-2109-live/owned-claude.json`. Hooks and MCP were disabled. The CLI ran three Bash commands producing 150 numbered rows followed by Write calls creating 40-line Markdown files. Geometry: 41 rows, 128 columns. Input and output records are unmodified.

SHA-256: `8e0937aea0c948bd910b545aa09427bf0789e160338a61c9a2c1a19dcfbb3ce3`

This capture does not by itself reproduce the reported stale-header symptom. It is the real-agent input for the mobile transport boundary check.
