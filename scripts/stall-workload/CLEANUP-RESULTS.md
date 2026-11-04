# Native orphan-cleanup observation: 2026-10-20

## Outcome

Five bounded native desktop runs completed **45 orphan removals**. None reproduced
the story's 30-second heartbeat outage with an independently responsive backend.
No performance fix, real-stall fixture, RED or GREEN is claimed. The original
captured-workload criteria remain open.

This is not an all-visible continuity pass. Run 1 was visible throughout; run 2
changed from visible to hidden; runs 3–5 reported hidden. Run 5 also contained a
15-second independent backend timeout and an 18.796-second WebView timer gap.
Those observations must not be hidden inside a blanket “no stalls” claim.

## Scope and provenance

- Source: `chore/desk-1638b-stall`, pre-report HEAD
  `b8f440c392` (full source identity is retained in the Git history).
- `fix/1638-stall-workload`, including `def83721`, was already an ancestor;
  no merge was required. The previous generated paint replay and
  `chore/live-1638` evidence were read before execution.
- Launch: `make agent-test AGENT_TEST_INSTANCE=at-1638 AGENT_TEST_PORT=19938`.
  Native Cargo and Vite builds ran through the target's build-slot integration;
  mbx doctor reported zero failures and zero warnings. No rb execution or test
  suite ran. This native executable was needed for the authorized Mac observation.
- Successful workload listener PID: `93074`. `identity.json` verifies the exact
  worktree-local `tuicommander-agent-test` executable, instance health and socket.
- Control and independent requests used only
  `~/Gits/.tmp/tuic-at/0a6d5995bafc57b3/tuic-mcp-0a6d5995bafc57b3.sock`.
  No access to port 9876 or Boss's app was performed.
- Scratch state and all evidence:
  `~/Gits/.tmp/results/desk-1638b/`.

Each checkout held 1,200 tracked files of 1,024 bytes. The scratch repository had
one commit, reachable from `main`. The instance's `repo action=worktree_create`
created each checkout, with `spawn_session=false`. The probe detached each scratch
checkout and deleted its temporary branch, so the production safe-only orphan
checks could accept it. The scratch repository alone used sibling worktree
storage, selected through the isolated instance's settings API. Every checkout
stayed beneath the evidence directory.

The desktop WebView invoked `remove_orphan_worktree` sequentially with
`safeOnly=true`, using the real Tauri command, guard and deletion path. Run 1 used
one checkout as the small-scale prerequisite; runs 2–5 each used eleven. This
matches the historical operation class and eleven-removal cardinality, not the
unknown historical repository contents or its full reactive/sidebar topology.

## Measurement contract

The WebView streamed wall-stamped samples to an independent local collector:

- a requested 100 ms JS timer, including `document.visibilityState`;
- an additional five-second invocation of the real `frontend_heartbeat` command,
  including command round-trip time (the normal app heartbeat was not disabled);
- before/after timestamps for each awaited native removal.

The collector separately requested `/sessions` over the instance socket every
250 ms, with at most one outstanding request and a 15-second timeout. Its
latencies include local scheduling and transport, not backend processing alone.
A round-trip sample is not a direct read of the backend watchdog's last receipt.
No request was made to infer liveness from grid-gate warnings.

Each run lasted at least 36 seconds, with a three-second baseline and at least a
five-second tail after removal. Callback samples were appended as they arrived,
so a later callback failure could not erase earlier observations. An absence of
collector callbacks for more than three seconds triggered one three-second
`sample` of this probe's recorded app PID. No other application's PID was sampled.

## Results

All durations below are milliseconds. Maximum latency includes failed requests
where noted. Full distributions and wall timestamps are retained, not only these
maxima.

| Run | Removed | Duration | Visibility | Timer gap max | Native heartbeat RTT max | Backend max | Backend failures |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 1 | 36,000 | visible | 105 | 1 | 0.807 | 0 |
| 2 | 11 | 37,252 | visible → hidden | 9,415 | 3,594 | 303.411 | 0 |
| 3 | 11 | 36,110 | hidden | 1,287 | 1,185 | 144.884 | 0 |
| 4 | 11 | 36,040 | hidden | 1,197 | 27 | 407.788 | 0 |
| 5 | 11 | 45,075 | hidden | 18,796 | 19,530 | 15,003.016 | 1 |

These values use **all retained callbacks in `webview.jsonl`**, including callbacks
received after each run's `done` callback. The native-heartbeat sample counts are
7, 5, 6, 7 and 5. Timer sample counts are 346, 112, 41, 41 and 33. The corresponding
independent backend sample counts remain 144, 148, 145, 144 and 103.

Run 4's last native-heartbeat callback arrived 2 ms after `done` at the collector
(`received_ms` 1792493578006 → 1792493578008), or 13 ms later by WebView wall
clock. Its measured command RTT was 27 ms. Run 5's last timer and native-heartbeat
callbacks arrived 1 ms and 4 ms after `done`, respectively. That native-heartbeat
command **completed successfully in 19,530 ms**. Its WebView wall timestamp is
30 ms after `done`; the spacing from the previous native-heartbeat completion is
24,665 ms. The tail is therefore **not censored**. Neither the successful
completion nor its RTT demonstrates a healthy five-second heartbeat cadence.
Run 2's largest spacing between observed native-heartbeat results was 13,948 ms.
No retained diagnostics entry reports `Frontend unresponsive` in the successful
workload instance.

The earlier report incorrectly summarized the per-run snapshots, which stop at
`done` and omit these late callbacks. Its run-4 RTT maximum of 20 ms, run-5 RTT
maximum of 6 ms and censored-tail statement are withdrawn. Use the raw JSONL and
`summary-all-callbacks.json`, not the original `summary.json` or per-run snapshots,
for complete callback counts and heartbeat maxima.

Run 2's app sample shows its main thread predominantly in the AppKit event-loop
Mach wait. Run 5's sample includes AppKit accessibility window/space queries and
Mach waits. Neither is a sample of the WebContent process or evidence attributing
the timer delays to JavaScript painting, orphan deletion, machine starvation or
an accessibility caller. Run 5 includes a **backend-request stall, not a
WebView-only stall**: the independent `/sessions` request timed out after
15,003.016 ms, and the next request completed in 4,071.564 ms. These end-to-end
measurements do not identify the blocked backend operation or exclude observer
scheduling delays.

The coordinator identified the hidden-window test limitation as the agent-test
occlusion issue, story `2095-0106`. Runs 2–5 do not establish visible-WebView
continuity. A five-run visible-window rerun is pending that harness fix; the
original real-stall RED/GREEN remain open.

The coordinator reported the Mac unlocked at 12:49 local. The successful run
began at 12:49:34 local, with visible callbacks. Later hidden callbacks remain a
material limitation; no focus, visibility spoofing or denied window operation
was used to force a different result.

## Setup failures, evidence and cleanup

Four earlier setup attempts are not counted among the five runs:

1. The worktree-location guard refused the instance's application-directory
   default before creating any worktree.
2. A settings request lacked the required `path` field and was rejected.
3. The location query used `repo_path` instead of the endpoint's `repoPath`, so
   it queried the default rather than the scratch override and failed closed.
4. The production orphan safety guard refused a detached checkout whose temporary
   non-default branch still pointed at HEAD. The next attempt deleted that
   scratch-only branch and removed the leftover through `repo worktree_remove`.

Every attempt stopped through `make agent-test-stop`. The successful supervisor
waited for its own child to exit; the final worktree-executable process check
found no remaining agent-test app. No Vite server, browser or headless backend
was started separately. `final-worktrees.json` contains only scratch `main`.

Key retained evidence:

- `cleanup-probe.mjs`, `run-probe.py`, `wait-ready.py`: exact collection commands.
- `launch-plan.json`, `identity.json`, `scratch-provenance.json`: launch and input.
- `webview.jsonl`, `backend.json`: authoritative retained raw observations.
- `summary-all-callbacks.json`: corrected summary including late callbacks.
- `summary.json`: superseded snapshot-only summary, retained as correction history.
- `run1-report.json` through `run5-report.json`: snapshots taken at `done`, not
  complete late-callback records; plus worktree and receipt files.
- `run2-app-sample.txt`, `run5-app-sample.txt`: contemporaneous native samples.
- `logs.json`, `agent-test-attempt5.log`, `probe-attempt5.log`: runtime and cleanup.
- Earlier `probe*.log` and `attempt4-*` files: distinct setup failures.

These generated scratch inputs are not a fixture captured from a real qualifying
stall. They must not be committed or relabeled as the original story RED.
