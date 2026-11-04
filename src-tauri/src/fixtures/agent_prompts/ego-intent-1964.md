# Real ego second-intent capture (1964-b32e)

Source: installed ego 0.1.0, recorded on macOS on 2026-10-16 through an owned
Python openpty recorder. Geometry: 24 rows by 80 columns.
Producer: `/Users/stefano.straus/.local/bin/ego`.
Producer SHA-256: `fcc5ccccd8afe2b4383132c633775f554fddcd5d34cee6fb51a89d3a7432006c`.
Capture SHA-256: `5f23656c7fe9bc789e5b5d286233efe6051c178d3453e7a8fa9406f1ab6b55cb`.

The recorder starts a loopback Anthropic Messages SSE stub and a real interactive
ego process with `--bare --offline --sandbox off --no-tools --thinking low
-m anthropic/claude-opus-5-5`. HOME, EGO_HOME, cwd and TMPDIR are isolated under
this worktree's `.tmp/ego-1964`. The fixture key is not a credential.
TUIC_SOCKET selects the TUIC marker profile without accessing any live daemon.
The stub returns two distinct intent sentences on two submitted turns; the
second wraps naturally at 80 columns. The recorder answers cursor-position
queries from tracked terminal cursor movement, not from a constant coordinate.
TUICCAP2 preserves original output/input chunks and monotonic timestamps.
No output bytes are edited or fabricated. The child is killed and reaped and
the loopback server is shut down. No paid provider or Boss session is used.

The recording contains native automatic prompt intents as well as the actual
assistant intent sentences. The regression must end with the latest assistant
intent, not the automatic prompt intent. This is important evidence, not noise
to remove from the fixture.
