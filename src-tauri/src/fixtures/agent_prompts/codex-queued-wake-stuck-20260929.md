# Codex queued wake in a stale Working state

Source: TUICCAP2 capture of rb-tool session `f54f47de-1e3d-481f-a45d-89b6aca4678b`, saved by the coordinator on 2026-09-29. The adjacent `.tcap` retains records 0–11 of the original capture: cursor-only output, a long quiet interval, the coordinator's manual carriage return, and the first response containing the queued `BG DONE` text.

The capture started after the automated queue write, so it cannot establish why Codex ignored that earlier Enter. The observed session status remained `agent_state=working` and `shell_state=busy` throughout the stall. The replay test checks that cursor movement under a pre-existing Working screen is insufficient confirmation of a new submission.
