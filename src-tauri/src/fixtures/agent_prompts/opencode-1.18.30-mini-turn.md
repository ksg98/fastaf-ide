# OpenCode 1.18.30 `--mini` turns

Source: TUICCAP2 captures recorded on 2026-10-01 through `/diagnostics/capture` on a headless `tuic-remote --instance` launched from the story 1299-3ce1 worktree. OpenCode was spawned through `POST /sessions/agent` (`agent_hook_launch` adds `--mini`).

- `opencode-1.18.30-mini-turn.tcap`: 120x40. Startup, a typed prompt submitted with a separate CR, a one-shot answer, the finished turn.
- `opencode-1.18.30-mini-narrow-tool-turn.tcap`: 64x30. Same flow with a `bash` tool phase (`sleep 8`). At this width the status row loses its `ctrl+p cmd` hint.

The interface has no composer frame. Its fixed element is the status row at the bottom: ` BUILD`, then a progress bar plus `esc interrupt` while a turn runs, then context usage and `ctrl+p cmd` when the width allows.
