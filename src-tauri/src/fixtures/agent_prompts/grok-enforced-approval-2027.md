# Grok enforced command approval — 2027-7ef3

Captured 2026-10-18 from installed Grok Build 1.0.62, real TUIC session `3b8bd3e9-5463-4751-974c-880aa1e9a7a7`, 33 × 100, cwd `~/Gits/.tmp/fix-parity`. Launch used `--permission-mode default --no-alt-screen --reasoning-effort low`, not always-approve/bypass mode. The existing account was used; no credentials were copied or read by this peer.

The default policy had auto-executed an explicitly requested read-only Python print and deletion of a task-owned sentinel. Scoped permission inspection showed the only inherited allow rule from the global Claude settings was `WebSearch`; it did not grant shell execution. With coordinator authorization, a task-local `.claude/settings.local.json` supplied `permissions.ask = ["Bash", "run_shell_command"]`; Grok's inspect command reported those local rules loaded with none skipped. No global settings were changed. The enforced tool identified itself as `run_terminal_command` in its refusal result.

The prompt requested `python3 -c "print(123456789)"` through the real shell tool, not ask_user_question. Grok displayed its native five-option permission radio form with command, scope controls and option 3 selected. One numeric 4 immediately rejected the tool, without Enter. Grok confirmed `User rejected the execution for tool run_terminal_command` and canceled the turn. The command did not execute. The task-local override was removed after capture.

The first long recording hit the capture cap before the refusal, so it was replaced. This short capture was enabled for the already-open real approval, then a live resize to 33 rows forced a repaint. After 200 ms, one 4 refused the command; another 200 ms retained its settlement. Recorded initial geometry is 33 × 100. Original TCAP v2 input/output chunks and timestamps are unchanged. Capture source: `/Users/stefano.straus/Library/Application Support/com.tuic.commander/captures/3b8bd3e9-5463-4751-974c-880aa1e9a7a7.tcap`.

SHA-256: `68fc0b1472942a063af232133b22a52c331e13a210d096dc64c8c5460372d760`
