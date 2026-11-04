# Claude mobile resume picker, 1971-5834

Recorded on 2026-10-17 from Claude Code 2.1.286 in an isolated native macOS
headless TUICommander built from this worktree. No production TUIC session was
used. The backend used port 19871 and an isolated HOME under
`~/Gits/.tmp/mp-home`; the worktree mobile client used Vite on port 19872,
with an 820 by 1180 viewport.

Capture source: the `/diagnostics/capture` tap for throwaway PTY
`ab4f10c5-09b8-4da2-84d8-b74b481b1971`, started before PTY creation. Its
TUICCAP2 header records geometry 41 by 110. The fixture is the unmodified
capture file, SHA-256
`eccd95ccdb99da0d7891f697e3e73c72dc6bdaf17b2809cad862200439c007a3`.
It retains original input/output directions, chunk boundaries and timestamps.

Own conversations were seeded with a test AskUserQuestion and a short text
reply, then `/clear` started a new conversation. `/resume` displayed
`Mobile resume seed` and `Test color selection question` in the real terminal.
The highlighted session starts with `❯`; the Search field has a box-drawing
bottom border. The log-output trim treated those rows as composer chrome and
removed the session list. Typing `z` produced the recorded no-matches search
state with its `Esc to clear` footer.

`captured_claude_mobile_resume_survives_screen_trim` replays this capture into
the production VT log buffer at its recorded geometry. It checks complete
modal frames through both the initial-screen cutoff and log-WebSocket poll,
and verifies that the parser cutoff remains unchanged. It also combines the
recorded dialog and recorded ready composer to ensure retained modal text
cannot disable trimming after dismissal.

Related independent wire evidence is in `docs/evidence/mobile-resume-1971/`.
The first wire snapshot came from an earlier throwaway PTY with the same
geometry and own session titles. Its full grid contains the list while its
log-screen response stops at the Search field.
