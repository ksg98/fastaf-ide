# Recorded ego MCP approvals and selector — 2088 / 2089

Captured on 2026-10-20 from native ego master `c9c74377` (reports 0.1.2), using OpenRouter GPT-6.1 Sol medium, through isolated headless TUIC `8d5bbbc602`. Session: `82963ec9-62ee-47d5-84b7-18bd7f100bb7`; ego session: `01a157fb-bd7a-7099-9f07-d602ca639b45`. Geometry: 41 rows × 128 columns, retained in TCAP v2 with original output, input, chunk boundaries and monotonic timestamps.

Source: `/Users/stefano.straus/Gits/.tmp/results/live-postland2/ego-selector-receipt-title.tcap`. This is the complete unchanged recording (166 records), not a synthesized transcript or excerpt. SHA-256: `ec3ef01aa666221c3444c908a51a481fea80af4f9b075593a9d8a7b33b3b1059`.

The native client discovers the session tool and calls session status. The successful `call_tool` receipt immediately precedes the native `Pick a colour?` selector, with Red, Green and Blue options. Down then Enter selects Green. Before the fix, both shared `question_text` and `choice_prompt.title` include the receipt. The independent expected title comes from the recorded native selector, not the contaminated exported state. `mcp-effect.json` and `mcp-selector-mobile.png` in the source evidence directory retain the shared-state and mobile symptom.

The separate first-client connection/intent selector is documented in `docs/postland-live-checks-2026-10-20.md` on `chore/live-postland2`, but is not present as a selector in this recording. Parser boundary coverage uses the observed connection/intent rows; it is not claimed as a second captured selector replay.

This recording also retains three native default-mode MCP approvals used by story 2089-aafb. Zero-based records 33, 64 and 124 carry fresh OSC awaiting; 35, 66 and 127 paint the approvals. Each title uses explicit CRLF continuation rows before `Risk:` and the y/a/n/e/d controls. Inputs 36 (`y` + Enter), 67 (`y`) and 128 (`y`) answer them, followed by native busy. The original 2088 oracle was regenerated after combining both fixes. The capture was renamed without changing its bytes to keep one shared fixture and stage its evidence with the approval fix.
