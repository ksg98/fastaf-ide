# Real ego clean lifecycle capture

Recorded on Linux rb on 2026-10-16 with the real ego producer binary at
`/home/rb/src/ego-76ec1c81-slot0/target/debug/ego` (producer source `3c1bbfb3`,
as in ego-provider-recovery-1902.md). No TUIC desktop or paid provider was used.

SHA-256: `a5f6dfbc1f4058613b7173a5ff9a2b81e961f8a6be92d3d721d9f01ea1da7a21`.
The 1450 captured bytes are unchanged. Geometry: 24 rows, 100 columns.

Recorder: the original `/home/rb/Gits/.tmp/1902-record.py`, adapted in memory
by `~/Gits/.tmp/fix-1902-record-clean.py`. The loopback Anthropic stub starts
its request counter at one, so the first actual request succeeds rather than
returning an outage. Argv: `ego -m anthropic/claude-opus-5-5 --thinking low
--bare --sandbox off --no-tools 'Capture a normal successful turn without
provider recovery.'`. HOME/EGO_HOME and cwd are isolated below
`/home/rb/Gits/.tmp/1902-clean-lifecycle-capture`. The fixture key is not a
credential. TUIC_SOCKET selects the real TUIC output profile without connecting
to a live daemon. The recorder uses openpty, real monotonic read timestamps,
original chunks and cursor-position responses; no output bytes are invented.

Observed: one actual successful provider request (counter ends at two), native
OSC 7770 lifecycle state markers, and zero ego-recovery frames. Recording ends
after idle; the idle process required SIGKILL after bounded SIGTERM, as the
original capture did. The recorder stops its provider server and child process.
Evidence: `~/Gits/.tmp/fix-1902-clean-record.log`.

Regression: normal busy/idle markers must not emit provider-recovery(null) when
no recovery was active. The unchanged Claude captures remain the original RED
oracles; this new real ego recording covers the native producer's normal path.
