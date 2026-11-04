# Claude AskUserQuestion dismissed with Esc

Claude Code 2.1.280 (haiku) in the disposable `ui-review-sandbox` session,
captured by the running TUICommander `/diagnostics/capture` tap on 2026-09-29.
The fixture preserves framed records 0–195, including the recorded 40×220
geometry, original input/output chunks, directions and monotonic timestamps.
The source capture is `3a3b033d-00f9-4293-94aa-d076ee813a73.tcap` (SHA-256
`06bf7bcd0f4c6d5c5bd6a1e13d637e63d9dc0a7f1ff29e80344a6ceb4250fba3`).
The fixture SHA-256 is
`3ef4c9b9e81ed0fd6ca6db60ee732844500a2a43d9881642250599ffaacd778a`.

Record 184 carries `Claude needs your permission`; record 185 is the single
Esc input byte. Record 188 renders `User declined to answer questions` and
`Worked for 4s · done` above the ready composer. Record 195 already paints the next human draft (`Run the shell command: sleep
25 && echo done. Then reply with one word.`) in the composer; its submitted
turn begins at record 196 and is excluded. Tests needing the empty ready
composer replay only records 0–194. Story 1420-f3de uses that recorded prefix
to protect late foreground discovery and quiet-screen reclassification. The regression test replays the source bytes
through the PTY chunk processor and the event-bus session-state accumulator.

## Mobile choice replay (#1212-3093)

The open dialog frame contains the title `Which color do you prefer?`, five
numbered options, and the column-zero `Enter to select` footer. The highlighted
`❯ 1. Red` row is a choice, not Claude's composer. Replaying the recorded
output into the mobile screen trim previously cut the screen at that row;
replaying it into the session-state accumulator left `choice_prompt` empty.
The two capture-backed tests now assert the complete visible dialog and a
`navigate-enter` choice contract with option 2 labeled `Green`.

## Shell state after Esc (#1302-83ae)

The recorded hook stream is `state=busy`, `state=busy`, `state=awaiting`, then
no `state=idle`: Claude sends no Stop hook when Esc dismisses the dialog. At
record 188 (`User declined to answer questions` over the ready composer) the
session still carries the mobile `choice_prompt`, so the decline branch must
not require it to be empty. The replay test asserts the shell state is idle
after the replay, with no hand-stored idle; it fails when the branch skips
sessions that hold a choice overlay.
