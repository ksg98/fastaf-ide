# Claude generic notification after a ready turn

`claude-ready-idle-notify.tcap` contains 12 unchanged framed records (indices
675–686) extracted from a live `TUICCAP1` capture. The source capture SHA-256
was `394d3f6f0b9f16e305c6e83855432de09b8bf6d4a1b9d9b0ffcedca1be8e3229`;
the fixture SHA-256 is
`cf84642badf9e1187c343139155db2e537a6b93102ad0b9bcb8184791f0dab0e`.
Original record payloads, boundaries, directions and timestamps are preserved.

The captured Claude reply ends with a prose question, emits `suggest:`, then
shows `✻ Crunched for 28s · done` and the ready `❯` composer. Later it emits
`OSC 777;notify;Claude Code;Claude is waiting for your input`. No dialog is
opened in these records.

`claude-ready-idle-notify-statement.tcap` preserves records 1291–1310 from a
second live `TUICCAP1` capture. Its source SHA-256 was
`820fc97a12c2dae70ee92111dad87167a1b893dc88485f052102fe8826a9056a`;
the fixture SHA-256 is
`365c1afa4b264dcd452c054a6f8dd43d65ea32754b3123b2ec2a1428eb88f71b`.
This reply ends in a statement before `✻ Brewed for 10m 15s · done`, the ready
composer and the same OSC notification. Original records are unchanged.

Both source captures lack geometry metadata and these excerpts begin inside
longer PTY streams. They prove notification ordering and parser output, not a
complete screen layout. The adjacent PTY state test covers both prose endings
against a rendered ready composer.
