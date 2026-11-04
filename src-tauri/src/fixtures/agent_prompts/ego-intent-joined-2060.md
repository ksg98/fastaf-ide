# Joined ego intent: read-only native output capture

Captured on 2026-10-19 from this task's real ego peer, TUIC session
`1b66e748-b784-44e0-be47-9afcf45d35f0`, through `tuic mcp session`
`action=output format=raw limit=65536` after native idle. No input was sent to
another peer and no application configuration was changed.

The parent authorized a scoped read-only capture because the original Agent2
incident has no retained TCAP. This peer's actual model output deliberately joins
`(Intent boundary)This sentence` to reproduce the same grammar violation.
The original incident is independently recorded in `src/dev/fixtures/ego-intent-2060.json`:
ego's stored AssistantMessage already contains `)Criteri` without a newline.

## Geometry and limits

`ps -p 72707 -o tty=` identified this peer's `/dev/ttys002`.
`stty -f /dev/ttys002 size` reported **63 rows, 222 columns** at capture time.
The retained raw source-byte window is **133333..198869** (65536 bytes).
It is framed as one output record with relative snapshot time zero.
**This is a ring snapshot, not a PTY-tap recording:** original read boundaries
and emission timestamps are unavailable, and bytes before this window are not
reconstructed. Use it to replay the title closure, not timing or early-screen state.
No escape codes, spacing, terminal rows or model text were synthesized.

SHA-256: `c85e45bdb039842380257cb6b30e931f4fea8ee1e2a4027a742df258fb96f92b`
