# Recorded Codex answer paragraphs

Codex v0.162.1 produced this three-paragraph answer on 2026-10-13 in a throwaway PTY at 35 rows by 100 columns. `codex-answer-paragraphs-1872.json` records the source session, raw-byte SHA-256, final rows and full frame. The raw capture remains in `~/Gits/.tmp/results/1872/codex-raw.json`.

The unchanged raw bytes were replayed with `tuic-terminal::terminal_grid::TerminalGrid::new(35, 100, 10000)` on the Linux rb box. `process`, `screen_text_rows` and `serialize_full_frame` produced the recorded rows and wire frame. `answerRows` selects screen rows 18–22 without changing content, blank rows or wrap state.
