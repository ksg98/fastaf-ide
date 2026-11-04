# Ego completion: zero matches and reopening

- Source: installed `/Users/stefano.straus/.local/bin/ego`, startup reports ego 0.1.0.
- Recorded on 2026-10-18 by fix-2030 through a disposable native Python PTY.
- Geometry: 41 rows, 128 columns, xterm-256color.
- Format: TUICCAP2, actual output read chunks and input writes with monotonic microsecond timestamps.
- SHA-256: `a6662a882d151139bc4c98203145ffc495d1cddb36f03051388443407418ef24`.
- Input: `/`, `g`, `z`, Ctrl+U, `/`, `g`, `o`.
- Cursor-position queries receive `ESC[1;1R`, recorded as input.
- No command was submitted and no model turn was run.

The completion menu narrows from the broad list to `/goal` at `/g`, then
closes when `/gz` has no matches. Ctrl+U clears the composer. A new `/`
opens the broad list, and `/go` again shows only `/goal`. This capture
supplements the earlier exact-command capture and verifies that menu
retraction does not prevent subsequent completion.
