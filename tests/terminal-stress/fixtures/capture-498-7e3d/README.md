# Capture: partial row immediately followed by its extension (#498-7e3d)

The artifact story #498-7e3d asked for and never got: the raw ring, the
dimensions, and the canonical rows of an occurrence, captured together while the
session was still live. Taken with `capture.py` from a real PTY session on a
headless build, driven by the `reflow` producer.

| file | what it is |
|---|---|
| `raw.bin` | the raw ring at capture time — the bytes that produced the rows |
| `canonical.txt` | the canonical grid rows those bytes produced |
| `meta.json` | dimensions (12 screen lines, 84 total), scroll state, timestamps |

## What it shows

Rows alternate between a partial record and its complete extension:

```
REC-0001:
REC-0001:abcdefghijklmnopqrstuvwxyz0123456789
REC-0002:a
REC-0002:abcdefghijklmnopqrstuvwxyz0123456789
```

That is the reported shape — a partial row *immediately* followed by its own
complete extension in canonical history.

## Why it is not a bug

The producer really wrote both rows. The partial is committed with its own
newline before the complete one is written, so nothing could rewrite it: a
carriage return only reaches the current line. A real terminal keeps both, and so
must TUIC — deduplicating them would silently discard genuine output whenever an
application legitimately prints a repeated prefix.

The grid manufactured nothing: across every scenario, each complete record
appears exactly once. `reflow` additionally holds this while the viewport is
resized underneath the writer, which rules out reflow as a duplicator; the
`scrollout` scenario covers the related case where the partial has already
scrolled out of the viewport before the rewrite is attempted (there the two rows
end up separated by intervening output, not adjacent).

## Sanitization

Shell-startup and command-echo rows trimmed, home paths and the shell prompt
redacted. The payload is synthetic `REC-NNNN` data — no repository secrets,
credentials or user prompts, per the suite's fixture rule.
