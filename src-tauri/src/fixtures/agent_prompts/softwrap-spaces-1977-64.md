# Controlled soft-wrap PTY recording

Recorded on 2026-10-17 from `/usr/bin/printf %s` through Python openpty, 8 rows x 64 columns, output postprocessing disabled. This is a controlled terminal-text reproduction, not an ego session.

SHA-256: `94a3c538fd007d2edb1effa3c3f599303b5a11d11c0e79b92afce42769e2ed78`

Raw output (Python representation):

```text
'The terminal preserves every original byte when printing ripetibile bloccante configurazione without guessing separators.\r\nhard break'
```

At 24 columns, the space after filesystem occupies the final cell; trimming loses it. At 64 columns, ripetibile crosses the margin; inserting a separator splits the word. Hard CRLF boundaries must remain.

## Observed pre-fix output

The exact pre-fix `logLine.ts` from `e33ca3ef28054fc40e0c9b68e5d4a3556d69cb7d` was loaded as a temporary Vitest module. The test reconstructed the ASCII physical rows from this recording at 64 columns, with the original backend trailing-padding trim, then called that module's `reflowDisplayLines`. It failed:

```text
raw:  The terminal preserves every original byte when printing ripetibile bloccante configurazione without guessing separators.
text: The terminal preserves every original byte when printing ripetib ile bloccante configurazione without guessing separators.
```

The explicit `hard break` remained on the next line. Command: `build-slot.sh scripts/with-test-tmp.sh pnpm vitest run src/mobile/__tests__/softwrap1977PreFix.test.ts`. Exit 1; full log: `~/Gits/.tmp/tuic-1977-midword-red.log`. The temporary module and test were removed after the RED run. The permanent recording regression is in `logLine.test.ts` and passes against the fix.

## Consumer audit

- `TerminalGrid::read_screen_text` and `row_to_text`: cached screen snapshots, changed-row parsing, row/range text, search context and rewind inspection.
- `TerminalGrid::extract_log_line`: finalized history, current screen log rows, MCP output and redaction, HTTP log reads, log/text WebSockets, and desktop `read_vt_log` IPC.
- `get_selection_text` and `get_logical_line`: copied selection and logical-line lookup. Selection now retains wrapped margin content too.
- `pty.rs`: ego question parsing receives soft-wrapped logical rows reconstructed from grid metadata; the ego footer matcher itself is unchanged. This overlaps tuic-1973 only at the parser call in `pty.rs`, not its footer implementation.
- `mobile/utils/logLine.ts`: mobile CLI reflow and retained-screen row equality use the serialized `wrapped` field. Existing heuristic behavior remains only when an older daemon omitted the field.
- `chat_view/mod.rs`: Chat explicitly reads transcript files and never reads the grid. Its desktop and mobile contract suites were checked as unchanged consumers.

## Corpus replay declaration

The corpus replay declares `shell` for this controlled printf output; it is not an agent recording.
