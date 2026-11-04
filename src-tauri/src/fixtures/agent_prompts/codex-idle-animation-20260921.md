# Codex idle animation regression

Captured on 2026-09-21 from the idle Codex terminal in brainstorming with
`POST /diagnostics/capture`. The `.tcap` is the unchanged capture: 635 output
records, 40 rows, 111 columns. Capture was stopped after recording.

Runtime evidence: session `ef8168c8-fbc0-4181-b4ee-aa1877754789` displayed its
completed response and ready composer while the session API reported working.
The log recorded `hook-idle` (Protocol) at timestamp 1789977669705, followed by
`spinner-active` (Screen) at 1789977670003. An earlier completion at
1789977488060 was followed by `real-activity` at 1789977488061.

The capture starts during the subsequent idle animation. It does not contain
the completion hook or an initial full-screen snapshot. The regression test
therefore seeds the observed hook-idle boundary explicitly and replays every
captured output record through `ChunkProcessor`. It asserts the shell state and
retained protocol evidence after each record, then submits a new turn to check
that idle is not latched. A separate test covers ready-timer rank preservation.
