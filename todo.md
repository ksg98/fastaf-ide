# TODO — deferred opportunities

Items surfaced during work but intentionally not implemented immediately.
(Project convention: durable feature concepts live in `ideas/`, work items in
wiz stories. This file is the session-scoped scratch list for the `/goal` loop.)

## spawn_agent HTTP mapping (story 067 follow-up)

- **Problem/opportunity:** Story 067 listed `spawn_agent` (route `POST /sessions/agent`)
  among the commands to map. It has a Rust route but **zero frontend `invoke("spawn_agent")`
  callers** in `src/`.
- **Why not now:** With no call site, the camelCase arg shape (`ptyConfig`/`agentConfig`?)
  can't be verified against a real invocation — a mapping would be dead code encoding an
  unverified contract (YAGNI). Story criterion 2 ("verify shape against the route") is
  literally unsatisfiable for it.
- **Proposed solution:** Add the mapping *together with* the first browser/remote feature
  that actually spawns an agent via `invoke`, so the arg shape is verified end-to-end.
  Shape (from the Rust route): `POST /sessions/agent`, body = flattened `SpawnAgentRequest`
  (`{ rows, cols, cwd, prompt, model, print_mode, output_format, agent_type, binary_path, args }`),
  response `{ session_id }` → unwrap to string.
- **Trade-offs:** Mapping now = "complete table" but dead/guessed; deferring = a known gap
  for remote agent-spawning, but `tuic-remote` has no frontend spawning caller today either.
- **Complexity:** Low (~8 lines + a test) once a caller exists.
- **Priority:** P3 — pair with story 068 (AI agent loop) or any remote agent-spawn feature.

## Plugin-data write browser parity — DONE (commit 0951fc1d, #071-fcb8)

- **Was:** the credential-consent flow (`pluginRegistry.ts:611`) called `write_plugin_data`
  in browser mode, but only `read_plugin_data` had an HTTP route → consent threw on save.
- **Fixed:** added `POST /api/plugins/{id}/data/{*path}` (reuses sandboxed write logic,
  content in body) + COMMAND_TABLE mapping + test. `delete_plugin_data` has **no caller**
  → intentionally NOT mapped (YAGNI).
- **Remaining (story 071 broader batch):** install/uninstall plugins, `plugin_read_file*`/
  `plugin_write_file`/`plugin_rename_path`/`plugin_list_directory`/`plugin_read_session_output`,
  and host-capability classification (`plugin_exec_cli`, `plugin_read_credential`,
  `plugin_watch_path`/unwatch, `plugin_http_fetch` → likely desktop-only). Sizable + a
  plugin-fs/install **security** dimension — warrants a focused pass.

## Unify build_router and build_remote_router (tech debt) — STORY `094-ec55` (2026-07-05)

- **Problem:** `src-tauri/src/mcp_http/mod.rs` maintains TWO hand-written route
  lists — `build_router` (desktop/loopback) and `build_remote_router` (tuic-remote).
  Every shared route must be added to both; they drift silently. The HTTP-parity
  story series (061-073) exists partly because of this drift. Story 061 had to add
  each of its 7 fs routes in both places.
- **Proposed solution:** Extract a `shared_routes()` builder for the common subset;
  each router merges it and adds its own overrides (e.g. remote's standard-cap
  `/fs/read-editor`, desktop-only dictation/native routes). A compile-time or test
  assertion that every `fs_routes::*_http`/`session::*` handler is reachable from
  both routers would prevent future drift.
- **Trade-offs:** The two routers legitimately differ (auth layering, caps,
  desktop-only handlers), so the shared set must be carved carefully; a naive merge
  would re-expose desktop-only routes remotely.
- **Complexity:** Medium. Touches the most security-sensitive file; needs the full
  remote-parity test pass.
- **Priority:** P2 — do it before/alongside the remaining 062-073 parity stories so
  they stop paying the double-entry tax.

## update_session_cwd / terminal_get_block_rows HTTP mapping (story 062 follow-up)

- **Problem/opportunity:** Story 062 listed these two among the 12, but neither has a
  frontend `invoke()` caller. `update_session_cwd` is wired to a pending OSC-7 handler
  (DEFERRED comment in pty.rs, 2026-05-14); `terminal_get_block_rows` is currently unused.
- **Why not now:** No caller → mapping (and a write route for cwd) would be dead code now
  (same YAGNI rationale as spawn_agent). Their arg shapes are trivial (sessionId + primitives),
  so they're cheap to add the moment a caller lands.
- **Proposed solution:** Add the route(s) + mappings together with the OSC-7 wiring
  (update_session_cwd) / the first block-rows consumer.
- **Complexity:** Low (~10 lines each).
- **Priority:** P3 — fold into the OSC-7 work for cwd.

## Remaining P3 HTTP-parity stories (064-073) — triage

The P2 tier (061, 062, 063, 067) is complete. The remaining stories split into two
groups by risk:

### Mechanical — DONE (064, 065, 066, all shipped 2026-06-28)
- **064** Git panel commands — DONE (closes #064-b2c6). 14/15; run_diff_triage carved out.
- **065** GitHub commands — DONE (closes #065-8c28). 11/12; loopback-only (GitHub not on
  remote daemon); get_all_issues skipped (no caller).
- **066** config/themes/mdkb/misc — DONE (closes #066-1eb3). 16 mapped; no-caller +
  integration/stateful (mdkb daemon, set_ansi_colors, agent_mcp) skipped with notes.
- Pattern confirmed across all three: extract non-gated `*_impl(&AppState, ...)`, add axum
  handler, register route (BOTH routers for fs/pty/git core; loopback-only for github/config —
  those route families were already loopback-only), COMMAND_TABLE + mapping test, verify
  desktop + `--no-default-features`. Mutating config handlers carry `require_local_or_auth`.

### Split each story: RPC-now vs event-later (second-opinion refinement)

GPT-5.4 flagged that classifying entire stories as "architectural" is too coarse —
the **request/response** commands inside 068-070/072 are mechanical and shippable now;
only the **push/subscription** delivery needs the event-bridge decision.

**STEP 1 (RPC-now) of the plan is DONE (2026-06-28):** 070 fully closed (#070-0902,
all 7 watcher commands); 069 RPC slice (7 chat-CRUD commands, #069-4a4f) and 068 RPC
slice (10 agent-loop/knowledge/scheduler commands, #068-6601) shipped — both stories
stay `in_progress` for their streaming halves. All in `mcp_http/ai_routes.rs`, loopback
router, transport 108/108, both build targets green, pushed.
**REMAINING = the streaming Steps 2-5** (the hard, architectural core): diff-triage→SSE
(Step 2), conversation token WS (Step 3), chat token WS (Step 4), browser WS wiring
(Step 5). These are the genuine event-bridge infra — best done in a focused session via
`/wiz:work plans/http-parity-ai-event-bridge.md`.
**UPDATE 2026-07-05: DONE.** The event-bridge plan shipped in full — all acceptance
criteria `[x]` in `plans/http-parity-ai-event-bridge.md` (SSE triage-progress, per-id
conversation/chat WS, browser wiring, 114 transport tests). No stories to create; this
entry is closed.

**068-070 + run_diff_triage are PLANNED** → `plans/http-parity-ai-event-bridge.md`
(active plan, 2026-06-28). Codebase exploration found a THIRD transport GPT missed:
agent/chat streaming uses `tauri::ipc::Channel` (per-invoke, no HTTP analog), not just
AppHandle-vs-AppEvent. Plan recommends a **HYBRID** bridge: low-freq lifecycle/progress →
`event_bus`→SSE; high-freq token streams (conversation, chat) → dedicated per-id WS
(mirrors PTY log-mode, honors the 20+/sec "keep off the global 256-cap bus" memory
constraint). Each story split RPC-now (Step 1, mechanical like 061-066) vs stream-later
(Steps 2-5). Next: `/wiz:stories create` from the plan, then `/wiz:work`.

**073 — DONE** (closes #073-62fc): `INTENTIONALLY_UNMAPPED` allowlist in transport.ts
documents the 32 native/host-only commands with reasons; mapCommandToHttp raises a precise
native-only error. Absorbs the YAGNI/native exclusions logged below.

- **068** AI agent loop / **069** AI chat + conversations / **070** AI watchers.
  - **Mechanical now:** request/response commands — e.g. `pause_conversation`,
    `resume_conversation`, `agent_loop_status`, watcher CRUD, AI-chat file-backed
    conversation CRUD. No subscription semantics → standard `*_impl` + route + mapping.
  - **Architectural later (Boss + `/wiz:plan`):** the push side only — `chat_subscribe`/
    `chat_unsubscribe`, watcher fire/event push, agent-loop progress streaming, plus
    `run_diff_triage`. **Decision needed:** route these new `AppEvent`s through the
    existing `/events` SSE (GPT's recommendation — the channel already exists and browser
    mode already consumes it) vs dedicated WS vs hybrid. Design once, shared mechanism.
- **071** plugin data/lifecycle — `write_plugin_data` / `delete_plugin_data` have **real TS
  callers** (`pluginRegistry.ts:611,658`) → NOT YAGNI (correcting the earlier note). Needs
  new Rust routes (`PUT/DELETE /api/plugins/{id}/data/{*path}`) reusing the sandboxed
  write/delete logic. Medium. Capability/host-policy split, not lack of demand.
- **072** provider keyring + MCP oauth — **split:**
  - **Mechanical now:** `get_provider_api_key_exists` / `save_provider_api_key` /
    `delete_provider_api_key` (+ likely `check_ollama_models`, maybe `test_slot_connection`).
    GPT verified these match the **already-shipped** MCP-upstream-credential proxy pattern
    (`transport.ts:148-157` → server endpoints in `mcp_http/mod.rs`). Token-auth + local-tool
    trust boundary already covers them — no extra block warranted.
  - **Needs flow review:** OAuth redirect/continuation UX only (`start_mcp_upstream_oauth`
    + cancel/callback). `McpOAuthStart` already rides SSE, so backend is half-done.
- **073** Documentation of intentionally-unmapped native/host commands — pure doc task; the
  `todo.md` exclusions (spawn_agent, update_session_cwd, terminal_get_block_rows) feed it.
  NOTE: plugin-data write/delete are NO LONGER in this bucket — they moved to 071 (active).

## Story 064 — DONE (closes #064-b2c6, commit 640ea489)

14/15 git-panel commands mapped. `update_from_base` / `switch_branch` /
`merge_and_archive_worktree` shipped via the standard `*_impl` extraction (no more
sensitive than the already-shipped `delete_branch`). Only `run_diff_triage` remains —
see below.

## run_diff_triage (event-emitting) — small-refactor, grouped with event-bridge

- **What:** Takes `AppHandle`, emits LLM-triage **progress events**. Not request/response.
- **Second-opinion (GPT-5.4) correction:** this is NOT blocked on inventing a transport.
  `/events` SSE already exists and multiplexes `AppEvent`s; browser mode already consumes
  it via a shared `EventSource` (`src/invoke.ts`). The real gap is narrow: `run_diff_triage`
  emits via `tauri::AppHandle` instead of `AppEvent`. Fix = add an `AppEvent::DiffTriageProgress`
  variant + publish through `state.event_bus`, then map the command over HTTP. Small refactor,
  not a transport redesign.
- **Why still deferred:** it shares the exact mechanism the 068-070 agent/chat/watcher push
  events need — do it once, in that pass, so the `AppEvent`-over-SSE pattern is designed
  coherently rather than bolted on per-command. Priority P3.

## MCP orchestration follow-ups (plan: mcp-orchestration-fixes, stories 074–079)

### O1. Live E2E of cross-agent orchestration (plan acceptance criterion 2) — STORY `091-22b7` (2026-07-05, includes O6)
- **Opportunity:** claude↔codex spawn + auto-identity + PTY-injection wake + parent→child
  follow-up is **code-verified** (unit tests) but not yet driven end-to-end live.
- **Why not now:** Rust backend does not hot-reload into Boss's `make dev` session
  (AGENTS.md Dev Hot Reload); needs codex + claude installed. Requires a rebuild that
  tears down the live session — Boss's call on timing.
- **Proposed:** after `make dev`/`make build`, drive `:9877`: spawn codex from claude,
  assert child auto-registers (no register call), `send` a follow-up, observe injection in
  the child grid, then reverse roles. Confirm `agent action=wait` wakes on the child's
  auto `state_change`.
- **Trade-offs:** none (verification). **Complexity:** S. **Priority:** P1.

### O2. cargo-audit — bcrypt advisory FIXED; unmaintained warnings remain (allowed)
- **DONE:** `make check` failed at `cargo audit` on RUSTSEC-2026-0199 (bcrypt `verify`
  non-ASCII panic). Fixed by bumping the direct dep `bcrypt` 0.19.1→0.19.2 (Cargo.lock only).
  `make check` is now fully green.
- **Remaining (non-blocking):** ~24 `unmaintained` warnings (proc-macro-error, gtk-rs GTK3
  bindings, fxhash) are *allowed* by cargo audit (warnings, not errors) and already tolerated
  by the Makefile's `--ignore` list where relevant. Migrating off them is upstream-gated
  (gtk-rs via tauri) — see AGENTS.md Accepted Security Decisions. **Priority:** P3 hygiene.

### O3. Fold claude into the default_prompt_args template table — STORY `092-c9f2` (2026-07-05, depends on 091)
- **Opportunity:** claude keeps a dedicated bare-append branch while every other agent flows
  through `default_prompt_args` + merge + substitute. Unifying removes the special case.
- **Why not now:** claude's branch puts `--print/--model` *before* the positional prompt;
  the template path appends after. Won't change the most-used spawn path's arg order without
  a live check. **Complexity:** S. **Priority:** P3.

### O4. PTY injection: optional Ctrl-U line-clear prefix
- **Opportunity:** `inject_text_into_pty` writes text + `\r` (mirrors MCP `session input`).
  Frontend `sendCommand` also prefixes Ctrl-U to clear a partial line. Deferred because
  injection only targets idle agents. Revisit if a peer message ever concatenates onto stray
  input. **Complexity:** XS. **Priority:** P3.

### O5. Guard claude-only MCP params on non-claude spawns — DONE (story `093-1e56`, 2026-07-06)
- **Opportunity:** `print_mode`/`output_format` passed for e.g. codex inject `--print`/
  `--output-format` via `merge_mcp_params_into_args` → clap exit 2. Warn or drop claude-only
  params when `agent_type != claude`. **Complexity:** S. **Priority:** P3.
- **Fixed:** `merge_mcp_params_into_args` now takes `agent_type`; `--print`/`--output-format`
  dropped (with `tracing::warn`) for non-claude agents; `--model` stays generic. Both call
  sites pass `rc.agent_type`. 6 new + 6 updated tests (12 green), clippy clean.

### O6. Spot-check each default_prompt_args template against the live CLI — folded into STORY `091-22b7` (criterion 6)
- **Opportunity:** templates mirror `src/agents.ts` (shipped) but weren't run against each
  CLI's current `--help`. Codex `exec` vs bare positional and goose `session` semantics
  deserve a live confirmation. Rolls up into O1's live pass. **Complexity:** S. **Priority:** P2.

## dev-install.sh targets release bundle path, not dev — build-cleaner plan (2026-07-05)

- **Problem/opportunity:** `scripts/dev-install.sh` symlinks plugins into
  `$HOME/Library/Application Support/**tuicommander**/plugins` (release bundle id), but a
  `make dev` build runs under bundle id `**com.fastaf.ide**` and watches
  `$HOME/Library/Application Support/com.fastaf.ide/plugins`. So `dev-install.sh <plugin>`
  does NOT make the plugin visible to a dev build — discovered while loading `build-cleaner`
  into the running `make dev` instance (had to `ln -sfn` into the dev dir by hand).
- **Proposed solution:** In `dev-install.sh`, symlink into BOTH the release and the
  `com.fastaf.ide` dev dir on macOS (and the Linux/Windows dev-vs-release equivalents),
  or detect which app id is installed. A dual-symlink is simplest and idempotent.
- **Expected benefits:** `dev-install.sh` actually works for the primary dev workflow;
  no silent "plugin didn't load" confusion.
- **Trade-offs:** Two symlinks per plugin; negligible. Must mirror the `--clean` path so both
  are removed.
- **Complexity:** S (a second `PLUGINS_DIR` loop). **Priority:** P2 (blocks smooth plugin dev).

## Plugin watcher doesn't hot-load plugins added after boot — build-cleaner plan (2026-07-05)

- **Problem/opportunity:** The plugins dir file-watcher (`[plugins] Watching … for changes`)
  did not load a plugin whose symlink was created AFTER app boot; touching its `manifest.json`
  also didn't trigger discovery. Frontend plugin discovery appears to run once at init; a new
  plugin needs a frontend reload (Cmd+R) or app restart to appear.
- **Proposed solution:** Confirm whether the watcher is meant to hot-add new plugin dirs. If
  yes, have the loader re-scan on a new top-level dir/symlink create event and register it. If
  intentionally boot-only, document it (the "Watching for changes" log implies live add works).
- **Expected benefits:** True plugin hot-install; matches the log's promise.
- **Trade-offs:** Re-scan must debounce and de-dupe already-loaded plugins.
- **Complexity:** M (loader + watcher wiring; verify against existing hot-reload for edits).
- **Priority:** P3 (edit-hot-reload works; only first-time add is affected).
