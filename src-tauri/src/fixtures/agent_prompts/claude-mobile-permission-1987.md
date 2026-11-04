# Claude mobile Bash permission dialog, 1987-606c

Source: Claude Code 2.1.286 with `--permission-mode default` in an owned
Python PTY, recorded on 2026-10-17 at 41 rows by 80 columns. The scratch
repository was `~/Gits/.tmp/mobile-b/scratch`. No production session was used.
The user input requests `touch mobile-permission-proof.txt`. Recording stops
with the permission dialog open; the command was not approved.

The recorder writes TUICCAP2 records directly from PTY reads and input
writes, with monotonic microsecond timestamps and the PTY geometry. Bytes
and read boundaries are unchanged. SHA-256:
`0378eca006103b01a3a299811cf6ea4daeb4cda7663ad862b5012ffac77d7f96`.

The regression requires the question, all four options, and the
`Esc to cancel · Tab to amend` footer in the real VT grid, then checks that
initial HTTP trimming and log-WebSocket polling preserve each row.
