# Real ego composer capture (1957-38c1)

Source: an isolated real ego 0.1.0 process on macOS, recorded on 2026-10-16.
Producer: `/Users/stefano.straus/.local/bin/ego`.
Producer SHA-256: `fcc5ccccd8afe2b4383132c633775f554fddcd5d34cee6fb51a89d3a7432006c`.
Capture SHA-256: `c397dccd7cdbe7d0fdf0475cf7b85fee233347f8bfd6f624a0708d3870a8b283`.

The recorder ran under this worktree's `.tmp/`. HOME, EGO_HOME, TMPDIR and cwd
were isolated there. The process used `--bare --offline --sandbox off --no-tools
--thinking low -m anthropic/claude-opus-5-5`. A loopback HTTP stub returned one
Anthropic Messages text response, `Recorded accepted Enter.`; its fixture API
key is not a credential. No paid provider, live TUIC session, desktop instance,
production configuration or credential store was accessed.

The recording preserves TUICCAP2 geometry (24 rows, 100 columns), monotonic
record timestamps, original output chunks and input records. The recorder
answered cursor-position requests with `ESC[1;1R`, waited until the real
initial empty composer was painted, then typed `captured draft`. It left the
draft unsubmitted for one second, sent CR and recorded four more seconds.
The initial recording used a two-second setup wait, but ego painted its first
composer at about 2.8 seconds. GREEN correctly rejected that phase ordering.
This replacement recording waits on the observed initial composer instead of
a fixed setup delay; no phase assertion was removed or relaxed. The child was killed and reaped; the loopback stub was stopped.
No producer output bytes were invented or edited.

Observed phases: an empty `>` composer under the model/context/trust status
row; `> captured draft` with the same status row; a `Working` row and empty
composer after Enter; native busy/idle OSC markers; the stub's answer; and a
final empty composer under the model/context/trust row. This records composer
semantics, not the historical backend stall. The isolated full-pipe regressions
separately prove blocked-writer behavior.

Recorder retained during this task: `.tmp/record-ego-1957.py`.
