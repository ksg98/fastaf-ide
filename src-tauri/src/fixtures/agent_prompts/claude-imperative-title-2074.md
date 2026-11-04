# Claude imperative AskUserQuestion title (#2074-b0dc)

Authentic Claude Code 2.1.286 / Haiku 4.5 output recorded on 2026-10-19
from an isolated Python-owned PTY in `~/Gits/.tmp/claude-2074-capture`.
The PTY was set with `TIOCSWINSZ` to 40 rows by 120 columns before Claude
rendered. The recorder writes TUICCAP2 records directly from PTY reads and
writes, with original direction, chunk boundaries and monotonic timestamps.
No output bytes or geometry were synthesized or replaced.

Launch: `claude --model haiku --dangerously-skip-permissions --settings
'{"disableAllHooks":true}' --strict-mcp-config --mcp-config
'{"mcpServers":{}}' -- <prompt>`. The prompt requests AskUserQuestion with
exact text `Pick a colour` (no question mark), header `Colour`, and options
Red, Green, Blue with descriptions. It forbids other tools and requests the
selected colour after the answer. The initial external-import prompt was
answered with Enter (disable imports).

The native form shows `Pick a colour`, five ordered choices (`Red`, `Green`,
`Blue`, `Type something.`, `Chat about this`) and the column-zero
`Enter to select · ↑/↓ to navigate · Esc to cancel` footer.
The recorded Down + Enter input selects Green; subsequent Claude output
prints `Green` and returns to the empty composer. This is native PTY evidence,
not evidence of a mobile UI tap or an HTTP response.

Source recorder and raw evidence: `~/Gits/.tmp/claude-2074-capture/`;
run log: `~/Gits/.tmp/results/fix-2074-capture-4.log`.
Fixture SHA-256: `8b543da0ce2306abea35757497d1c22581a359680dd8ad6fdba5763539e79b74`.
