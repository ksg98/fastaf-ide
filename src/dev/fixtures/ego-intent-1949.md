# Recorded soft-wrapped ego intent cells

Recorded on 2026-10-16 from a throwaway 80-column, 24-row PTY running
`~/.local/bin/ego`, rebuilt from ego master with producer fix `e5ec2479`
(story 504-d187). The JSON records the binary SHA-256 and PTY identity.

The provider was a scripted Anthropic SSE server bound to loopback. Ego ran
with `--bare --offline --sandbox off --no-tools --thinking off` and an isolated
`HOME` and `EGO_HOME` under `~/Gits/.tmp/1949-ego-home`. No paid API was called.
The scripted response was:

```text
intent: Recording the real ego marker rendering for regression coverage (Intent fixture)

Ordinary output stays outside the intent tint.
```

The capture uses read-only `terminal_styled_rows` IPC, as in the 1948 fixture.
Absolute rows 53–56 are unchanged 11-byte styled cells. The owned full-frame
envelope moves them to rows 0–3 and pads the rest of a 24-row viewport with
blank cells. It preserves all captured cells and row flags: row 53 has wire
count `0x8050` (80 columns and the soft-wrap flag); row 54 has `0x0050`.
The blank separator and ordinary output are retained to test the tint boundary.
The throwaway PTY was closed after capture. No existing terminal was changed.

This differs from `ego-intent-1948.json`, which retains the old producer's
hard-wrapped row with no wrap flag. Keep that fixture unchanged: its separate
test checks the first-row tint without pretending the old producer supplied
continuation evidence.

The mounted regression `tints both recorded ego intent rows and stops before
ordinary output` now passes without a TUIC classifier or painter change.
The fix is in the ego producer, not a guessed frontend continuation rule.
