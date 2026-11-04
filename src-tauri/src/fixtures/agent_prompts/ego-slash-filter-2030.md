# Ego slash menu filtering capture

- Source: installed `/Users/stefano.straus/.local/bin/ego`, startup reports ego 0.1.0.
- Recorded on 2026-10-18 by fix-2030 through a disposable native Python PTY.
- Geometry: 41 rows, 128 columns, xterm-256color.
- Format: TUICCAP2, actual output read chunks and input writes with monotonic microsecond timestamps.
- SHA-256: `5a36ff273707ede6d3ebcabd938e2d6d97a7801518d0dd0b6c7ed6ae8bf6355a`.
- Input: `/`, `g`, `o`, `a`, `l`, four Backspaces, then `zzz`.
- Cursor position queries receive `ESC[1;1R`; these terminal replies are input records, not composer edits.
- No prompt was submitted and no model turn was run in this capture.

The broad `/` menu becomes exactly one `/goal` row at `/g`, `/go`, and `/goa`.
At the exact `/goal` spelling, ego closes completion and returns to its normal
composer. Later Backspaces and unmatched text do not leave menu rows on screen.
This proves that filtering already works in ego while idle. The capture does
not establish busy-turn or browser behavior.

Independent evidence: a disposable session created through TUIC's session MCP
surface also painted only `/goal` after raw `/` then `go` writes. Browser
verification could not proceed: the real HTTP backend showed its login form.
No credential store was read.

## Live worktree verification, 2026-10-19

The continuation merged main at 0891eafeef, then built the native debug
`tuic-remote` through build-slot and mbx (3m03s). No desktop instance was
started. An isolated HOME under the evidence directory kept configuration
and the debug file-backed vault separate from the installed app. A temporary
pairing token authenticated only this daemon. Worktree Vite on 14230 proxied
the daemon on 12031, preserving Host and Origin. No existing credentials
were read by the verifier.

The mandated ab-stealth wrapper used the single named session
`fix2030-verify` at 1180×820. All screenshots, snapshots, backend responses
and DOM measurements are under:
`/Users/stefano.straus/Gits/.tmp/results/2030-84bb/`.

| Case | Observation | Evidence files |
| --- | --- | --- |
| Real ego 0.1.1, idle, `/go` | Exactly one dropup command, `/goal`; its box is x=0, y=643, width=1180, height=34 | `idle-go.png`, `idle-go-snapshot.txt`, `idle-go-state.json`, `idle-go-dom.json` |
| Real ego 0.1.1, running turn, `/go` | Same one-command box; backend reports agent_state=working, shell_state=busy, and only `/goal` in slash_menu_items | `busy-go.png`, `busy-go-snapshot.txt`, `busy-go-state.json`, `busy-go-dom.json` |
| Zero matches `/gz`, exact `/goal` | No Commands header or Close slash menu button remains | `idle-zero-snapshot.txt`, `idle-exact-snapshot.txt` |
| Claude Code 2.1.286, `/` then `/he` | Broad list is replaced by Claude's fuzzy results, led by `/help`, rather than retained | `claude-broad-snapshot.txt`, `claude-he.png`, `claude-he-state.json`, `claude-he-dom.json` |
| Codex 0.162.1, `/sta` | Terminal paints `/status` and `/statusline`, but backend has no slash_menu_items and DOM has no dropup | `codex-sta.png`, `codex-sta-screen.json`, `codex-sta-state.json`, `codex-sta-dom.json` |

The Codex layout puts completion above the composer/status line and uses a
`›` marker. The parser's bottom-block scan and `❯` regex on main have the
same limitation. This is not evidence of a regression from the ego fix, but
it prevents checking the combined Claude/Codex acceptance criterion.
The source has a dated deferred note; no Codex compatibility fix is claimed.
The screenshots require coordinator pixel review; this verifier checked DOM
and backend state, not image contents.

All disposable PTY sessions were deleted. The named browser tab and its
agent-browser session were closed, and owned backend/Vite process groups
were stopped. The installed desktop was not restarted.

Post-merge targeted rb validation passed 19/19 (exit 0):
`build-slot.sh --remote /bin/bash -c 'scripts/with-test-tmp.sh cargo nextest run --manifest-path src-tauri/Cargo.toml -p tuic-terminal -p tuicommander --lib -E "test(slash_menu) | test(recorded_ego_slash_filter) | test(chunk_path_scenarios_emit_the_same_events)"'`.
Compilation took 11m57s; tests took 0.120s. Log: `merged-green.log`.
No TypeScript source changed. The instruction-link check, changed-file
format check and `git diff --check` also passed.
