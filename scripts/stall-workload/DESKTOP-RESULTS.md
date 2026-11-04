# Native WKWebView replay: 2026-10-20

## Outcome

**The retained generated suffix completed in WKWebView. No long stall or original
real-stall RED/GREEN is claimed.** An earlier native attempt timed out without a
result callback; its cause and document visibility were not captured. Do not pool
that incomplete attempt with the successful replay or call it a painting stall.

## Instance and provenance

- Worktree source base: `3ca133b45d2e87c843c9fb7220db4e9abe7ac70c`, plus the
  helper's Unix-socket transport and diagnostic changes in this commit.
- Launch: `make agent-test AGENT_TEST_INSTANCE=at-1638 AGENT_TEST_PORT=19878`,
  with the mbx Cargo shim on PATH. The target built embedded frontend assets and
  a distinct native binary through build-slot; it did not use a Vite dev server.
- Final native build: 3m40s; Vite build: 11.87s. mbx doctor reported zero failures
  and zero warnings. No test suite, rb build or installed-binary replacement ran.
- Final listener PID: 20847; executable:
  `<worktree>/.tmp/agent-test/at-1638/tuicommander-agent-test`.
- Control and independent backend requests used the instance's own Unix socket:
  `~/Gits/.tmp/tuic-at/0a6d5995bafc57b3/tuic-mcp-0a6d5995bafc57b3.sock`.
  Health and listener-executable guards passed before JS submission.
- Input: `~/Gits/.tmp/stall-1638/font-workload/frame-workload.json`, SHA-256
  `2fbe2858df029f8f5d2ecfa5d0a1703794606df58773ef02d9124df271cdf0a5`.
- User agent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
  AppleWebKit/605.1.15 (KHTML, like Gecko)`. This string does not establish a
  specific installed WebKit version.
- Result callback reported `document.visibilityState = visible`. No focus,
  visibility or background-throttling workaround was applied.

The input is the same explicitly generated recording described in `RESULTS.md`:
only seven paint snapshots within a retained 346.1 ms suffix, with 1692 events
dropped. Each snapshot was replayed three times through the current production
renderer. There is no old-revision WKWebView comparator in this run.

## Final measurements

Milliseconds, nearest-rank quantiles. Raw samples carry wall timestamps.

| Metric | n | p50 | p95 | p99 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Paint | 21 | 3 | 4 | 14 | 14 |
| 100 ms JS timer gap | 15 | 103 | 123 | 123 | 123 |
| rAF gap | 94 | 17 | 21 | 27 | 27 |
| Native frontend_heartbeat command round trip | 15 | 0 | 2 | 2 | 2 |
| Independent backend /sessions latency | 15 | 0.444 | 0.610 | 0.610 | 0.610 |

All 15 native command round trips and all 15 backend probes succeeded. Zero-ms
round trips reflect browser clock resolution, not zero processing cost. Backend
probe start timestamps span 1412 ms. This short interval cannot exclude a rare
or sustained-workload outage. Paint durations exclude font loading and decoding;
timer gaps cover the replay phase more broadly. The native command was issued
at the harness's 100 ms cadence, not the application's normal five-second cadence.

## Earlier failures and limits

1. TCP `/health` returned HTTP 401 with `WWW-Authenticate: Basic
   realm="TUICommander"`. No login or token-file read occurred. The coordinator
   then explicitly authorized the instance's Unix socket. The helper now accepts
   that socket as its final argument while retaining the identity guards.
2. The first Unix-socket run passed identity checks and received eval acceptance,
   but no actual callback arrived within 180 seconds. The backend logged a
   31-second frontend-heartbeat absence. The helper then stopped the instance.
   That version did not save its backend probe array on timeout, and it did not
   capture visibility or WebView progress. There is therefore no contemporaneous
   distribution or evidence that painting, rather than hidden-document timer
   behavior or another WebView condition, caused this incomplete attempt.
3. The diagnostic retry added stage logs and retained failure evidence, then
   completed with the measurements above. No production rendering, heartbeat or
   visibility code changed between these two runs. The timeout cause remains
   unknown; a successful retry does not diagnose it.

Neither attempt replays original PTY arrivals, exercises decode/merge or input
continuity, or reconstructs the historical stall. The generated retained suffix
is not a recording from a real stall. Original story criteria 2 and 3 stay open.

## Evidence and cleanup

Evidence directory: `~/Gits/.tmp/stall-1638/desktop-at-1638/`.

- `wkwebview-report.json`: successful callback and raw samples.
- `health-unix.json`: final named-instance health response.
- `measure-unix-diagnostic.log`: successful run and stop confirmation.
- `measure-unix.log`: earlier 180-second callback timeout and stop confirmation.
- `agent-test-unix.log`: final build, launch and shutdown. The retry reused this
  log path, so it does not retain the earlier attempt's complete app log.
- `agent-test.log`, `measure.log`: initial TCP prerequisite failure attempt.

Each attempt ran `make agent-test-stop AGENT_TEST_INSTANCE=at-1638
AGENT_TEST_PORT=19878` in its `finally` cleanup. The final successful run printed
`Stop requested for this agent-test instance only`. A subsequent stop request
reported no running supervisor. A worktree-scoped `ps` check found no remaining
agent-test executable. No separate browser, Vite or headless backend was started.
Boss's daily app, port 9876, configuration and windows were not accessed.
