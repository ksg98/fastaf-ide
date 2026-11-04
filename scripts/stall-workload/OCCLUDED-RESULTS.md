# Native occluded-instance replay: 2026-10-21

## Scope

The retained 2026-10-20 isolated-instance capture contains a 41.587-second
WebView callback gap, backend-log silence and independent backend request
failures. Its workload description is `fixtures/occluded-1638.json`: recorded
agent PTY bytes, three scratch repositories, 16 PTYs and four remote clients.
It is not the historical 2026-10-09 workload.

Three twelve-minute pre-fix replays without extra CPU contention did **not**
reach the 30-second threshold. Callback maxima were 17.262, 1.483 and 1.692
seconds. Background-priority thread samples occurred in all three runs.
Background priority alone is therefore not a sufficient replay oracle.

The coordinator then explicitly authorized controlled CPU contention on this
Mac: one normal-priority `yes` process per logical core, serialized with no
other contender run. This permission is task-specific. It is **not** general
authority for agents to saturate the machine.

## Controlled comparison

All runs minimized only their own isolated `make agent-test` window through
Tauri. They used Unix sockets, fresh named instances, the same committed
workload, and 14 contenders at nice 0 / initial priority 31. Contenders started
after native warmup. Every PID was recorded and had a 720-second alarm that
survived `exec`; teardown terminated any survivor by its recorded PID.
Document visibility was `hidden` at start and end. The native snapshots had no
owned window with `onScreen=true` at either point.

The one-line `core:window:allow-minimize` grant was identical in every run:

- **RED:** `ac3230c0f8` plus capability-only commit `b097eda5a`.
- **GREEN-A:** RED plus cherry-picked App Nap fix `1d3d7e0c0f` (original
  `9ff27519dd`). No later agent-test presentation or App Nap changes.
- **GREEN-B:** merged fix-branch HEAD `83e12204c`, plus the same capability grant
  as an uncommitted change on a temporary branch. This revision also contains
  the independent agent-test activity and WebKit occlusion change from main;
  GREEN-A, not GREEN-B alone, isolates the global activity.

| Measurement | RED | GREEN-A | GREEN-B |
|---|---:|---:|---:|
| Duration, including setup and teardown (s) | 557.111 | 720.674 | 720.551 |
| Maximum received WebView callback gap (ms) | **36753** | **2561** | **1435** |
| Failure threshold (ms) | 30000 | 30000 | 30000 |
| PTYs / clients | 16 / 4 | 16 / 4 | 16 / 4 |
| Independent backend probes | 943 | 2271 | 2658 |
| Failed backend probes | 0 | 0 | 0 |
| Maximum backend response time (ms) | 4384.177 | 1618.727 | 615.195 |
| Thread-band samples | 406 | 651 | 692 |
| Samples with a majority of threads at priority <= 4 | 286 | 0 | 0 |
| Maximum individual background-priority thread count | 130 | 17 | 13 |
| Observed one-minute load range | 23.493–74.359 | 26.575–47.470 | 17.531–70.989 |

RED stops after crossing the threshold; GREEN runs to the fixture deadline.
Some individual threads remain in the background band in GREEN. The evidence
supports removal of broad process demotion, not a claim that every thread
always has foreground priority. GREEN-B also retains raw `ps -M` start/end
snapshots; its sampled main-thread priority was 46 at the end.

The workload is identical, but this is a shared machine and the observed load
ranges differ. Setup is inside the fixture's duration: slow setup can delay
when the phases start. The CPU contenders span setup and active replay, with
a 720-second hard bound from contender launch, not from the first PTY phase.

## What this proves, and what it does not

The candidate process-lifetime activity prevents the threshold callback gap in
this controlled hidden-window, CPU-contention comparison. The same workload
without the activity reproduced a gap above the threshold.

This is **not** a reproduction of the original whole-process backend outage:
all RED backend probes completed, with a maximum of 4.384 seconds. It does not
prove that Defender, App Nap or a slow rename caused the historical outage.
The received-callback oracle includes WebView timer execution, native heartbeat
invocation, networking and observer delivery; it is not a pure paint benchmark.

`log show` for 2026-10-20 15:25–15:27 CEST (13:25–13:27 UTC) returned one
`wdavdaemon` container-manager event at 15:26:21.341. This proves activity, not
CPU saturation or file scanning. The retained native app log contains eleven
silence-timer reset records at 13:26:38 UTC, including 40/41-second gaps.
An initial summary incorrectly treated the two-line log output as header-only;
the single matching event supersedes that statement.

## Production behavior

The global activity starts during desktop setup, before agent-test's Ready
presentation handler. It supersedes the duplicate process-lifetime activity
in `agent_test::present_without_focus`; that duplicate is removed after the
controlled GREEN-A check. The separate WebKit occlusion change stays intact.

Daily TUIC stays App-Nap-exempt even when hidden and after the busy-agent power
assertion is released. This can increase hidden-idle energy use; no energy
magnitude was measured. `UserInitiatedAllowingIdleSystemSleep` still permits
idle system sleep. The existing `prevent_sleep_when_busy` setting and its
separate `block_sleep`/`unblock_sleep` policy remain unchanged.

The Rust change needs a manual daily-app rebuild/restart. No daily-app restart,
reload, screenshot or other live interaction was used for this comparison.

## Retained raw evidence

Under `~/Gits/.tmp/results/`:

- `cc-1638b-granted-red{1,2,3}/`: no-contention attempts.
- `cc-1638b-contention-{red1,green-a,green-b}/`: source SHA, launch plan,
  binary/socket identity, visibility/presentation before and after, callback,
  backend and thread-band JSONL, load, contender PIDs/priority and cleanup.
- `cc-1638b-contention-summary.json` and `cc-1638b-red-summary.json`:
  summaries derived from those raw files.
- `cc-1638b-corroboration.{log,stderr,command.json,silence.log}`:
  historical query, timezone, exit status and retained silence-timer records.

The temporary capability grant must never land. All three native instances and
their owned contenders stopped after their runs. No new `.tcap` fixture was
added, and no corpus oracle was changed.
