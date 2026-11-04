# Mobile SSE starvation capture

Captured from two authenticated mobile tabs during the live 2021 parity audit on 2026-10-19. This is real Chromium CDP Network evidence, not generated traffic.

Source: `~/Gits/.tmp/results/parity-2021-final/network-requests.json`.
SHA-256: `930ebfcbcb5b2c2ef6c2328adb15f9c659d6c962c698d710268dd72ac129ea9f`.

The capture records request/response timing, tab ids, HTTP protocol and connection ids. It records no headers, cookies, bodies or query tokens. URLs contain only origin and pathname; `types` is the event-name allowlist.

Six open EventSource responses use distinct HTTP/1.1 connections (7673, 7678, 7649, 7763, 7762, 7761). Ordinary configuration, manifest and session requests remain without responses at the end of the capture. This proves the observed two-tab starvation, not an unlimited-tab guarantee. The post-fix scenario must separately show state reads and a native approval completing while both tabs remain open.

## Post-fix native verification

On 2026-10-19, the worktree native `tuic-remote` backend (isolated instance `sse-2078`) served a worktree Vite frontend to two real Chromium tabs through the required stealth wrapper. One tab showed native ego permission details and the other the mobile session list. CDP recorded two open HTTP/1.1 SSE connections (17454 and 18152). A session read completed with HTTP 200 in 6 ms while both remained open. A trusted UI approval ran `printf SSE_2078_NATIVE_OK`: native output contained the marker and exit 0, and the authoritative session state retracted awaiting within the 1.8-second observation window. Neither tab nor SSE connection was closed to deliver that approval.

A late consumer received real session-created events without delivering them to a closed-event consumer. Removing it left the sibling consumer live. Explicit close and process exit produced their two distinct backend close events. Deliberately closing only the test proxy's SSE responses then exercised native EventSource reconnect, filter restoration and `onResync("reconnect")`; two live streams remained. This disconnect occurred only after the approval proof.

Sanitized Network evidence, before/after native state/output, UI snapshots, runner and startup scripts are retained at `~/Gits/.tmp/results/fix-2078-live/`. `result.json` reports PASS. Setup attempts are retained separately: invalid reasoning level, stale tab binding, a wrapped native command, mobile input emulation, a strict close-event count, and an offline emulation that did not close existing SSE sockets were diagnosed before retry. No product assertion or unit test was weakened. Both test sessions, owned browser tabs/daemons, Vite, backend and token controller were stopped. The focused GREEN unit run belongs to batch integration, not this story run.
