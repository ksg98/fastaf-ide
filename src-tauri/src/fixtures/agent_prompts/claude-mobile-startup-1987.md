# Claude mobile startup dialogs, 1987-606c

Source: Claude Code 2.1.286 in an owned Python PTY, recorded on 2026-10-17
at 41 rows by 80 columns. The scratch repository was
`~/Gits/.tmp/mobile-b/scratch`. It imported an owned external Markdown file.
No production TUIC session was used. The capture contains the real trust
and external-import dialogs, followed by the ready composer.

The recorder writes TUICCAP2 records directly from PTY reads and input
writes, with monotonic microsecond timestamps and the PTY geometry. Bytes
and read boundaries are unchanged. SHA-256:
`4e9b89adfa153ff377dc3f7adece1cf1080d0e96f1d99c217443ba17959ac21e`.

The mobile trim regressions replay the captured stream through VtLogBuffer,
then check initial HTTP trimming and log-WebSocket polling. Each test requires
all expected dialog rows to exist in the real grid before checking either
presentation path. A ready composer below retained dialog rows must still trim.
