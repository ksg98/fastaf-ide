# Ego startup trust capture — 2461-1403

- Captured on 2026-10-29 from the installed ego 0.4.0 binary.
- SHA-256: `285b7ece70e1ecaeb3685fe28b92c9490d23ccfa7515255c73a5aaee1f4e6b5b`.
- Format: TUICCAP2, 24 rows by 48 columns, original output chunks and cursor-position replies.
- A Python `pty.fork()` harness ran ego in an untrusted scratch project under `~/Gits/.tmp/tuic-2461-evidence/`. HOME and EGO_HOME pointed at a fresh isolated directory under that evidence root. The project contained a plain AGENTS.md.
- Launch: `ego --model ollama/gemma4:12b-mlx --thinking medium --sandbox off --instructions <scratch-project>/AGENTS.md`. The process was stopped after the trust modal appeared, without answering it. No model turn was submitted.
- The harness answered terminal cursor-position queries. Their exact input bytes are retained; these are not trust answers.
- Ego inserts hard newlines inside the long path. The native final prompt ends with `? [y/N]`, not `?`. This is the observed detection gap.
- Parser regression: `captured_ego_trust_question_is_detected`. Shared state replay: `captured_ego_trust_reaches_mobile_session_state`.
- Browser evidence: `~/Gits/.tmp/tuic-2461-evidence/mobile-trust.png`; production mobile components at 390 by 844 pixels with isolated fixture transport. This is not a live backend build.
