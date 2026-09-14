# Cyclomatic Complexity Plan

## Goal

Reduce defect and maintenance risk in complex Rust orchestration code without
splitting cohesive platform code merely to improve a metric. CRAP is used as a
triage signal, not as the definition of code quality.

## Baseline and interpretation

The initial `make crap` report used `src-tauri/lcov.info` generated on 2026-07-30
against a worktree that has since changed. Its zero-coverage values therefore do
not describe the current source tree reliably. The coverage command also runs
`cargo llvm-cov nextest`; it does not naturally exercise Tauri startup, native
application launch, PTY process lifetimes, WebSocket timing, OAuth browser
callbacks, or external GitHub services.

Before comparing scores, regenerate coverage and record:

- the tested commit or dirty-worktree fingerprint;
- the exact coverage and CRAP commands;
- functions above the configured CRAP threshold of 30;
- coverage gaps caused by uninstrumented integration boundaries;
- test and doctest results from the same source state.

Do not lower complexity by replacing one readable match with indirect dispatch,
or by extracting single-use functions that hide state transitions.

### Verified current baseline

The baseline was regenerated from the current worktree after the characterization
tests:

- Rust tests: 4,093 passed, 10 skipped;
- line coverage: 76.13% (106,480 regions, 25,413 missed);
- function coverage: 70.80% (11,942 functions, 3,487 missed);
- region coverage: 78.07% (170,455 regions, 37,381 missed);
- CRAP report: all 30 displayed functions remain above threshold 30.

The new pure seams make current coverage visible for
`build_open_in_app_command` (50.4%), `handle_github` (37.3%), and
`spawn_agent_session` (26.1%). The ANSI color mapping, ZIP extraction, and
Claude usage-cache functions no longer appear in the top-30 CRAP report.
This is evidence of exercised behavior, not proof that further extraction is
required: `build_open_in_app_command` remains high because a platform matrix has
cyclomatic complexity 55 even at 50.4% coverage.

## Characterization foundation

The first test pass adds or confirms coverage for these decisions:

| Area | Evidence established | Follow-up |
| --- | --- | --- |
| Application launch | Zed locations, Neovim line arguments, Kitty working directories, and unknown applications are tested without spawning processes. | Extend the command matrix when a launcher regression is reported. |
| Terminal colors | Default, normal, bright, dim, indexed, and RGB ANSI mappings are covered exhaustively. | No refactor required. |
| Plugin ZIP install | Single-directory prefix stripping and parent traversal rejection are tested independently of Tauri activation. | Add rollback tests if finalization is separated from `AppHandle`. |
| Claude usage cache | New data, growth, truncation, file deletion, project deletion, scope filtering, and hourly-cache migration are covered with temporary directories. | Keep filesystem scanning cohesive unless profiling shows a bottleneck. |
| GitHub MCP dispatch | Missing/unknown actions, required paths, and issue-number validation are tested before network access. | Prefer table-driven validation if more actions are added. |
| Agent spawn HTTP route | Remote authorization, binary-path validation, bare-prompt rejection, and terminal-size rejection are covered before PTY creation. | Extract a command plan only when more spawn modes require it. |

Existing tests already exercise terminal chunk fixtures, silence-state decisions,
WebSocket concurrency, GraphQL response classification, REST circuit breaking,
GitHub query construction, failed-job parsing, and plugin target preservation.
Those tests should be extended rather than duplicated.

## Priorities

### P0: Conversation engine characterization

Target: `src-tauri/src/ai_agent/conversation_engine.rs::run_conversation`.

The function currently combines provider resolution, live terminal context,
stream retry, pause/cancel handling, tool approval and execution, repetition
detection, compaction, and history construction. This is the highest-value
refactor, but it needs a controllable LLM boundary first.

1. Introduce an internal conversation dependency interface for streaming chat
   and tool dispatch. Production adapters retain current behavior.
2. Add deterministic tests for end-turn, cancellation before and during a
   stream, pause/resume, transient retry, no retry after emitted output,
   approval allow/deny, tool failure, repetition detection, and compaction.
3. Extract one iteration from the outer lifecycle loop only after the tests
   establish stable inputs and outputs.

Exit criteria:

- every terminal reason is asserted by an outcome test;
- retry and approval tests assert event ordering as well as return values;
- no network, provider registry, or real PTY is required by unit tests;
- the outer function reads as lifecycle control, while an iteration owns one
  model/tool round trip.

### P1: GitHub account polling and retry

Targets: `graphql_with_retry` and `poll_one_account` in
`src-tauri/src/github.rs`.

1. Preserve the existing response-classification and breaker tests.
2. Add an injectable GraphQL transport/token resolver at the orchestration
   boundary.
3. Characterize named-account behavior, ambient-token fallback, repeated 401,
   429/reset handling, breaker isolation, missing viewer, repository aliases,
   cooldown filtering, and partial repository failures.
4. Extract response merging and poll planning only where the test matrix shows
   duplicated rules.

Exit criteria:

- named accounts can never fall back to ambient credentials;
- rate limits do not count as ordinary availability failures;
- one repository failure cannot erase successful results for other repositories;
- account-scoped breaker and cooldown behavior is deterministic in tests.

### P1: Diff triage and CI-log orchestration

Targets: `run_diff_triage` in `src-tauri/src/diff_triage.rs` and
`fetch_ci_failure_logs_impl` in `src-tauri/src/github.rs`.

1. Isolate Git/`gh` command execution behind narrow runners returning parsed
   domain values.
2. Test no-change, heuristic-only, provider failure, malformed model response,
   cache refresh, multiple workflow runs for one head, skipped stale runs,
   multiple failed jobs, external CI, and partial log-download failure.
3. Keep progress emission in the orchestration layer; test its ordered phases.

Exit criteria:

- parsing tests use fixtures and no installed `gh` executable;
- partial workflow failures have explicit, tested semantics;
- progress always terminates with a success or failure event.

### P2: Desktop and process boundaries

Targets: `start_mcp_upstream_oauth`, `spawn_agent_session`, `open_in_app`, and
`start_server`.

- OAuth: inject registry persistence and callback/browser operations; cover
  discovery, dynamic registration, callback mismatch, timeout, cancellation,
  and rollback from `Authenticating` on every failure.
- Agent spawn: keep the newly covered request validation pure; add command-plan
  tests before changing argv construction or resume behavior.
- Application launch: extend pure command construction tests per platform;
  reserve real launch tests for platform CI smoke jobs.
- Server startup: add bind-conflict, retry, shutdown-ownership, TLS, Unix socket,
  and Windows named-pipe integration tests only in environments that own those
  resources.

These boundaries may remain above the CRAP threshold when their branch structure
is a readable platform matrix and integration evidence exists.

### P2: Terminal processing

Targets: `ChunkProcessor::process_chunk`, `spawn_silence_timer`, and
`handle_ws_log_session`.

The current complexity is largely inherent to terminal protocol and lifecycle
ordering. Avoid structural changes until a regression fixture demonstrates a
missing invariant.

1. Add one end-to-end sanitized terminal trace asserting ordered shell-state,
   agent-state, OSC, and log-buffer transitions.
2. Add silence-timer cancellation/no-leak coverage.
3. Add WebSocket reconnect, lagged broadcast, closed channel, and catch-up
   offset cases around the existing concurrency regression test.
4. Preserve hot-path lock ordering and allocation behavior during any extraction.

### P3: Filesystem aggregation and plugin install

Targets: `get_claude_session_stats_impl` and `install_zip_inner`.

The usage-cache lifecycle and ZIP extraction now have direct characterization
seams. Further refactoring is justified only for a demonstrated defect or
performance problem. Remaining valuable cases are unreadable project entries,
malformed JSONL tails, invalid manifests, replacement rollback, and finalization
failure after a preserved `data/` backup.

### Accepted complexity

The following functions should not be split solely to satisfy CRAP:

- `build_menu`: declarative Tauri menu composition;
- `LogColor::from_ansi_color`: exhaustive compatibility mapping;
- `start_server`: platform bootstrap after integration paths are covered;
- `open_in_app`: platform compatibility matrix after command construction is
  covered;
- `spawn_silence_timer`: asynchronous lifecycle loop after cancellation and
  leak behavior are covered.

Document accepted exceptions with the integration evidence that protects them.
Do not exclude business orchestration such as conversation, account polling,
diff triage, plugin installation, or agent spawn validation.

## Delivery sequence

1. Regenerate a trustworthy coverage/CRAP baseline from the current tree.
2. Implement P0 conversation dependency seams and characterization tests.
3. Implement the P1 GitHub polling/retry test matrix.
4. Implement P1 diff-triage and CI command-runner tests.
5. Add P2 platform integration tests where CI provides resource ownership.
6. Re-run full tests, doctests, coverage, and CRAP after each priority group.

Each change must remain independently reviewable. A refactor is successful only
when behavior is preserved, tests cover failure paths and event ordering, and
the resulting ownership boundaries are clearer. A lower CRAP score alone is not
an acceptance criterion.
