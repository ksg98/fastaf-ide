# Claude verbose consecutive tool capture

Recorded 2026-10-21 from Claude Code 2.1.306, Sonnet 5.5, with `--verbose` in an owned isolated agent-test PTY. Three sequential Bash calls each print 250 numbered rows; each is followed by a Write of a 30-line Markdown file in the scratch repository. Hooks and MCP were disabled. Geometry: 41 rows, 128 columns. Recorder, owned process argv, canonical terminal lines, HTTP snapshots and browser DOM are retained under `~/Gits/.tmp/results/tuic-b6-2109-verbose/` and `tuic-b6-capture-verbose.py`. Input and output records are unmodified.

SHA-256: `b46805d08899b7915f2011780415cfc2dacda41192cd6a01331d16adf3519dfe`

The final canonical terminal has all six tool headers. The live mobile view exercised its 500-line prefix eviction. This capture does not establish the reported missing-middle-header regression.
