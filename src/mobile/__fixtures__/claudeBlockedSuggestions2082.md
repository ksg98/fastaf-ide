# Claude blocked report snapshot — 2082-f782

`claudeBlockedSuggestions2082.json` is the unmodified `GET /sessions` owner row from an isolated native headless backend at commit `112ace3f25e67efe02ae8ff2d609e804ea3c5a5a`.

- Recorded 2026-10-19 with installed Claude Code 2.1.286 / Haiku 4.5, 40 rows by 44 columns.
- After a settled Ready turn, Claude called the actual TUIC MCP `progress` tool with `type=blocked`, text `rb unreachable; need VPN back up`, through the worktree bridge and isolated `TUIC_SOCKET`.
- Claude then rendered an earlier prose question, a bold non-question countdown and `suggest: [ vpn su | rb è giù, aspetta | Mostra lo stato agenti ]`.
- The resulting authoritative snapshot has awaiting=true, confident=true, no native choice prompt and all three suggested actions. The UI regression asserts presentation, not the origin of awaiting.
- Before the fix, the actual worktree Vite mobile page showed Input and generic Yes/No but none of those actions.

Retained original evidence: `~/Gits/.tmp/results/fix-qchips-capture-6/` contains `after.json`, `screen.json`, `output.json`, `backend.log`, `mobile-dom.txt`, `mobile.png` and the genuine TCAP capture. MCP progress is out-of-band; a PTY-only replay cannot reproduce its SET, so the frontend test uses the real serialized state rather than inventing a PTY fixture. No TCAP is added to the committed parser corpus.
