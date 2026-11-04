# Claude question exit capture (2091-ba03)

- Source: real Claude Code v2.1.304 in isolated `make agent-test AGENT_TEST_INSTANCE=at-2091 AGENT_TEST_PORT=19884`, recorded through its Unix socket on 2026-10-20.
- Backend commit: `8f168401f1f06cac1fa4f699406a7d0b3ed62701` (main-based, includes 2089).
- Geometry: 41 rows, 128 columns, recorded in TCAP v2.
- Capture: `claude-question-exit-2091.tcap`.
- SHA-256: `4190f910515bdd0b5f949b5d2860ed125fe0aabccf65061b65666f57984bb9a8`.
- Session: `9601eb67-8d26-47a1-8ecb-df12c41c447b`.

Claude used its existing login and opened a real AskUserQuestion with Yes/No options. SIGTERM was sent only to the recorded Claude PID 66937 started for this check. Claude printed its resume message and returned to zsh. The repository's `sendCommand` then submitted `printf 'POST_EXIT_2091\n'`.

The shell ran the command, but the backend reported `awaiting_input=true`, `question_text=Enter to select · ↑/↓ to navigate · Esc to cancel`, and no `agent_type`. The old footer was still visible above the shell prompt. Local API snapshots and logs are in `~/Gits/.tmp/results/fix-2091/` (the `second` files).

The replay applies the real foreground-observation seam when the recorded shell command begins. Process identity is not present in TCAP; the corresponding live API snapshot proves the shell observation. All terminal bytes and input records come from the capture. Capture was enabled before session creation so the initial output records nonzero geometry.

An earlier local-only run reproduced the same symptom, but capture started with input and recorded zero geometry. The first replay failed on that setup precondition, not the defect. That file is not committed.
