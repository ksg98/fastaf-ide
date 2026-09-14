# Documentation Sync Matrix

Every code change that affects user-visible behavior, APIs, or configuration MUST update the corresponding documentation files. This matrix maps codebase areas to their docs.

## New Feature Checklist

- [ ] Feature works correctly
- [ ] Keyboard shortcut added (if applicable) — `keybindingDefaults.ts` + `actionRegistry.ts` ACTION_META
- [ ] `docs/FEATURES.md` updated with new feature entry
- [ ] `CHANGELOG.md` — entry in Unreleased section
- [ ] `SPEC.md` — feature status updated
- [ ] Domain-specific docs updated (see matrix below)
- [ ] Screenshot taken (if visual/CSS/layout change)
- [ ] `src/data/tips.ts` — add a Tip of the Day entry for discoverable features

## Sync Matrix by Area

### Plugin System
When modifying PluginHost API, capabilities, manifest schema, Tauri commands used by plugins, plugin panel rendering (base CSS, theme injection, iframe behavior), or plugin infrastructure (loader, registry, discovery):

| File | What to update |
|------|----------------|
| `src/plugins/types.ts` | PluginHost interface, PluginCapability union, snapshot types |
| `src/plugins/pluginRegistry.ts` | Implementation in `buildHost()` |
| `src/components/PluginPanel/pluginBaseStyles.ts` | Base CSS classes available to all plugin panels |
| `src-tauri/src/plugins.rs` | `KNOWN_CAPABILITIES` list (new capabilities); `set_plugin_output_watchers` sync |
| `src-tauri/src/output_watchers.rs` | Rust-side OutputWatcher matching: `WatcherSpec`, `OutputWatcherRegistry::sync` (per-client sets; which patterns are rejected back to the frontend), `to_portable_pattern` (ECMAScript class escapes — Rust may over-match, never under-match), `clean_line` — a **port** of `src/utils/stripAnsi.ts` + the backtick strip — and `StreamLines`, the **only** line assembler. Changing `stripAnsi.ts` requires changing `clean_line`, or the two sides match on different text |
| `src-tauri/src/lib.rs` | Register new Tauri commands in `invoke_handler` |
| `docs/backend/command-threading.md` | Where a new command runs (`fn` = macOS main thread). Update the audit when a command changes placement |
| `docs/plugins.md` | Plugin developer guide (API reference, capabilities table, **Panel CSS Design Strategy** section, examples) |
| `src-tauri/src/mcp_http/plugin_docs.rs` | AI-optimized plugin reference (`PLUGIN_DOCS` const — **must stay in sync with `docs/plugins.md`**) |
| `docs/api/tauri-commands.md` | Tauri commands reference table |
| `docs/api/http-api.md` | HTTP API reference (if new HTTP endpoints) |
| `docs/backend/mcp-http.md` | MCP/HTTP server docs (if new routes) |
| `docs/FEATURES.md` | Section 17.1 capabilities list |
| `docs/user-guide/plugins.md` | User installation/management guide |

### Terminal & PTY
When modifying PTY behavior, output parsing, shell state, or terminal UI:

| File | What to update |
|------|----------------|
| `docs/backend/pty.md` | PTY session lifecycle, reader threads, output handling |
| `docs/backend/output-parser.md` | Rate limits, structured events, parsing rules |
| `docs/frontend/canvas-terminal-audit.md` | CanvasTerminal feature completeness audit |
| `docs/FEATURES.md` | Section 1 (Terminal Management) |
| `docs/user-guide/terminals.md` | User-facing terminal features |
| `docs/api/tauri-commands.md` | PTY commands (create_pty, write_pty, resize_pty, etc.) |
| `docs/backend/alacritty-integration.md` | Alacritty patch inventory, upstream API usage, update procedure |

### Keyboard Shortcuts & Actions
When adding or changing shortcuts:

| File | What to update |
|------|----------------|
| `src/keybindingDefaults.ts` | ACTION_NAMES + default key combo |
| `src/actions/actionRegistry.ts` | ACTION_META (label, category) — auto-populates Settings and Command Palette |
| `src-tauri/src/native_keys.rs` | macOS `NSEvent` monitor for keys WKWebView never forwards (Ctrl+Tab, F13–F20). **Keep it as ONE `KeyDown` monitor** — a second one doubles per-keystroke work on every key typed |
| `src/hooks/useNativeKeyCombo.ts` | Turns `native-key-down` back into a combo string identical to `keyEventToCombo`'s; used by every recorder |
| `docs/FEATURES.md` | Section 15 (Keyboard Shortcut Reference) |
| `docs/user-guide/keyboard-shortcuts.md` | User-facing shortcut table |
| `docs/frontend/hooks.md` | `useNativeKeyCombo` entry |

### Tauri Commands & IPC
When adding or changing Tauri commands:

| File | What to update |
|------|----------------|
| `src-tauri/src/lib.rs` | `invoke_handler!` macro registration |
| `docs/api/tauri-commands.md` | Command signature + description |
| `docs/api/http-api.md` | HTTP endpoint mapping (if browser/remote mode) |
| Domain backend doc | e.g. `docs/backend/pty.md`, `docs/backend/git.md` |

#### Tauri events emitted by backend
When adding a new `app.emit(event_name, payload)` call, document it here and listen in `useAppInit.ts`:

| Event | Payload | Emitted from | Frontend listener |
|-------|---------|-------------|-------------------|
| `session-standby` | `{ session_id: string, standby: bool }` | `pty.rs emit_standby_event()` | `useAppInit.ts` → `terminalsStore.update(termId, { standby })` |
| `worktree-created` | `{ repo_path: string, branch: string, worktree_path: string }` | `mcp_transport.rs`, `session.rs`, `worktree_routes.rs` | TBD — frontend switch prompt |
| `worktree-removed` | `{ repo_path: string, branch: string }` | `state.rs notify_worktree_removed()` — called by EVERY removal path: `worktree.rs` (`remove_worktree`, `finalize_merged_worktree`, `merge_and_archive_worktree`, `delete_local_branch`), `worktree_routes.rs` (`remove_worktree_http`, `finalize_merged_worktree_http`), `mcp_transport.rs` (`repo worktree_remove`) | `useWorktreeSwitchPrompt.ts` → `pruneRemovedWorktree()` closes the branch terminals and drops the sidebar row |
| `repositories-changed` | `{}` — payload-free on purpose. One backend serves the desktop WebView, the browser and the PWA, and each keeps its own compare-and-swap baseline; the receiver only needs "disk moved, re-read it". Shipping the document would copy the whole repository set to every client on every save, including the one that just wrote it. | `state.rs notify_repositories_changed()` — called by both save paths, `config.rs save_repositories` (IPC) and `config_routes.rs put_repositories` (HTTP), and **only when `save_repositories_request` returns `Ok(true)`**, i.e. the delta actually moved the document. Also on `event_bus` for `/events` SSE | `repositories.ts` `startRemoteSync()` (registered by `hydrate`) → re-reads `load_repositories` → `adoptRemoteRepositories()`, which moves the store **and** the persisted baseline together for every key this client has no unsaved intent for. `activeRepoPath` is never adopted — focus is per-window |
| `repo-changed` (git-state) | `{ repo_path: string, kind: "git-state" }` | `repo_watcher.rs` — **only when the git-state fingerprint changed** (index size + resolved HEAD + porcelain status + the sorted `.git/worktrees/*` set; skips no-op `.git` touches). The worktree set is an input because add/remove touches nothing else, so worktree-only changes used to be swallowed and left ghost sidebar rows. Last fingerprint in `AppState.repo_git_fingerprints`. | `useAppInit.ts` → coalesced one bump/repo/frame via `revisionCoalescer` → `repositoriesStore.bumpGitRevision`, which bumps **both** the general and the git revision |
| `repo-changed` (working-tree) | `{ repo_path: string, kind: "working-tree" }` | `repo_watcher.rs` — non-`.git`, non-ignored file changes, debounced 1.5s when the repo is hot (has ≥1 open terminal, `set_hot_repos`) and 15s when cold. Ignore coverage is the **full git set**: the global `core.excludesFile`, the root `.gitignore` plus `.git/info/exclude`, and nested `.gitignore` files. `ALWAYS_EXCLUDED_DIRS` matches on **any path component**, so a nested git repo's `.git/` is treated as noise rather than a working-tree change. No fingerprint guard, but a firing git-state emit **cancels the pending working-tree emit** as a duplicate. Covers the main checkout **and every linked worktree** (`sync_worktree_watches`), which is what keeps a branch's sidebar diff badge live while an agent works in its worktree; the payload always names the parent repo. | `useAppInit.ts` → `revisionCoalescer` → `bumpRevision` (general revision **only**) + debounced `refreshAllBranchStats` |
| `head-changed` | `{ repo_path: string, branch: string }` | `repo_watcher.rs` — **only when the resolved HEAD target changed** (`resolve_head_target`); skips the Linux inotify storm where `.git/HEAD` events recur without HEAD moving (issue #82). Last target in `AppState.repo_head_targets`; suppressed-emit count in `AppState.repo_head_emits_suppressed`. | `useAppInit.ts` → branch rename/activate (also dedupes on `activeBranch === branch`) |
| `review-progress` | `{ repo_path: string, payload: { pr_number, summary, files (COUNT, not the vector — the only consumer reads its length), phase, done, llm_used, llm_model } }` | `diff_triage.rs` `ProgressSink::PrReview` during `run_pr_review`; also sent on `event_bus` for `/events` SSE | `githubOpsStore` listener updates per-PR review progress |
| `conflict-assist-status` | `{ repo_path: string, payload: { pr_number, status, conflicted_files } }` | `conflict_assist.rs` `emit_conflict_assist_status()` lifecycle; also sent on `event_bus` for `/events` SSE | `githubOpsStore` listener updates conflict-assist state |
| `proposals-ready` | `{ repo_path: string, payload: ImprovementScanResult }` | `improvement_scan.rs` after `run_improvement_scan` completes; also sent on `event_bus` for `/events` SSE | `githubOpsStore` listener accumulates proposals for the GitHub Ops dashboard — the sole publisher, since it reaches every window on both transports while the invoke's return value reaches only the caller |
| `ctrl-tab` | `"next"` \| `"prev"` | `native_keys.rs` — macOS only; the `NSEvent` is swallowed so AppKit cannot also cycle tabs | `useNativeMenuBridge.ts` → tab switch |
| `native-key-down` | `{ key: "F13".."F20", cmd, ctrl, alt, shift }` | `native_keys.rs` — macOS only, scoped to the `main` window; the event is passed through (nothing native to suppress) | `useNativeKeyCombo.ts`, attached only while a shortcut recorder is open |
| `mcp-toast` | `{ title, message, level, sound, origin_repo_path?, origin_session_id? }` | `mcp_transport.rs` — `ui action=toast`; derives origin from the calling MCP session rather than accepting caller-supplied scope. `origin_session_id` is the caller's TUIC session, absent for an unbound caller | `useAppInit.ts` → repository-scoped toast + Messages item; the repo is carried as `repoPath`, NOT glued into the message text — `ToastContainer.tsx` renders it as its own badge and uses `origin_session_id` to navigate to the originating terminal on click |
| `mcp-confirm` | `{ request_id, title, message, origin_repo_path?, origin_session_id? }` | `mcp_transport.rs` — `ui action=confirm`, dual-emitted, plus a mobile push. It used to be a native OS dialog, which no remote human could answer; every client now gets the request and the first answer wins | `McpConfirmHost.tsx` (mounted by BOTH `ApplicationOverlays.tsx` and `MobileApp.tsx`) → `stores/mcpConfirm.ts` queue → `ConfirmDialog` |
| `mcp-confirm-resolved` | `{ request_id, confirmed }` | `mcp_http/mod.rs` `resolve_mcp_confirm()` on an answer, and `mcp_transport.rs` when the 300 s wait expires | `McpConfirmHost.tsx` → drops that request from the queue, so the clients that lost the race take the dialog down |
| `pty-description-changed` | `{ session_id: string, description: string | null }` | `state.rs` — MCP `agent spawn` / `session submit` / `session input` updates the orchestrator-owned PTY description | `useAppInit.ts` → `terminalsStore.ptyDescription` → Context bar |
| `pty-activity-{session_id}` | `{ session_id: string }` | `pty.rs emit_pty_activity()` via `ActivityPulse`, throttled to one pulse per `ACTIVITY_PULSE_WINDOW` (1 s). Payload-free and idempotent, so dropping pulses inside the window loses nothing — do NOT convert this throttle into a coalescer. Dual-emitted on `event_bus` as `PtyActivity` (`activity` WS frame on `/sessions/:id/stream`, plus `pty-activity` SSE); deliberately NOT forwarded on the `?format=grid` WS, which has no activity consumer. Ignored by `apply_event_to_session_state` — it must not restamp `SessionState.last_activity_ms`, which answers a different question | `Terminal.tsx` → `subscribePty(…, { onActivity })` → `terminalsStore.touchLastDataAt` + background-tab `activity` flag. **Not** in `useAppInit.ts` — per-session |
| `pty-osc133-{session_id}` | `{ marker: string, line: number, exit_code: number \| null }` | `pty.rs` OSC 133 handler — serialised from `terminal_grid.rs Osc133Event`, so the field name is `exit_code`, NOT `exitCode`. Dual-emitted on `event_bus` as `PtyOsc133` (`osc133` frame on the `?format=grid` WS via `grid_ws_frame()`, plus `pty-osc133` SSE); the grid WS is the right lane because `CanvasTerminal` is the only consumer and it already holds that socket. Ignored by `apply_event_to_session_state` | `CanvasTerminal.tsx` → `transport.onEvent("osc133", …)` → `terminalsStore.handleOsc133()` → command blocks, gutter marks, Cmd+Up/Down. **Not** in `useAppInit.ts` — per-session |
| `pty-cwd-{session_id}` | `{ cwd: string }` | `pty.rs` OSC 7 handler. The desktop payload is the `{ cwd }` object, not a bare string — both transports carry the same shape so the handler needs no branch. Dual-emitted on `event_bus` as `PtyCwd` (`cwd` frame on the `?format=grid` WS, plus `pty-cwd` SSE). Ignored by `apply_event_to_session_state` | `CanvasTerminal.tsx` → `transport.onEvent("cwd", …)` → `terminalsStore.update({ cwd })` + `onCwdChange`. **Not** in `useAppInit.ts` — per-session |
| `pty-watcher-lines-{session_id}` | `{ session_id: string, lines: [{ text: string, matched_ids: string[] }] }` | `pty.rs emit_watcher_lines()` — one emit per 100 ms batch of assembled lines; `text` is the CLEANED text Rust matched on, `matched_ids` are qualified `client_id/watcher_id`. Rust ships every line only while a registered pattern could not be compiled, otherwise the matched ones alone. Dual-emitted on `event_bus` as `PluginWatcherLines` (`watcher-lines` WS frame on `/sessions/:id/stream` in both `?format=grid` and raw mode — **not** `?format=log|text`, which returns before the event loop — plus `plugin-watcher-lines` SSE) | `CanvasTerminal.tsx` → `transport.onEvent("watcher-lines", …)` → `pluginRegistry.handleWatcherLines()`, which re-runs the JS `RegExp` on each line. The listener is installed BEFORE the grid subscription — a line that lands while it is being attached is lost. **Not** in `useAppInit.ts` — the listener is per-session |

### HTTP & MCP Server
When adding routes or changing server behavior:

| File | What to update |
|------|----------------|
| `docs/api/http-api.md` | REST endpoint reference |
| `docs/backend/mcp-http.md` | Server architecture, routing, lazy tool discovery (`collapse_tools` / meta-tools) |
| `docs/user-guide/remote-access.md` | User setup guide |
| `src-tauri/src/mcp_http/plugin_docs.rs` | PLUGIN_DOCS (if plugin-facing) |

### Diagnostics
When modifying `cpu_watchdog.rs` or the `/diagnostics` HTTP endpoint:

| File | What to update |
|------|----------------|
| `src-tauri/src/cpu_watchdog.rs` | Watchdog logic, thresholds, snapshot fields |
| `src-tauri/src/mcp_http/log_routes.rs` | `/diagnostics` GET/POST handlers |
| `AGENTS.md` | Diagnostics section (usage, known failure patterns) |
| `docs/FEATURES.md` | Section 20.11 (Runtime Diagnostics) |

### Agent state detection (working / idle / awaiting)
When changing an awaiting/idle/busy signal — a parser, the hook suppression, or the raw-stream composition:

| File | What to update |
|------|----------------|
| `src-tauri/src/output_parser.rs` | The parser itself (`parse_question`, `parse_osc777_notify`, …) |
| `src-tauri/src/chrome.rs` | Bottom-zone cutoff — anything at or below the input box must stay unparsed |
| `src-tauri/src/pty.rs` | `raw_stream_events` composition + `suppress_heuristic_question` gating |
| `src-tauri/src/state.rs` | `apply_event_to_session_state` — the arms that SET and CLEAR `awaiting_input`. A signal nothing retracts latches the badge |
| `src/components/Terminal/Terminal.tsx` | The frontend twin of those arms (`terminalsStore` awaiting flags) |
| `src-tauri/src/fixtures/agent_prompts/` | A framed `.tcap` capture of the failure, recorded via `/diagnostics/capture` (`.raw` remains legacy-readable) |
| `src-tauri/src/pty.rs` tests | A case in the `Awaiting-signal fixtures` block replaying that capture |
| `src-tauri/src/pty.rs` tests | A case in the `Awaiting RETRACTION` block when the failure is a state that never clears — fixtures assert emitted events and cannot express a MISSING one |
| `AGENTS.md` | "Agent state detection" section (signal table, capture workflow, retraction) |

### MCP Tool Surface (native tools, upstream proxy, meta-tools)
When changing the tool list, tool handlers, `disabled_native_tools`, upstream allow/deny filters, or the Speakeasy meta-tools:

| File | What to update |
|------|----------------|
| `src-tauri/src/mcp_http/mcp_transport.rs` | Tool definitions, `merged_tool_definitions`, `searchable_tool_definitions`, meta-tool handlers (`search_tools`, `get_tool_schema`, `call_tool`), `build_mcp_instructions` |
| `src-tauri/src/mcp_proxy/registry.rs` | `aggregated_tools`, `proxy_tool_call` (filter is enforced on BOTH — discovery no longer gates dispatch under `collapse_tools`) |
| `src-tauri/src/tool_search.rs` | BM25 `ToolSearchIndex` backing `search_tools` / `get_tool_schema` |
| `docs/backend/mcp-http.md` | Lazy Tool Discovery section, meta-tool table, filter-enforcement note |
| `docs/backend/config.md` | `collapse_tools` field in `AppConfig` table |
| `docs/user-guide/settings.md` | Services Tab — "Collapse tools" checkbox description |

#### Session tool actions added (swarm Layer 3–4)
- `session action=submit` — submits one command to a confirmed-idle managed agent and returns a bounded terminal-movement receipt in the same response. It never queues or overwrites a partial composer; `session action=input` remains raw and write-only.
- `session action=status` — returns `{shell_state, idle_since_ms, busy_duration_ms, exit_code, agent_type}`. Useful for polling agent progress without streaming output.
- `session action=list` response now includes `shell_state` per entry.

#### Agent tool actions added (swarm inbox)
- `agent action=inbox` response now includes `missed_count` — number of messages evicted from the FIFO inbox since last read. Non-zero means the orchestrator missed messages and should increase polling frequency.
- `agent action=send` response includes **`delivered`** (bool) plus, when false, `warning` and `recipient_has_terminal`. `delivered` is false exactly when `delivery_path == "inbox_only"`: no waiter, channel, direct terminal delivery, or already-pending coalesced orchestrator wake will surface it, so it stays unread until the recipient polls. Registered orchestrators add `wake_notification_and_inbox`, `coalesced_wake_and_inbox` and `lifecycle_summary_and_inbox`; none of them exposes a peer payload — the last one is reachable only for a window made entirely of server-authored `tuic-auto-*` lifecycle notifications, which it prints inline and acknowledges itself. A payload-free wake gets at most one retry after an uncertain PTY write per unread-mail group; coalesced mail does not reset that budget, and inbox/wait observation does. `accepted`/`ok` only mean "buffered". Keep these distinct in every client and in the tool descriptions — reporting `inbox_only` as success is how a reply to an agent with no PTY silently vanished.
- `agent action=register` response includes **`terminal`** (bool): false means the identity resolves to no live PTY (`live_pty_for_peer` → `None`), so it can never be typed into or woken, and the peer must consume its own inbox via `wait`/`inbox`. Identities without a PTY arise from a bridge that sent no `x-tuic-session` header (agent launched outside a TUIC PTY) — the server then mints an MCP-scoped UUID.
- `agent action=register` accepts **`orchestrator`** (bool) as the only role declaration seam; omission preserves the current role and child spawn never infers it. Register/list responses surface `orchestrator` plus **`mail_wake`** (`managed_pty_lifecycle` or `none`). External/headerless orchestrators are inbox/wait-only because MCP/SSE activity is not an authoritative idle or wake surface.

### Provider Registry
When modifying provider types, slot names, credential storage, or the ProvidersTab UI:

| File | What to update |
|------|----------------|
| `src-tauri/src/provider_registry.rs` | `ProviderType`, `SlotName`, `ProviderRegistry` structs + Tauri commands |
| `src-tauri/src/credentials.rs` | `Credential::Provider` variant for per-provider key storage |
| `src/stores/providerRegistry.ts` | Frontend store: hydrate, save, slot resolution, CRUD |
| `src/components/SettingsPanel/tabs/ProvidersTab.tsx` | Settings UI: provider cards, model CRUD, slot assignments |
| `src/hooks/useSmartPrompts.ts` | `resolveSlot("headless")` check for headless execution |
| `docs/backend/config.md` | `providers.json` schema documentation |

### AI Prompts
When modifying customizable AI service prompts (diff triage, future services):

| File | What to update |
|------|----------------|
| `src-tauri/src/config.rs` | `AiPromptsConfig` struct, load/save commands |
| `src-tauri/src/diff_triage.rs` | `build_chat_request` system_prompt param, `default_system_prompt()` |
| `src/stores/aiPrompts.ts` | Frontend store: hydrate, save, `DEFAULT_DIFF_TRIAGE_PROMPT` const |
| `src/components/SettingsPanel/tabs/AiPromptsTab.tsx` | Settings UI: textarea per service, reset button |
| `src-tauri/src/mcp_http/mcp_transport.rs` | MCP config tool: `list_ai_prompts`, `load_ai_prompt`, `save_ai_prompt` actions |
| `docs/backend/config.md` | `ai-prompts.json` schema documentation |

### AI Chat
When modifying AI Chat panel, settings, context menu actions, or streaming backend:

| File | What to update |
|------|----------------|
| `src-tauri/src/ai_chat.rs` | Backend: config, streaming, context assembly, Ollama detection |
| `src-tauri/src/ai_chat_registry.rs` | Chat Registry: cross-window state sync, Channel fan-out, subscribe/unsubscribe |
| `src/stores/aiChatStore.ts` | Frontend store: messages, streaming state, registry subscription (sessionId passed per-call, derived from focused terminal) |
| `src/components/AIChatPanel/AIChatPanel.tsx` | Chat panel component + detach button + registry lifecycle + the optional `terminal` binding a detached window is handed |
| `src/panelAdapters/aiChat.tsx` | Detached-window adapter: params handed over at detach, terminal + chat id adoption on mount, re-read on reattach |
| `src/components/AIChatPanel/contextMenuActions.ts` | Terminal context menu integration |
| `src/components/PanelOrchestrator.tsx` | Switches between AIChatPanel and DetachedPlaceholder |
| `src/components/DetachedPlaceholder.tsx` | Placeholder shown in main window when panel is detached |
| `src/components/SettingsPanel/tabs/AiChatTab.tsx` | Settings panel section |
| `src/stores/ui.ts` | `aiChatPanelVisible` + `detachedPanels` map |
| `src/panelRouter.tsx` | Panel adapter registry + routing for detached panel windows |
| `src/utils/panelSync.ts` | PanelSyncProvider + PanelSyncReceiver for main↔detached communication |
| `src/hooks/initPanelWindow.ts` | Bootstrap for detached panel windows (theme, font, settings) |
| `src/keybindingDefaults.ts` | `toggle-ai-chat` + `detach-activity-dashboard` hotkeys |
| `docs/FEATURES.md` | AI Chat feature section |
| `docs/user-guide/ai-chat.md` | User-facing AI Chat guide |
| `docs/api/tauri-commands.md` | Chat Registry + `open_panel_window` / `close_panel_window` / `focus_main_window` commands |

### Extended thinking (Opus 4.7+ reasoning)
When modifying reasoning effort, the thinking stream, or its gating:

| File | What to update |
|------|----------------|
| `src-tauri/src/ai_agent/conversation_engine.rs` | `ReasoningLevel`, `supports_extended_thinking`, `resolve_reasoning`, `ConversationEvent::ReasoningChunk`, ChatOptions build + `captured_content` (thinking+signature) append |
| `src-tauri/src/ai_agent/commands.rs` | `reasoning_effort` param + persisted-config fallback + 50ms ReasoningChunk batching |
| `src-tauri/src/ai_chat.rs` | `AiChatConfig.reasoning_effort` field |
| `src/stores/conversationStore.ts` | `reasoning_chunk` event + `reasoningChunks` signal + reset on new turn |
| `src/components/AIChatPanel/AIChatPanel.tsx` | "Thinking" disclosure render |
| `src/components/SettingsPanel/tabs/AiChatTab.tsx` | Extended-thinking effort dropdown |

### AI Agent (ReAct loop, knowledge store, MCP terminal tools)
When modifying the AI agent loop engine, tool dispatch, session knowledge store,
OSC 133 outcome capture, or the `ai_terminal_*` MCP tools:

| File | What to update |
|------|----------------|
| `src-tauri/src/ai_agent/engine.rs` | ReAct loop, approval flow, ACTIVE_AGENTS registry, system prompt |
| `src-tauri/src/ai_agent/tools.rs` | Tool dispatch: 31 tools (terminal observe incl. get_command_history/explain_last_failure/get_error_fixes/search_scrollback/get_hyperlinks/get_semantic_zones, reactive watches watch_for/list_watches/cancel_watch, filesystem, drive_agent, search, list_sessions). Tool count assertions live in tools.rs `#[cfg(test)]` — bump them on add/remove |
| `src-tauri/src/terminal_grid.rs` | Grid reader methods backing agent tools: `search_buffer`, `enumerate_visible_hyperlinks` (get_hyperlinks), `extract_semantic_zones` (get_semantic_zones); `VtLogBuffer` delegates in `state.rs` |
| `src-tauri/src/ai_agent/safety.rs` | SafetyChecker: command safety + file-write sensitive path rules |
| `src-tauri/src/ai_agent/sandbox.rs` | FileSandbox: path jail for filesystem tools (canonicalize + starts_with) |
| `src-tauri/src/mcp_http/ai_terminal.rs` | MCP exposure of all 13 `ai_terminal_*` tools; write-tool confirmation |
| `src-tauri/src/ai_agent/knowledge.rs` | CommandOutcome, SessionKnowledge, OSC 133 scanner, persist/load/spawn_persist_task |
| `src-tauri/src/ai_agent/context.rs` | Session-knowledge injection into agent system prompt |
| `src-tauri/src/ai_agent/tui_detect.rs` | TerminalMode heuristics (Shell vs FullscreenTui) |
| `src-tauri/src/ai_agent/commands.rs` | Tauri commands: start/cancel/pause/resume/status/approve/get_session_knowledge |
| `src-tauri/src/pty.rs` | ChunkProcessor.record_osc133_outcomes + Inferred fallback in silence timer |
| `src-tauri/src/state.rs` | session_knowledge DashMap, knowledge_dirty set, has_osc133_integration, record_outcome helper |
| `src-tauri/src/lib.rs` | Register new commands in `invoke_handler`; spawn_persist_task at boot |
| `src-tauri/src/mcp_http/mcp_transport.rs` | `ai_terminal_*` MCP tool defs + dispatch |
| `src/stores/aiAgentStore.ts` | Frontend agent state (running/paused), tool-call log, approvals |
| `src/components/AIChatPanel/AIChatPanel.tsx` | Agent banner, approval card, tool-call cards |
| `src/components/AIChatPanel/SessionKnowledgeBar.tsx` | Collapsible footer summarising the session's knowledge store |
| `docs/api/tauri-commands.md` | `start_agent_loop`, `cancel_agent_loop`, `pause_agent_loop`, `resume_agent_loop`, `agent_loop_status`, `approve_agent_action`, `get_session_knowledge` |
| `docs/backend/mcp-http.md` | `ai_terminal_*` MCP tools table |
| `docs/FEATURES.md` | AI Agent section (Level 2/3 of the AI-assisted terminal roadmap) |
| `ideas/ai-assisted-terminal.md` | Status updates as capability levels ship |

### Terminal Watcher (event-driven autonomous actions)
When modifying the watcher engine, trigger evaluation, or watcher UI:

| File | What to update |
|------|----------------|
| `src-tauri/src/ai_agent/watcher.rs` | WatcherRule model, WatcherEngine event loop, trigger evaluation, burst guard, fire_rule |
| `src-tauri/src/ai_agent/commands.rs` | Tauri commands: watcher_create, watcher_list, watcher_delete, watcher_toggle, watcher_attach, watcher_detach, watcher_update |
| `src-tauri/src/state.rs` | `watcher_engine` OnceLock in AppState, `session_visibility` DashMap |
| `src-tauri/src/lib.rs` | Command registration + WatcherEngine spawn |
| `src/components/WatcherManager/WatcherManager.tsx` | Template CRUD, attach/detach, edit form (toolbar popover) |
| `src/components/WatcherManager/WatcherManager.module.css` | Popover styles |
| `docs/backend/ai-watchers.md` | Architecture doc: data model, trigger paths, safety guards |
| Config: `ai-watchers.json` | Persisted watcher rules (app config dir) |

### Remote Daemon (`tuic-remote`)
When modifying the remote daemon binary, `run_headless`, or standalone server behavior:

| File | What to update |
|------|----------------|
| `src-tauri/src/bin/tuic_remote.rs` | Binary entry point |
| `src-tauri/src/lib.rs` | `run_headless()` function |
| `docs/user-guide/remote-access.md` | `tuic-remote (Beta)` section |
| `docs/FEATURES.md` | Section 22 (Remote Daemon) |
| `.github/workflows/release.yml` | Release artifact build job |

### SSH Tunnel Management
When modifying tunnel profiles, supervisor, audit logging, backoff, or tunnel UI:

| File | What to update |
|------|----------------|
| `src-tauri/src/tunnels/profile.rs` | TunnelProfile, ForwardSpec, ProfileOptions structs |
| `src-tauri/src/tunnels/command.rs` | SSH command-line argument building |
| `src-tauri/src/tunnels/classifier.rs` | ExitReason enum and stderr classification |
| `src-tauri/src/tunnels/agent.rs` | SSH agent socket discovery |
| `src-tauri/src/tunnels/port.rs` | Local port availability check |
| `src-tauri/src/tunnels/backoff.rs` | BackoffCalculator (delays, jitter, max retries) |
| `src-tauri/src/tunnels/audit.rs` | AuditLog SQLite schema, insert/query/rotate |
| `src-tauri/src/tunnels/supervisor.rs` | TunnelSupervisor lifecycle and reconnect loop |
| `src-tauri/src/tunnels/storage.rs` | ProfileStore: TOML load/save (global + per-repo) |
| `src-tauri/src/tunnels/manager.rs` | TunnelManager: orchestrates supervisors |
| `src-tauri/src/tunnels/commands.rs` | Tauri commands for tunnel CRUD and control |
| `src/stores/tunnels.ts` | Frontend tunnel state (profiles, statuses) |
| `src/stores/tunnelPanel.ts` | Tunnel panel UI state |
| `src/components/TunnelsPanel/TunnelsPanel.tsx` | Tunnel list with start/stop controls |
| `src/components/TunnelsPanel/TunnelEditorModal.tsx` | Profile create/edit form |
| `src/components/TunnelsPanel/TunnelStatusBadge.tsx` | Color-coded status indicator |
| `docs/features/ssh-tunnels.md` | Feature architecture doc |
| `docs/FEATURES.md` | Section 23 (SSH Tunnel Manager) |
| `docs/user-guide/remote-access.md` | SSH Tunnel Management section |

### Remote Connection Manager
When modifying remote connection config, storage, or transport routing:

| File | What to update |
|------|----------------|
| `src-tauri/src/remote_connection.rs` | RemoteConnection, RemoteTransport, RemoteConnectionStore |
| `src/stores/remoteConnections.ts` | Frontend remote connections store |
| `src/utils/remoteEventBridge.ts` | SSE event bridge for remote daemons |
| `src/utils/transport.ts` | connectionId-based routing in COMMAND_TABLE |
| `src/utils/canvasTerminalTransport.ts` | baseUrl support for remote WebSocket |
| `docs/FEATURES.md` | Section 24 (Remote Connection Manager) |
| `docs/user-guide/remote-access.md` | Remote Connection Manager section |

### Git & Worktree Integration
When modifying git operations, worktree logic, or GitHub API:

| File | What to update |
|------|----------------|
| `docs/backend/git.md` | Git command lifecycle, diff parsing, **GitReads port (gix vs CLI op split)**, moka cache |
| `src-tauri/src/git_reads.rs` | **GitReads port**: flipping an op to gix requires a green byte-parity shootout test first |
| `docs/backend/github.md` | PR fetching, CI checks, GraphQL |
| `docs/user-guide/worktrees.md` | Worktree workflow, configuration |
| `docs/user-guide/github-integration.md` | PR monitoring, CI rings |
| `docs/FEATURES.md` | Sections 7 (Git) and 8 (GitHub) |
| `docs/api/tauri-commands.md` | Git/worktree commands |

### Settings & Configuration
When adding config fields or settings UI:

| File | What to update |
|------|----------------|
| `docs/backend/config.md` | Config files, schema, platform directories |
| `docs/user-guide/settings.md` | Settings tab breakdown |
| `docs/FEATURES.md` | Section 11 (Settings) |

### Agent Detection
When adding agents or changing detection logic:

| File | What to update |
|------|----------------|
| `docs/user-guide/ai-agents.md` | Agent support, detection method |
| `docs/backend/output-parser.md` | Agent-specific parsing rules |
| `docs/FEATURES.md` | Section 6 (AI Agent Support) |
| `src-tauri/src/mcp_http/plugin_docs.rs` | agentTypes valid values in PLUGIN_DOCS |

### UI Components & Panels
When adding or modifying panels, status bar, toolbar, sidebar:

| File | What to update |
|------|----------------|
| `docs/FEATURES.md` | Relevant section (2-5: Sidebar, Panels, Toolbar, Status Bar) |
| `docs/frontend/STYLE_GUIDE.md` | If changing visual patterns |
| `docs/frontend/components.md` | Component tree, panel descriptions |
| Domain user guide | e.g. `docs/user-guide/sidebar.md`, `docs/user-guide/file-browser.md` |

### Markdown Inline Review Comments (tweaks) & Highlight Rendering
When modifying the tweak-comment format, the selection/popover UI, or the DOM highlight wrapping:

| File | What to update |
|------|----------------|
| `src/utils/tweakComments.ts` | Marker format, parse/insert/remove/update, sentinels, convention header |
| `src/utils/tweakDomHighlight.ts` | DOM-side sentinel→`.tweak-highlight` span wrapping |
| `src/components/MarkdownTab/CommentOverlay.tsx` | Floating Comment button + inline popover + hover tooltip |
| `src/components/MarkdownTab/MarkdownTab.tsx` | Save/delete wiring, write-back to disk |
| `src/components/ui/ContentRenderer.tsx` | Sentinel injection + `applyTweakDomHighlights` on render (shared with the AI Chat panel) |
| `docs/FEATURES.md` | Section 3.3 (Markdown Panel) — Inline review comments |

### TUIC SDK & iframe Integration
When modifying the TUIC SDK, iframe postMessage protocol, path resolution, or tab injection:

| File | What to update |
|------|----------------|
| `src/components/PluginPanel/tuicSdk.ts` | Inline SDK script for plugin iframes |
| `src/components/PluginPanel/resolveTuicPath.ts` | Path resolution (relative/absolute, traversal guard) |
| `src/components/PluginPanel/PluginPanel.tsx` | Host-side message handlers, SDK injection |
| `docs/tuic-sdk.md` | SDK reference — API methods, path resolution, testing |
| `docs/examples/sdk-test.html` | Interactive test page (update when adding SDK methods) |
| `docs/plugins.md` | Plugin developer guide (if plugin-facing API changes) |

### Deep Links
When adding or changing `tuic://` schemes:

| File | What to update |
|------|----------------|
| `docs/FEATURES.md` | Section 17.4 (Deep Links) |
| `docs/plugins.md` | If affecting plugin contentUri format |

### Documentation Site (mdBook + Pagefind)
When adding, renaming or moving a docs page:

| File | What to update |
|------|----------------|
| `docs/SUMMARY.md` | **Required** — mdBook only renders, and Pagefind only indexes, chapters listed here. A file that is not in `SUMMARY.md` is invisible to readers and to search |
| `docs/index.md` | "Popular articles" cards and "Browse by section" list, if the page belongs there |
| `scripts/build-docs.sh` | Only when the pipeline changes (excluded pages, Pagefind flags, HTML rewrites) — CI and `make docs` both run this one script |
| `docs/guides/development-setup.md` | "Documentation Site" section, if the build steps change |

## Documentation File Index

| Path | Purpose |
|------|---------|
| **Root** | |
| `SPEC.md` | Feature specification, architecture, version |
| `CHANGELOG.md` | Release history (Keep a Changelog format) |
| `AGENTS.md` | Project rules, compact reference |
| `CONTRIBUTING.md` | Contributor guide (test requirements, PR quality gates) |
| `to-test.md` | Manual testing tracker |
| **docs/** | |
| `docs/FEATURES.md` | Canonical feature inventory (single source of truth) |
| `docs/plugins.md` | Plugin developer authoring guide |
| `docs/tuic-sdk.md` | TUIC SDK reference (inline + URL tab postMessage protocol) |
| `docs/api/tauri-commands.md` | All Tauri IPC commands |
| `docs/api/http-api.md` | REST/HTTP endpoint reference |
| `docs/architecture/overview.md` | High-level architecture |
| `docs/architecture/data-flow.md` | IPC and data flow |
| `docs/architecture/state-management.md` | Store patterns |
| `docs/backend/pty.md` | PTY session lifecycle |
| `docs/backend/output-parser.md` | Output parsing and structured events |
| `docs/backend/git.md` | Git operations |
| `docs/backend/github.md` | GitHub API integration |
| `docs/backend/config.md` | Configuration file management |
| `docs/backend/mcp-http.md` | MCP/HTTP server, lazy tool discovery, meta-tools |
| `docs/backend/dictation.md` | Whisper voice dictation |
| `docs/backend/error-classification.md` | Error types and backoff |
| `docs/frontend/STYLE_GUIDE.md` | Visual design rules |
| `docs/frontend/components.md` | Component tree reference |
| `docs/frontend/hooks.md` | Custom hooks |
| `docs/frontend/stores.md` | SolidJS stores |
| `docs/frontend/transport.md` | Tauri/HTTP dual-mode transport |
| `docs/frontend/utilities.md` | Utility function reference |
| `docs/features/ssh-tunnels.md` | SSH tunnel architecture and module map |
| `docs/user-guide/*.md` | User-facing guides (20 files) |
| **Code-embedded docs** | |
| `src-tauri/src/mcp_http/plugin_docs.rs` | AI-optimized plugin reference (`PLUGIN_DOCS` const) |
| `src/actions/actionRegistry.ts` | ACTION_META → auto-populates HelpPanel + Command Palette |
| `examples/plugins/` | Reference plugin implementations (7 examples) |
