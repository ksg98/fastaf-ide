# Hooked Claude dialog without a question badge

Observed on 2026-09-21 in md-2 / Story 131, session
`4343cc4e-3e15-4574-aabe-0bf2499760a2`. The screenshot and rendered terminal
showed a live selection dialog. The session API reported `awaiting_input=false`
and `agent_state=working`.

The `.raw` file is an unchanged 16,249-byte suffix of the binary PTY flight
recorder (`GET /sessions/{id}/raw-ring`), starting at its last OSC 7770 awaiting
marker. It contains that awaiting marker, fifteen later busy markers, and the
dialog repaint. SHA-256:
`07723ebc8e8e1fee462b2f81536cf7a25b6da1d532838148fd4c16b0c579fa17`.

Geometry was read from the live PTY with `stty -f /dev/ttys013 size`: 63 rows,
236 columns. The replay supplies those dimensions explicitly. Original read
boundaries, timestamps, and user input are unavailable in this flight recorder;
the test splits before the first busy marker after the notification to preserve
protocol order, then asserts the real session accumulator. It
does not claim to reproduce the original chunk timing.

The framed capture tap was enabled after the report, but the static dialog
emitted no new output. No option was selected and no command was submitted to
obtain this evidence. Capture was disabled afterward.

Targeted replay (from `src-tauri`, with Cargo routed through mbx):

```sh
cargo nextest run --lib -E 'test(hooked_dialog_capture)'
```

The replay checks restoration of the question badge, suppression of duplicate
notifications, recovery after a later awaiting/busy pair during a dialog redraw,
and clearing after the dialog disappears and protocol work resumes.

## Mobile question text (2026-09-26)

This real capture also limits what a phone alert can claim. The OSC 7770
`state=awaiting` marker carries no question text. The replay's recovered
`question_text` is the Ink dialog footer, not the dialog's question title.
The mobile push path therefore waits for a nonempty explicit `progress
type=blocked` report or a parsed choice title. A real AskUserQuestion title
still needs separate parser evidence and a phone check before it can be
reported as verified. Do not treat the hook marker alone as a deliverable
question, or spend the 30-second push limit on its empty text.
