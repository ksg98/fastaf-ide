# Controlled soft-wrap PTY recording

Recorded on 2026-10-17 from `/usr/bin/printf %s` through Python openpty, 8 rows x 24 columns, output postprocessing disabled. This is a controlled terminal-text reproduction, not an ego session.

SHA-256: `843de45dfeb027abb3041d2946419aece73a24962d4e5ae8ad34f7300730d14e`

Raw output (Python representation):

```text
'unrestricted filesystem access\r\nripetibile bloccante configurazione\r\nhard break'
```

At 24 columns, the space after filesystem occupies the final cell; trimming loses it. At 64 columns, ripetibile crosses the margin; inserting a separator splits the word. Hard CRLF boundaries must remain.

## Observed pre-fix output

At pre-fix `e33ca3ef28054fc40e0c9b68e5d4a3556d69cb7d`, Rust test `softwrap_1977_preserves_original_spaces_in_text_and_log` replayed this recording and failed:

```text
raw:  unrestricted filesystem access
text: unrestricted filesystemaccess
```

Command: `build-slot.sh --remote bash -c 'cd src-tauri && ../scripts/with-test-tmp.sh cargo nextest run -p tuic-terminal --lib -E "test(softwrap_1977)"'`. Exit 100; full log: `~/Gits/.tmp/tuic-1977-red.log`.

## Corpus replay declaration

The corpus replay declares `shell` for this controlled printf output; it is not an agent recording.
