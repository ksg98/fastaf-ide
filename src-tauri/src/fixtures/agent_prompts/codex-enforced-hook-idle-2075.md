# Codex enforced approval cleared by delayed idle — 2075-aa2f

Capture source: real installed Codex through `/sessions/agent` and `/diagnostics/capture` on a native debug headless backend built from this worktree, not the user's desktop. Recorded 2026-10-19; original file `/Users/stefano.straus/Gits/.tmp/fix-2075-live-1792439753/raw/8dfe3551-31ea-431c-ad07-dcfe75de5662.tcap`. Original TCAP v2 chunks, input, monotonic timestamps and 41 × 128 geometry are unchanged.

Launch: `codex --no-daemon --no-alt-screen --ask-for-approval on-request --sandbox workspace-write -m gpt-6.1-sol`. The prompt requested only `printf 'LIVE_CODEX_2075_OK\n'` with `sandbox_permissions=require_escalated`. A startup Escape skipped hook review. No input followed the native command approval. The recorder deleted only its own session after observing the unanswered approval for 185.19 seconds.

The installed CLI changed externally during investigation: earlier direct recordings used 0.162.1; this failing recording's own banner identifies 0.163.0. The author did not install or update Codex.

Isolation: backend `127.0.0.1:52675`, unique `--instance`, separate HOME/config/cache/temp/capture directory under the evidence root, zero sessions at startup. A worktree Vite mobile page on `127.0.0.1:52676` used the real HTTP/SSE/terminal routes through a private proxy. The named ab-stealth browser session remained subscribed during the observation. No desktop process or production port was used. Daemon, Vite, session and browser were stopped.

Observed failure: 205 one-second REST samples, including 185 after the approval opened. Six open-interval samples retained confident awaiting with all three options. At capture timestamp **25,608,873 us**, an authentic `OSC 7770;state=idle` arrived while the exact approval footer and controls were still on screen. The backend logged `activity_source=hook-idle` at `2026-10-19T19:56:21.742983Z`; the next REST sample had no awaiting flag or choices, then reported idle. Mobile DOM/screenshots changed from Input with three native controls to Idle without controls. Raw output continued to repaint the Action Required title for the remainder of the interval.

RED: `codex_enforced_approval_stays_awaiting_without_answer` failed at exactly 25,608,873 us on pre-fix commit `b9469fd78a54daab0fc5921b9ffe0b618af04b3c`, both native macOS and rb. This fixture needs no synthetic hook events or wall-clock timer simulation to reproduce the shared accumulator failure.

Full evidence: sibling `states.jsonl`, `report.json`, `daemon.log`, `mobile-{open,final}-dom.txt` and screenshots in the source evidence directory. Driver: `/Users/stefano.straus/Gits/.tmp/fix-2075-live.py`.

## Post-fix live verification

The isolated native backend retained confident awaiting and three choices for 185.01 seconds: 184 of 184 one-second samples, zero state drops. It logged rejection of the authentic delayed idle. A trusted mobile approve-once click produced exactly one actual command result and cleared the controls. Evidence: `/Users/stefano.straus/Gits/.tmp/fix-2075-live-1792440496`. The later harness step used an incorrect HTTP submit body and received 422; this does not invalidate the completed retention and approval observations.

A separate follow-up used fresh native sessions and trusted mobile clicks for approve-once, refusal and Escape cancellation. Approve-once produced one actual result; refusal and cancellation returned to the native ready composer without awaiting or stale controls. Evidence: `/Users/stefano.straus/Gits/.tmp/fix-2075-live-1792440917`, including `report.json`, answer state/DOM/native snapshots and browser interaction transcript. All owned processes were stopped. The user's desktop was not restarted; desktop evidence is the shared accumulator/source path, not a desktop runtime screenshot. Automated GREEN remains a coordinator batch gate.

SHA-256: `a4e0898b0c73df416dbcf2dee9c49b4b9f933502a6d4148e3fbb3f586d36ecd5`
