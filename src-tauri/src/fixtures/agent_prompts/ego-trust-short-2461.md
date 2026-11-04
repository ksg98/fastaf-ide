# Ego trust prompt in a short mobile viewport — 2461-1403

- Captured on 2026-10-29 from the installed ego 0.4.0 binary with a Python `pty.fork()` harness.
- Format: TUICCAP2, 12 rows by 48 columns. The harness set terminal geometry before answering the cursor-position query.
- SHA-256: `35090d5866a0827ea822354dd8b08b418fae95cf44c33699e36e01edf7a2b392`.
- HOME and EGO_HOME were fresh isolated directories under `~/Gits/.tmp/critic-2461-capture/`. The scratch project contained only AGENTS.md.
- Launch: `ego --model ollama/gemma4:12b-mlx --thinking medium --sandbox off --instructions <scratch-project>/AGENTS.md`.
- The harness recorded original output chunks and cursor-position replies. It stopped only its own child after the prompt appeared, without answering trust or submitting a model turn.
- The native renderer omits the offer heading in this short viewport. The active trust prompt and refusal explanation remain visible.
- Regression: `captured_ego_trust_survives_short_mobile_viewport` catches requiring an offscreen offer heading before publishing Yes/No.
