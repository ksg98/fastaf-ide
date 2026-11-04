# Installed ego transcript capture

`installed-2026-10-19.jsonl` is the verbatim public export retained in
`~/Gits/.tmp/results/live-2032/ego-export.jsonl` on 2026-10-19. The live
probe session is `01a152f2-3bd3-7175-90dd-13580205b9c9`. Its real CLI
completed the answer `LIVE_A_CHAT_OK`; the header is transcript v1 with
public event version 15. No events were synthesized.

SHA-256: `1e70eb4c0210c299e4604d111560174e5841d8ee9220cc358edfdb414735682f`.

The recorded desktop check on TUIC `aa8992ad8a` enabled Chat, bound this
session, then returned to CLI with `ego transcript v1 header missing`.
The recorded bytes are valid. A follow-up CLI probe showed why they were
not the bytes TUIC received: Settings selected `/Users/stefano.straus/bin/ego`,
not the installed `/Users/stefano.straus/.local/bin/ego` used for the export.
The configured binary refused the exact request:

```text
ego export 01a152f2-3bd3-7175-90dd-13580205b9c9 --format transcript --after 0
exit 2; stdout empty
εgo: error: unexpected argument '--after' found
```

The regression replays the fixture through `ExportSource::read` and
`EgoAdapter`, using a file-replay executable, not a fabricated ego stream.
A separate failed-process test catches masking an incompatible executable
as a transcript header error. The capture does not prove a parser defect
or post-fix desktop recovery. Selecting a transcript-capable executable in
Settings is still required; no configuration or installed binary was changed.
