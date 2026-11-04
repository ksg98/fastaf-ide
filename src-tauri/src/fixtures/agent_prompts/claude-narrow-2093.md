# Claude narrow AskUserQuestion — 2093-0be6

Recorded on 2026-10-20 from installed Claude Code v2.1.304 in the authorized
`at-2093` agent-test instance, through its own Unix socket. Production source
was unchanged at `8099e712d7d0e06afb6cc741e73bf82d3219bb39`.

The TUICCAP2 header records **14 rows × 37 columns**. The spawn request asked
for 24 rows, but the isolated desktop resized the PTY before its first output.
The regression uses the recorded geometry, not the requested geometry.
Capture started before launch and stopped before any explicit comparison resize.
Input records include the Enter that declined external instruction imports;
they do not include an answer to the colour question.

The final native form shows `Pick a colour?`, `1. Red`, a down-arrow-prefixed
`2. Green`, and the separate `5. Chat about this` row. Intermediate choices are
not visible. The original backend reports confident awaiting with no exported
choices or title. Resizing the same live form to 41×128 exports Red, Green,
Blue, Type something., and Chat about this.

The pipeline regression requires explicit previous/next/select navigation, not
an invented complete list. Derived parser cases check a scrolled-off first
option, an arrow-less native Chat boundary, and indented quoted footers. Existing
complete-form and imperative-title tests protect ordered named choices.

Live evidence is retained under `~/Gits/.tmp/results/fix-2093/`. The final mobile
round trip selects Blue through two Next taps and one Select tap. Native output
confirms `User answered … Pick a colour? → Blue` and `PARITY_2093_DONE Blue`;
awaiting retracts. The live answer capture includes explicit geometry changes
and is diagnostic evidence, not a fixed-geometry replay fixture. Its decoded
input list proves exactly two Down keys and one Enter.

Only this fixed-geometry capture and its replay oracle are committed.

Capture SHA-256:
`4b13e8b4abff2cb7ff3b7f99b5dade9a308277c88d86a5bb5336e1a064da78b7`.
