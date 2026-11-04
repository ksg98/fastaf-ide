# Native Claude question fixture (2079-78fa)

The JSON is the unmodified `state` object from `GET /sessions` on an isolated,
worktree-built `tuic-remote` instance on 2026-10-19. The real Claude Code 2.1.286
process opened AskUserQuestion with **Pick a colour?**, Red, Green and Blue.
No synthetic terminal output or hand-written parser fixture was used.

Evidence directory: `/Users/stefano.straus/Gits/.tmp/results/feat-2079-live/`.
The session was `e4a60c79-1e14-4e1d-a99c-9b33b63fc442`. `native-before.json`
contains the complete REST response. `desktop-before-dom.txt` and
`mobile-chat-before-dom.txt` show that same open native question in desktop
PTY Chat and mobile Chat. `desktop-before.png` records the desktop component
in a worktree Vite page, not the installed desktop app.

The desktop Blue button invoked the production `TerminalChatView` handler.
`output-after.json` records `Pick a colour? → Blue` and `You picked Blue.`;
`native-after.json` records `awaiting_input: false` and no `choice_prompt`.
`desktop-after-dom.txt` has no native choice buttons. Vite, the named browser
session, the throwaway PTY and the headless backend were stopped after capture.

The Vite host mounted the real desktop component with the real lifecycle state.
It was not the full desktop shell or ACP AI Chat. A same-origin Vite proxy
connected it to the isolated headless backend; no Boss sessions were used.
The mobile page used the real MobileApp and SessionDetailScreen for the same PTY.

The original pre-fix audit remains in
`/Users/stefano.straus/Gits/.tmp/results/parity-2021-final/`, including
`desktop-claude-open-question-chat.json` and `claude-choice-chat-dom.txt`.
