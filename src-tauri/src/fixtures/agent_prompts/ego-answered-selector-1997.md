# Ego answered selector and ordinary next submission

Captured 2026-10-17 from installed `/Users/stefano.straus/.local/bin/ego` (ego 0.1.0) in an owned Python PTY, 12 rows by 120 columns, with an isolated HOME/EGO_HOME/workspace under `~/Gits/.tmp/ego-qsound/single-120-short`. Provider: OpenRouter, openai/gpt-6.1-sol. Only `ask_question` was offered.

The initial prompt requests a single-answer release-check selector. The harness answers `1` plus Enter, waits for protocol idle, then submits `Reply only OK, no question.`. Cursor-position queries are answered from the harness terminal cursor tracker. The recording preserves original reads, monotonic timings, input and output bytes; no terminal output was fabricated. The owned ego process was stopped after the next turn. No Boss session was written to or closed.

Live corroboration: read-only output from `db928f33-47ef-4b19-b82b-350e732e3b15` contains retained answered selector footers above a working composer. Logs 56573–56577 record confident awaiting and repeated ChoicePrompt emissions with accumulated historical titles.

SHA-256: `6a34066ecb31b2bc6429b2492d11a8f37261351e8cd1b846f9e428245c62d14b`
