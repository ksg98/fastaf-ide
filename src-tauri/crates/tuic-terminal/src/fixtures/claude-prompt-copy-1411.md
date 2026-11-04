# Claude prompt copy capture

Captured on 2026-10-03 from Claude Code v2.1.286, TUIC session
`584073f6-e831-4379-903e-4ca345704390`, using
`GET /sessions/{id}/terminal/lines?start=0&end=2000`, rows 6–8.
The adjacent header identifies the Claude version. The text fixture contains
these three actual grid rows, without ANSI or terminal padding.

Only the first `❯ ` is composer chrome. The second glyph is pasted content.
The first long row wraps into `codice`; the short second row proves that the
third row begins a separate typed line. Remove exactly two continuation
margin columns, retaining the third row's remaining two content spaces.

The fixture is replayed at 148 columns; this width accommodates the recorded
142-column first row with Claude's right margin. The snapshot endpoint did
not report the original terminal width.
