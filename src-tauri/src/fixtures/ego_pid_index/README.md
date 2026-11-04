# Ego PID index capture (2058-0d0e)

Captured on 2026-10-19 from a native terminal ego built from landed story-584
commit `9fdc2344`, exported into `~/Gits/.tmp/2058/ego-source` after the original
worktree was removed during landing. No installed executable was replaced.
The private PTY ran `ego --bare --no-tools` with an isolated `EGO_HOME` at
`~/Gits/.tmp/2058/terminal-home` and workspace `~/Gits/.tmp/2058/workspace`.
No model prompt was sent. The real process published these two files.

The live native nonblocking shared-lock probe returned `held` for PID 79469
and session `01a153b2-222c-7502-a899-3005064063dd`.
`~/Gits/.tmp/2058/native-lease-probe.json` retains that observation. The process
has stopped. The rb counting test replays the unmodified file bytes and holds
the equivalent kernel writer lock locally; it does not claim the Mac lock crosses
machines. Native TUIC test compilation failed in tauri-build because an mbx
materialized permission file was missing, so TUIC verification runs on rb.

- `pid.json` SHA-256: `2aa90929c1e533c82bf781e9f4a532a7be2408b90398799c3d6487b3ccf2699a`
- `lease.json` SHA-256: `159f7499bfa57834bcc082ec4d8dd1f40a5a12fa43a38727e2c5813e75fbbe25`
