# First narrow Codex /plan question — 2094-da19

## Capture provenance

- Recorded on 2026-10-20 from installed OpenAI Codex 0.163.0 in the isolated
  `make agent-test AGENT_TEST_INSTANCE=at-2094 AGENT_TEST_PORT=19994` runtime.
- Source revision: `6d9cdefc419e1962bcae596baeb148fb45dfab20` (pre-fix).
- Native PTY: `41e97e0b-e9e1-4ea7-bb73-2e6da43cffab`.
- Capture API: `/diagnostics/capture`, reached through the instance Unix socket.
  No request used Boss's application or port 9876.
- TUICCAP2 geometry: 41 rows by 36 columns. Capture was enabled after entering
  `/plan` and resizing the ready composer, before its first question request.
- Ordered records: 982; input records: 2.
- SHA-256: `6fff1d7b2decfe7e7b0768b673e097cc3c49b609237c7cea1d49224f3caf9f73`.
- The file is copied from the native capture, with no byte or timing edits.

## Recorded effect and oracle

The first `Pick a colour?` dialog has Red, Green, Blue and None of the above.
Answers and hints wrap in separate columns. The footer uses three rows. The
last native `state=idle` occurs at 37,601,515 microseconds, after the question
opens. The live API then reports Idle without choices on pre-fix code.

`captured_codex_first_plan_question_exports_choices` replays the actual ordered
input/output through ChunkProcessor and the shared SessionState accumulator.
It requires confident Input, all four clean labels and separate hints, including
persistence through the recorded delayed idle. Direct parser tests keep the
native counter/footer guards and reject departed or malformed dialogs.

The first exploratory session also reproduced the missing choices at 13 by 36.
Resizing that same unanswered dialog to 128 columns exported its choices without
asking again. The retained full-height capture makes the wrapped fourth answer
observable rather than inventing a choice hidden by viewport pagination.

The matching golden was generated with `scripts/replay-oracle.sh regenerate`
for this capture and its corpus manifest only. Other capture goldens are unchanged.
Local API snapshots, RED/GREEN logs and the later mobile answer round trip are
retained in `~/Gits/.tmp/results/fix-2094/`.
