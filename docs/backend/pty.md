# PTY Management

**Module:** `src-tauri/src/pty.rs`

Manages pseudo-terminal sessions for all terminal tabs in the application.

## Session Lifecycle

```
create_pty() / create_pty_with_worktree()
    │
    ├── Resolve shell (platform default or user override)
    ├── Build shell command via portable-pty CommandBuilder
    ├── Spawn PTY pair (master + child process)
    ├── Store PtySession in AppState.sessions (DashMap)
    ├── Create OutputRingBuffer for MCP access
    ├── Spawn reader thread (background, non-blocking)
    │
    ▼
Session Active: write_pty() / resize_pty() / pause_pty() / resume_pty()
    │
    ▼
close_pty(cleanup_worktree)
    ├── Remove session from DashMap
    ├── Kill child process
    ├── Remove output buffer
    └── Optionally remove associated git worktree
```

## Tauri Commands

### Session Creation

| Command | Description |
|---------|-------------|
| `create_pty(config: PtyConfig)` | Spawn a new PTY session. Returns session ID. |
| `create_pty_with_worktree(pty_config, worktree_config)` | Create worktree + spawn PTY in it. Returns `WorktreeResult`. |

### Session Control

| Command | Description |
|---------|-------------|
| `write_pty(session_id, data)` | Write data (user input) to the PTY. |
| `resize_pty(session_id, rows, cols)` | Resize the PTY terminal dimensions. |
| `pause_pty(session_id)` | Pause the reader thread (stops output emission). |
| `resume_pty(session_id)` | Resume the reader thread. |
| `close_pty(session_id, cleanup_worktree)` | Close PTY and optionally remove worktree. |
| `update_session_cwd(session_id, cwd)` | Update session's working directory (called from frontend on OSC 7). |

### Monitoring

| Command | Description |
|---------|-------------|
| `get_orchestrator_stats()` | Active/max/available session counts. |
| `get_session_metrics()` | Total spawned, failed, bytes emitted, pauses. |
| `can_spawn_session()` | Check if under MAX_CONCURRENT_SESSIONS (50). |
| `list_active_sessions()` | List all sessions with cwd and worktree info. |
| `list_worktrees()` | List all managed worktrees. |
| `get_process_stats()` | CPU% and RSS for TUIC + all child process trees (desktop Tauri command). |
| `collect_process_stats(state)` | Same logic, callable from HTTP routes and MCP tools. |

## Reader Thread

Each session spawns a dedicated reader thread that reads from the PTY master fd:

```rust
spawn_reader_thread(reader, paused, session_id, app, state)
```

**Processing pipeline per read:**

1. Read raw bytes from PTY master (up to 64KB buffer for natural burst batching)
2. Strip Kitty keyboard protocol sequences (non-printable noise for consumers)
3. Push through `Utf8ReadBuffer` — accumulates bytes until valid UTF-8 boundary, returns safe string
4. Push through `EscapeAwareBuffer` — holds incomplete ANSI escape sequences (CSI, OSC, etc.)
5. Feed into `VtLogBuffer` for VT100-aware log extraction (mobile/MCP consumers)
6. Write to `OutputRingBuffer` (64KB circular buffer for MCP access)
7. Serialize parsed events once with `serde_json::to_value` — reused for both Tauri IPC and event bus (avoids double serialization)
8. Broadcast to WebSocket clients (if any connected)
9. Emit Tauri event `pty-output` with `{session_id, data}` — **throttled to ~10/s** (≥100ms between emits). The desktop canvas renders from grid frames and discards this text (it only drives the frontend activity dot / `lastDataAt`); emitting per-chunk flooded the WebView main thread under output storms (`yes`), starving keydown so Ctrl+C never reached `write_pty`. Dropping intermediate chunks is safe — only a periodic "output happened" pulse is needed.

**Cursor-up clamping** — The `clamp_cursor_up()` function limits `ESC[nA` (cursor up) and `ESC[nF` (cursor previous line) sequences to prevent them from moving the cursor beyond the visible viewport. This replaced the previous DiffRenderer approach for simpler escape sequence handling.

**ANSI anomaly detection** — The `detect_anomalous_sequences()` function scans PTY output for unusual escape sequences (screen clears, cursor home, alt-screen toggles, scrollback clears) and logs them at warn level. This is a diagnostic tool for investigating scroll-jump issues.

**Pause behavior:** When `paused` flag is set (`AtomicBool`), the reader thread sleeps for 50ms instead of reading. This prevents output flooding during background operations.

**Exit detection:** When the read returns 0 bytes or an error, the thread:
1. Flushes remaining buffered data
2. Emits `pty-exit` event with exit code
3. Removes session from `AppState.sessions`
4. Updates metrics (decrement `active_sessions`)

### Frame Emission Pipeline

Frame emission is decoupled from PTY reading via a per-session **frame ticker** thread (same approach as iTerm2's Metal display-link renderer):

1. **Reader thread**: processes PTY data into the alacritty VT grid, sets a `grid_frame_dirty` AtomicBool flag
2. **Ticker thread**: every 16ms, checks the dirty flag → if set, serializes dirty rows via `serialize_dirty_rows()` → sends frame via `send_grid_frame()` (respects `grid_frame_in_flight` backpressure)
3. **Frontend**: coalesces paint triggers via `requestAnimationFrame` (~60fps)
4. **Ack handler**: clears only the in-flight flag; the ticker sends any dirty rows accumulated while the prior frame was in flight

This coalesces rapid writes (e.g. spinner CR+erase+rewrite within 16ms) into a single frame, eliminating flicker from intermediate erase states. The ticker exits when the reader's `running` flag clears, with a final flush to avoid losing the last frame.

### Headless Reader Thread

`spawn_headless_reader_thread()` — used for HTTP-created sessions (no Tauri app handle). Same pipeline but skips Tauri event emission; only writes to ring buffer and WebSocket. Includes `extract_question_line()` for silence-based question detection, session lifecycle events (`session-created`, `session-closed`), and full output parser integration.

Named agent sessions propagate their stable `display_name` through the
`session-created` event. Desktop and browser clients mark that initial tab name
as custom, preserving it across OSC title and structured intent updates as well
as frontend reconnection. Unnamed tabs retain the normal dynamic-title behavior.

## Shell Resolution

```rust
pub(crate) fn resolve_shell(override_shell: Option<String>) -> String
```

Priority:
1. User override from settings (`override_shell`)
2. Platform default via `default_shell()`

Platform defaults:
- macOS: `/bin/zsh`
- Linux: `$SHELL` environment variable, fallback `/bin/bash`
- Windows: `powershell.exe`

## Buffer Types

### Utf8ReadBuffer

Handles the case where a multi-byte UTF-8 character (e.g., emoji, CJK) is split across two reads:

```rust
impl Utf8ReadBuffer {
    fn push(&mut self, new_bytes: &[u8]) -> String  // Returns valid UTF-8, keeps remainder
    fn flush(&mut self) -> String                     // Force-flush (lossy conversion)
}
```

### EscapeAwareBuffer

Prevents ANSI escape sequences from being split between two emissions. Detects incomplete CSI (`\x1b[...`), OSC (`\x1b]...`), and other escape sequences:

```rust
impl EscapeAwareBuffer {
    fn push(&mut self, input: &str) -> String  // Returns safe-to-emit portion
    fn flush(&mut self) -> String              // Force-flush buffered escapes
}
```

### OutputRingBuffer

Fixed-capacity circular buffer (64KB) that stores recent output for MCP access:

```rust
impl OutputRingBuffer {
    fn write(&mut self, data: &[u8])                    // Append data
    fn read_last(&self, limit: usize) -> (Vec<u8>, u64) // Read last N bytes
}
```

### VtLogBuffer

**Module:** `src-tauri/src/state.rs`

VT100-aware extractor that captures clean log lines from PTY output. Designed for mobile/browser clients that need readable text without ANSI noise or TUI screen garbage.

```rust
impl VtLogBuffer {
    fn new(rows: u16, cols: u16, capacity: usize) -> Self  // Create with terminal size
    fn process(&mut self, data: &[u8]) -> Vec<ChangedRow>   // Feed raw PTY bytes, return changed rows
    fn resize(&mut self, rows: u16, cols: u16)              // Update terminal dimensions
    fn screen_rows(&self) -> Vec<String>                    // Current VT100 screen content (for slash menu detection)
    fn screen_log_lines(&self) -> Vec<LogLine>              // Styled screen rows for mobile/REST (structural tokens stripped)
    fn trim_agent_chrome(&mut self, rows: &[ChangedRow]) -> Vec<ChangedRow> // Strip agent prompt/chrome from full-screen redraws
    fn lines_since_owned(&self, offset: usize, limit: usize) -> (Vec<LogLine>, usize) // Paginated reads (absolute offset, structural tokens stripped)
    fn total_lines(&self) -> usize                          // Monotonic counter (never decreases on eviction)
    fn oldest_offset(&self) -> usize                        // Absolute offset of oldest retained line
}
```

**`ChangedRow`** — describes a row that changed between two `process()` calls:

```rust
struct ChangedRow {
    row_index: usize,   // 0-based row in the VT100 screen
    text: String,        // Clean text content (no ANSI)
}
```

**How it works:**

1. Maintains a `vt100::Parser` — a full VT100 screen emulator (24 rows × 220 cols default)
2. On each `process()` call, compares current screen rows against previous snapshot
3. Lines that have scrolled off the top are emitted to the log (diff-based detection)
4. **Alternate screen suppression:** When a TUI app activates alternate screen (`ESC[?1049h`), extraction is paused — no garbage from vim, htop, or Claude Code's TUI surfaces
5. Bounded by `VT_LOG_BUFFER_CAPACITY` (10,000 lines); oldest lines are dropped when full
6. **Monotonic cursor:** `total_lines()` returns a monotonically increasing count of all lines ever pushed (not the current buffer length). Clients use this as a stable cursor for paginated reads via `lines_since_owned(offset, limit)`. If a client's saved offset falls in the evicted range, it is clamped to `oldest_offset()`

**Resize:** When the PTY is resized, `VtLogBuffer.resize()` is called to keep the parser in sync and clear the prev-row snapshot (avoids false scroll detection after resize).

Each session gets its own `VtLogBuffer` stored in `AppState.vt_log_buffers: DashMap<String, Mutex<VtLogBuffer>>`.

## OSC 7 CWD Tracking

Shells that emit OSC 7 (`\x1b]7;file://hostname/path\x07`) report the current working directory after each command. FastAF uses this to keep the Rust-side `PtySession.cwd` in sync:

1. **Frontend handler:** `terminal.parser.registerOscHandler(7, ...)` in `Terminal.tsx` parses the `file://` URL via `parseOsc7Url()`.
2. **Store update:** The parsed path is written to `terminalsStore` so the UI reflects the current directory.
3. **IPC persist:** The frontend calls `update_session_cwd(sessionId, cwd)` to update `PtySession.cwd` on the Rust side.
4. **Restart recovery:** The persisted cwd is used during session restore so reopened terminals start in the correct directory.
5. **Worktree reassignment:** When the cwd changes to a path inside a different worktree, the terminal tab is reassigned to the corresponding branch in the sidebar.

## Shell Environment Variables

`build_shell_command()` sets these environment variables for spawned PTY sessions:

| Variable | Value | Purpose |
|----------|-------|---------|
| `COLORTERM` | `truecolor` | Advertise 24-bit color support |
| `KITTY_WINDOW_ID` | `1` | Signal kitty keyboard protocol support for heuristic detection by Ink-based agents |
| `TERM_PROGRAM` | `ghostty` | Satisfy Claude Code's terminal allow-list for kitty protocol; also prevents macOS `/etc/zshrc` from sourcing `zshrc_Apple_Terminal` |
| `TERM_PROGRAM_VERSION` | `3.0.0` | Passes Claude Code's version gate (rejects `^[0-2]\.`) |

Additionally, `CLAUDECODE` is removed from the environment (`env_remove`) to prevent nested-session detection when FastAF itself runs inside a Claude Code session. `NO_COLOR` is also removed from every PTY command immediately after construction because it may belong to a Codex parent that launched FastAF, not to the independent child session. This does not force application color or override explicit command flags; a deliberate per-agent environment may restore `NO_COLOR` after sanitization.

## Child Process Priority

Each spawned shell is given a lower scheduling priority right after spawn
(`lower_pty_child_priority()`), so heavy workloads run inside a pane (`cargo
build`, bundlers, test runners) yield CPU to TUIC's own render loop and the rest
of the system. A child inherits the parent's priority **at fork time**, so every
process the shell later spawns is deprioritized too. The effect only bites under
contention — an idle machine still runs the build at full speed.

| Platform | Mechanism | Default |
|----------|-----------|---------|
| macOS / Linux | `setpriority(PRIO_PROCESS, …)` | nice **+10**, override via `TUIC_PTY_NICE` |
| Windows | `SetPriorityClass(BELOW_NORMAL_PRIORITY_CLASS)` | fixed |

Validated on an M4 Max under 14-core saturation: TUIC's UI goes from frozen
(nice 0) to responsive (nice +10). `BELOW_NORMAL` (not `IDLE_PRIORITY_CLASS`) is
the Windows analog — `IDLE` only runs when the whole system is idle, the
equivalent of macOS QoS-background, which would make builds crawl.

### macOS Thread QoS Elevation

On macOS, the PTY **reader thread**, the **frame ticker**, and the **keystroke-write thread** are all raised to `QOS_CLASS_USER_INTERACTIVE` via `pthread_set_qos_class_self_np` (`raise_thread_for_interactive_io()` in `src-tauri/src/pty.rs`, `thread_qos` module). This is complementary to the child-process renice: on Apple Silicon the scheduler is QoS-band driven — `nice` only reorders threads within a band. Without this elevation, TUIC's interactive-path threads ran in the default QoS band alongside compiler worker threads, causing input latency under heavy builds. Raising to `USER_INTERACTIVE` puts the interactive path in a higher scheduler band. macOS-only; a no-op on Linux/Windows.

## Session Conflict Flag File

When an agent reports a session conflict (session already in use or not found), FastAF handles it via a flag-file mechanism instead of writing directly to the PTY.

**Flow:**

1. The output parser detects a session conflict message (`ParsedEvent::AgentSessionConflict`)
2. `ChunkProcessor` calls `mark_session_conflict()`, which creates a flag file named `no-session-inject.<TUIC_SESSION>` in the app config directory
3. Shell wrapper functions (zsh, bash, fish) check for this flag file before injecting `--session-id $TUIC_SESSION`
4. If the flag file exists, the wrapper skips session-id injection, allowing the agent to start a fresh session

This replaced the previous `maybe_reset_tuic_session` approach, which wrote `export TUIC_SESSION=...` directly to the PTY. Direct PTY writes could corrupt TUI output (e.g., Ink-based agents in raw mode). The flag-file approach is safe because it uses the filesystem as a side-channel — no bytes are injected into the terminal stream.

A debounce (`last_session_conflict_mark`) prevents creating multiple flag files within a short window for the same session.

## Ctrl-U Prefix Handling

Single-key PTY writes that should clear the current input line prepend `\x15` (Ctrl-U) on POSIX shells. The selection is **shell-family aware**, not host-platform aware: the detected shell (`bash`/`zsh`/`fish` → POSIX, `powershell`/`cmd` → Windows) drives the choice. Mixing PowerShell on macOS or a POSIX shell via WSL/MSYS now behaves correctly. Native Windows shells skip the prefix entirely to avoid inserting a literal `^U`.

Frontend input helpers route through `src/utils/sendCommand.ts`:
- `sendCommand(fn, text)` — full command: `Ctrl-U` (family-gated) + text + `\r`. Handles Ink raw-mode split writes.
- `sendPtyKey(fn, key)` — pass-through single key/escape sequence. No prefix, no trailing CR. Use for `ChoicePrompt` option keys, TUI app navigation, and any raw-stdin interaction.

Never write `text + "\r"` directly to a PTY — see `AGENTS.md`.

## OSC 133 Semantic Prompts

When the shell emits OSC 133 markers (modern bash/zsh/fish with the integration enabled), the reader records clean command lifecycles into the per-session knowledge store:

| Marker | Meaning |
|--------|---------|
| `OSC 133;A` | Prompt start — delimits a new prompt line |
| `OSC 133;B` | Command start — the user has pressed Enter, command is about to run |
| `OSC 133;C` | Command output start |
| `OSC 133;D[;exit_code]` | Command completed with the given exit code |

`ChunkProcessor.record_osc133_outcomes` consumes the markers and writes a `CommandOutcome { command, cwd, exit_code, classification, duration_ms, output_snippet }` into the session knowledge store. Classification is one of `Success`, `Error { error_type }`, `TuiLaunched { app_name }`, `Timeout`, `UserCancelled`, `Inferred`. `error_type` is inferred from the output snippet (e.g. `rust-error-borrow`, `npm-missing-module`, `python-traceback`).

**Fallback:** when OSC 133 is absent (plain shells, remote sessions), the silence timer still records an `Inferred` outcome so the AI agent loop has *something* to learn from. The `has_osc133_integration` flag on `AppState` tracks per-session whether real markers have been seen.

Persistence lives at `<config_dir>/agent-knowledge/<session_id>.json`. A 2 s debounced background task (`spawn_persist_task`) flushes `knowledge_dirty` sessions to disk. `load_all` rehydrates stores on app start.

## TUI Application Detection

`src-tauri/src/ai_agent/tui_detect.rs` tracks alternate-screen enter (`ESC[?1049h`) and leave (`ESC[?1049l`) to classify the terminal as:

```rust
enum TerminalMode {
    Shell,
    FullscreenTui { app_hint: Option<String>, depth: u8 },
}
```

`depth` is a counter for nested alt-screen pushes (e.g. `less` invoked from inside `vim`). Known app hints — matched heuristically from nearby screen rows — include `vim`, `nvim`, `htop`, `btop`, `lazygit`, `less`, `tmux`, `claude`, and others. The mode is surfaced on `SessionState.terminal_mode` and used by:
- `ai_terminal_get_context` — tells the model it's in a TUI so it prefers `send_key` + `wait_for` over line-oriented `send_input`.
- `SessionKnowledgeBar` — renders a `TUI` badge and accumulates `tui_apps_seen`.
- The agent safety layer — blocks Ctrl-U prefix injection while a TUI app is in the foreground.

## Silence-Based Question Detection

The reader thread tracks output silence to detect unanswered agent prompts. When the terminal stops producing output for 10 seconds after a line ending with `?` is detected, the session is treated as waiting for input. This complements the instant pattern-based detection in the output parser and catches generic questions that would cause too many false positives if detected immediately (e.g., streaming fragments like "ad?", "swap?").

**Question extraction:** `extract_question_line()` scans all `ChangedRow` entries (not just the last) for question text. It skips rows that are mode-line status indicators (e.g., `⏵⏵ Reading files`), so a question on row 5 is still found even when a status line updates on row 23 in the same chunk.

**Echo suppression:** When the user types a line into the PTY, the reader activates a 500ms suppression window (`suppress_user_input`). During this window, any matching text echoed by the shell is ignored for question detection. This prevents false positives when the user types a line ending with `?` — the PTY echoes it back, and without suppression, the silence detector would treat the echo as an agent question.

**Single threshold:** All silence-based questions use a uniform 10-second timeout regardless of whether new output has arrived since the question was detected.

## Shell State (Busy/Idle) Detection

The backend combines explicit lifecycle markers, agent-specific screen evidence,
real output, and silence to emit `ShellState` events (`busy`/`idle`). Rust is the
single source of truth — the frontend does not derive activity from raw PTY data.

**Transitions:**
- **Explicit markers:** OSC 133 shell markers and OSC 7770 agent hooks transition immediately. Output silence cannot override an observed hook `busy`; it ends on hook `idle`, a confirmed interruption, process exit, or a stable ready composer after the submitted turn produced real activity. The last path recovers safely when an idle hook is missed without letting the previous turn's composer cancel a fresh submission.
- **→ busy:** A submitted agent prompt, real output, an animated spinner, or an agent-specific `Working` screen transitions via atomic CAS (`try_shell_transition`). Positive screen evidence is evaluated even while the stored state is idle, so false-idle is self-healing.
- **→ idle:** The 1s silence timer is the sole heuristic idle path. Plain shells use 500ms; agents use 2.5s and must have no active sub-tasks. Agents with ready-screen adapters require the ready prompt to remain stable for 1.5s.
- **Interrupts:** Ctrl-C and bare Escape record `interrupt pending` but never force idle. Idle follows only after an interrupted/ready screen, explicit Stop, or process exit.

**Movement is the busy signal (#446-596f):** "if the text above the input area moves, the agent is active." Post-cutoff `changed_rows` are text-equality diffed (`TerminalGrid::process`), so a byte-identical repaint produces no ChangedRow: any *static* glyph — a completed-turn summary `✻ Sautéed for 1m 25s`, a `· run /mcp` hint, HUD `░░` bars, banner art — is inert by construction and can neither latch nor hold BUSY. Spinner rows among the changed rows (glyph must LEAD the trimmed line, `is_spinner_row()` in `chrome.rs`) additionally refresh `last_output_ms` while the agent animates; when movement stops, the idle timer expires naturally after AGENT_IDLE_MS (2.5s).

**Prompt-based screen adapters:** Claude, Gemini, and Aider screen classifiers are prompt-based only — `Ready` when the input prompt is visible, `Unknown` otherwise, never `Working` from glyph presence (three stuck-BUSY regressions came from static glyphs read as live spinners). Codex is the deliberate exception: it distinguishes `Working`/`Ready`/`Interrupted` by the *presence* of its `• Working (… esc to interrupt)` status line, because its TUI legitimately freezes for minutes while a child process runs — accepted policy: prefer false-BUSY over false-IDLE for Codex. Codex inspection uses the full screen snapshot before chrome filtering (its separator divides tool output from the summary rather than framing the prompt, so `find_chrome_cutoff()` would discard the Working row) and searches a bounded neighborhood immediately above the lowest `›` prompt; historical Working text elsewhere in scrollback cannot latch busy. A frozen agent screen with no visible prompt stays BUSY by design (irreducible ambiguity — the user can see the screen).

**Signal precedence and confirmation:** Explicit hook busy > Codex Working marker > movement (real output / animated spinner) > silence. A ready prompt visible from the previous turn cannot cancel a newly submitted prompt until real activity has been observed; after activity, a stable ready composer can repair a missed hook idle. A current-turn completion marker prevents a stale Working row from relatching BUSY, but a pending process probe or confirmed meaningful descendant still owns the task lifecycle. Hook-based question suppression activates only after an OSC 7770 state marker is actually received, rather than trusting a possibly stale configuration flag.

**Safety consumers:** For agents with a verified screen adapter, peer-message injection and Unix auto-standby require confirmed idle (explicit Stop/OSC or stable ready screen). A silence-only idle can update the cosmetic state but cannot type into or `SIGSTOP` a potentially working agent. Agents without an adapter retain the legacy heuristic behavior until their UI is characterized.

**Task lifecycle is separate from shell activity:** `shell_state=idle` means the
PTY is quiet; it does not prove that the assigned task finished. An agent's
`suggest: [ ... ]` marker explicitly closes the current task epoch and produces
`agent_state=completed` plus a `state_change: completed` parent notification.
Likewise, a visible ready composer may coexist with an autonomous background
command. While a meaningful descendant of the agent is alive, session state
reports `background_work=true` and keeps `agent_state=working`; `shell_state`
remains `idle` because terminal input readiness is a separate fact. Persistent
integration helpers (`mdkb`, `tuic-bridge`, and `node_repl`) and Claude's
standalone timed `caffeinate -i -t <seconds>` assertion do not count as work;
Unix classification checks both `comm` and the authoritative argv path from
unlimited-width `ps` output. A `caffeinate` invocation that wraps a command
remains meaningful background work. Parent `idle` lifecycle mail is
deferred until the real descendant exits, while confirmed-ready message
delivery keeps using the terminal-readiness gate. The first confirmed-ready
observation and every explicit agent IDLE marker arm a generation boundary:
idle/completed lifecycle output waits until a process snapshot newer than that
observation or marker has been reconciled. Fresh working evidence starts a new
readiness episode even within the same task epoch: it invalidates only the
satisfied or pending snapshot boundary, so the next ready observation must
reconcile a newer snapshot while preserving tracked background work and the
snapshot generation. One app-wide process snapshot is collected at most once
per second on Tokio's
blocking pool and shared by every session. The refresher runs only while a
ready probe or tracked background process needs it, skips missed interval ticks,
and stops scanning stable idle sessions. Enumeration or parse failures preserve
the prior `background_work` value. On Windows, where Toolhelp does not provide
command lines, generic `node.exe` processes are kept as meaningful work rather
than guessed to be `node_repl` helpers.
Submitting new user or PTY-injected peer input starts a new task epoch immediately,
clearing the prior completion marker and its stale suggested actions before new output arrives.
Claude channel and inbox delivery do not claim a submitted turn; the channel is used only
inside an already working turn. Idle or completed managed composers take the PTY submission
path, and lifecycle changes only after that input or normal activity evidence. Idle
CAS and parent lifecycle notification share the same per-session lifecycle lock;
submitted epoch mutation and its IDLE-to-BUSY transition hold that lock as one
critical section, so a new turn cannot inherit a stale idle notification. The
authoritative parent inbox enqueue occurs under the child lock; parent terminal
wake/dispatch runs only after release, avoiding cross-session lock ordering. A
queued BUSY-to-IDLE transition also carries the task epoch observed before it
waited for the lock and is discarded if a new submitted turn won first.
Without a fresh marker the new task epoch returns to `idle`, not `completed`.

**Transactional peer injection:** Reserving an idle composer creates an ownership token before the PTY write. A failure proven to occur before any byte was written rolls the synthetic BUSY state back to the prior confirmed IDLE state and keeps the message queued. Once any byte may have escaped, failure is `delivery_uncertain`: the session remains conservatively BUSY, the authoritative inbox remains readable, and TUIC does not automatically retry into the terminal. Real output, a Working screen, or an explicit state marker invalidates rollback ownership so a late error cannot erase genuine activity. `session status` exposes the additive `delivery_uncertain` flag.

**Status line ticks:** Animated spinner repaint evidence refreshes both shell activity and `SilenceState`, preventing low-confidence question/tool-error events from contradicting a busy tab. Static mode/footer rows remain chrome only and do not prove activity.

**Agent detection:** `detectAgentForTerminal()` fires on shell-state transitions (immediate on idle, 500ms debounce on busy). A 30s fallback poll catches cold starts. This replaces the previous 3s polling interval, reducing syscalls ~30x.

## Amber Tab Styling

Sessions created via HTTP/MCP (remote sessions) are flagged with `isRemote`. The tab bar applies an amber gradient background and amber bottom border (`rgba(251, 191, 36, ...)`) to visually distinguish remote-created sessions from locally spawned ones.

## Concurrency

- Sessions stored in `DashMap<String, Mutex<PtySession>>` for lock-free concurrent access
- Each session's writer is behind `Mutex` for exclusive write access
- Reader thread holds `Arc<AtomicBool>` for pause signaling
- Metrics use `AtomicUsize` for zero-overhead counting
