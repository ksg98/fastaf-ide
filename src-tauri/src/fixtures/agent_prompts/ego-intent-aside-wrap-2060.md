# Ego intent aside and wrapped title: native own-peer output

Parent-authorized read-only capture on 2026-10-19 of TUIC peer `1b66e748-b784-44e0-be47-9afcf45d35f0`.
The assistant deliberately emitted one native intent containing an earlier
`(local)` aside and a later title crossing physical rows, followed by ordinary
same-line prose. No peer input or production configuration writes occurred.

Source: `tuic mcp session action=output format=raw limit=65536`, after native idle.
Own ego PID 72707 remained on `/dev/ttys002`; read-only `stty size` observed
**63 rows, 222 columns**. Retained source-byte window:
**394261..459797**, **65536 bytes**.

This is a retained raw ring snapshot, not the original PTY tap read boundaries
or timestamps. TCAP2 framing contains one Output record at snapshot-relative
time zero with the observed geometry. No escape sequences, line breaks, spacing,
model text, missing bytes or timing information were synthesized. It verifies
final logical-line intent state; the isolated regression separately verifies
unfinished-title intermediate state. It is not the original Agent2 incident.

SHA-256: `a0ae9af868a908b96326294bf2f51fc042bab1996c4d3d6e4cfc516705d6c1ad`
