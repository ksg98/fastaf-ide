# Recorded ego local transcript v1

Recorded on 2026-10-17 from the real ego binary built at `0821caee` on
`feat/ego-532-transcript-export`. The producer contract is
`docs/reference/transcript.md` in that ego checkout.

The exact recording command was:

```sh
EGO_CAPTURE_TRANSCRIPT=1 cargo test -p ego-cli --test transcript \
  transcript_contract_preserves_chat_goals_lineage_and_follow_cursor -- --nocapture
```

The command ran through the mbx shim and the machine build scheduler, with
`TMPDIR` under `~/Gits/.tmp/tuic-tests/`. The test creates its own scratch
`EGO_HOME`, scripted loopback provider and real CLI/tool processes; no paid or
external provider is used. `TRANSCRIPT_CAPTURE` in the test output is decoded
as a JSON string and saved here verbatim. No events were hand-written.

SHA-256: `8024e04e7919715e9ac5dfe26105a0918b738e1a380ad4f700210bb5f7f0a3e1`.

The fixture contains two snapshots with distinct headers: the root session
(prompt, tool lifecycle, answers and a system-owned goal continuation), then a
compaction successor (lineage and checkpoint). The consumer must reset before
feeding the successor. Repeated root exports are deduplicated by session-local
sequence. Completed answers are rendered once; preview deltas are omitted.

The live exact-bound terminal check, incremental SSE evidence and desktop/mobile
PDF rasters are recorded in `docs/backend/ego-chat-verification.md` at the
repository root. That check uses the same real 532 executable and published
format; it does not replace or modify this recorded fixture.
