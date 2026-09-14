//! Stdio MCP client — connects to an upstream MCP server by spawning a local process.
//!
//! Implements the MCP client side of the stdio transport:
//! newline-delimited JSON-RPC over stdin/stdout.
//!
//! - stderr from the child process goes to the app log (never parsed as protocol).
//! - Respawn is rate-limited to prevent tight loops on crashing servers.
//! - Env vars from the upstream config are merged with the inherited environment,
//!   so PATH and other vars work correctly in release builds launched from Finder.

use crate::mcp_proxy::http_client::UpstreamToolDef;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::time::{Duration, Instant};

use crate::cli::expand_tilde;

const MIN_RESPAWN_INTERVAL: Duration = Duration::from_secs(5);
const PROTOCOL_VERSION: &str = "2025-11-25";

/// How many stdout lines the reader may hold ahead of the caller, and how many
/// bytes those lines may weigh in total.
///
/// Nothing drains this queue between calls, so the bound is what keeps an
/// upstream that chatters while idle from growing TUIC's memory without limit.
/// Both limits are needed: a line count alone bounds nothing, because one line
/// can be arbitrarily long.
const MAX_QUEUED_LINES: usize = 256;
const MAX_QUEUED_BYTES: usize = 8 * 1024 * 1024;

/// The longest single line the reader will assemble. A JSON-RPC message this
/// large is not something we can act on, and a child that never sends a newline
/// would otherwise grow one `String` until the process dies.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

/// Why a read gave up.
enum ReadEnd {
    /// The deadline passed. The queue may still hold lines — being out of time
    /// outranks having something to parse, or an upstream that refills the queue
    /// faster than we drain it would keep the call alive forever.
    Timeout,
    /// The child's stdout reached EOF, or the client was torn down.
    Closed,
}

/// Bounded queue between the stdout reader thread and the caller.
///
/// **Lossy on purpose.** Blocking the reader when the queue is full parks the
/// child on its stdout write, and a child that is not reading its stdin can then
/// park *us* in `write_line` — with the request not yet sent, no deadline is
/// armed and neither side can move again. Dropping the oldest line instead keeps
/// the pipe drained. What is dropped is what `rpc` discards anyway: messages
/// that arrived while nothing was waiting for them. A reply lost to a genuine
/// flood surfaces as the timeout the call already has.
struct LineQueue {
    inner: std::sync::Mutex<LineQueueState>,
    ready: std::sync::Condvar,
}

#[derive(Default)]
struct LineQueueState {
    lines: std::collections::VecDeque<String>,
    bytes: usize,
    closed: bool,
    dropped: u64,
}

impl LineQueue {
    fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(LineQueueState::default()),
            ready: std::sync::Condvar::new(),
        }
    }

    /// Queue one line, evicting the oldest until it fits. Returns false once the
    /// queue is closed, which is the reader thread's signal to stop.
    fn push(&self, line: String) -> bool {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return false;
        }
        // The newest line is always kept, even when it alone exceeds the byte
        // budget: dropping it would lose the reply we are most likely waiting for.
        while !state.lines.is_empty()
            && (state.lines.len() >= MAX_QUEUED_LINES
                || state.bytes + line.len() > MAX_QUEUED_BYTES)
        {
            if let Some(old) = state.lines.pop_front() {
                state.bytes -= old.len();
                state.dropped += 1;
            }
        }
        state.bytes += line.len();
        state.lines.push_back(line);
        drop(state);
        self.ready.notify_one();
        true
    }

    /// Stop the reader and wake anyone waiting.
    fn close(&self) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        drop(state);
        self.ready.notify_all();
    }

    /// How many lines were dropped to keep the queue inside its bounds.
    fn dropped(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).dropped
    }

    fn recv_deadline(&self, deadline: Instant) -> Result<String, ReadEnd> {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        loop {
            // The deadline is checked before the queue on purpose — see `Timeout`.
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ReadEnd::Timeout);
            }
            if let Some(line) = state.lines.pop_front() {
                state.bytes -= line.len();
                return Ok(line);
            }
            if state.closed {
                return Err(ReadEnd::Closed);
            }
            state = self
                .ready
                .wait_timeout(state, remaining)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }
}

/// Pump the child's stdout into a bounded queue so `read_line` can wait with a
/// deadline. The thread ends on EOF — `shutdown_internal` killing the child, or
/// the child exiting on its own — or when the queue is closed.
///
/// Lines are assembled with a byte cap rather than through `BufRead::lines`,
/// which grows one `String` until it finds a newline: a child that never sends
/// one is otherwise an out-of-memory kill with no bound in sight.
fn spawn_stdout_reader(stdout: impl std::io::Read + Send + 'static) -> std::sync::Arc<LineQueue> {
    let queue = std::sync::Arc::new(LineQueue::new());
    let reader_queue = queue.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line: Vec<u8> = Vec::new();
        // Set when the current line passed the cap: everything up to its newline
        // is discarded rather than published as a line that was never sent.
        let mut overflowed = false;
        loop {
            let (consumed, complete) = {
                let available = match reader.fill_buf() {
                    Ok([]) => break, // EOF
                    Ok(buf) => buf,
                    Err(_) => break,
                };
                match available.iter().position(|b| *b == b'\n') {
                    Some(i) => {
                        if !overflowed && line.len() + i <= MAX_LINE_BYTES {
                            line.extend_from_slice(&available[..i]);
                        } else {
                            overflowed = true;
                        }
                        (i + 1, true)
                    }
                    None => {
                        if !overflowed && line.len() + available.len() <= MAX_LINE_BYTES {
                            line.extend_from_slice(available);
                        } else {
                            overflowed = true;
                            line.clear();
                        }
                        (available.len(), false)
                    }
                }
            };
            reader.consume(consumed);
            if !complete {
                continue;
            }
            let finished = std::mem::take(&mut line);
            if overflowed {
                overflowed = false;
                tracing::warn!(
                    source = "mcp_proxy",
                    "dropped a stdout line over {MAX_LINE_BYTES} bytes"
                );
                continue;
            }
            // Invalid UTF-8 is not something the protocol can recover from.
            let Ok(text) = String::from_utf8(finished) else {
                break;
            };
            if !reader_queue.push(text) {
                break;
            }
        }
        reader_queue.close();
    });
    queue
}

/// One line to write to the child's stdin, plus the slot its outcome goes into.
struct WriteJob {
    line: String,
    done: std::sync::mpsc::SyncSender<Result<(), String>>,
}

/// How a write ended when it did not succeed.
#[derive(Debug, PartialEq, Eq)]
enum WriteEnd {
    /// The pipe reported an error.
    Failed(String),
    /// The deadline passed with the write still parked.
    Timeout,
    /// The writer thread is gone.
    WriterGone,
}

/// Pump lines into the child's stdin from a dedicated thread.
///
/// `write_all` on a pipe blocks until the child reads, and a child that stopped
/// reading its stdin never lets it return. The caller is a blocking-pool thread
/// holding this client's mutex, so that one write wedges the whole upstream for
/// the life of the process — and the deadline cannot help, because it only ever
/// covered the reply. Handing the write to a thread makes it interruptible: the
/// caller waits on a channel, and the shutdown that follows a timeout kills the
/// child, which fails the parked write and releases this thread.
fn spawn_stdin_writer(
    mut stdin: impl std::io::Write + Send + 'static,
) -> std::sync::mpsc::SyncSender<WriteJob> {
    // Depth 1: one caller holds `&mut self` and waits for its own outcome, so
    // there is never more than one job outstanding.
    let (tx, rx) = std::sync::mpsc::sync_channel::<WriteJob>(1);
    std::thread::spawn(move || {
        while let Ok(job) = rx.recv() {
            let result = stdin
                .write_all(job.line.as_bytes())
                .and_then(|()| stdin.flush())
                .map_err(|e| e.to_string());
            // The caller may already have given up on this write; its receiver
            // is then gone and there is nobody to tell.
            let _ = job.done.send(result);
        }
        // Dropping `stdin` closes the pipe — the EOF the child waits for.
    });
    tx
}

/// Hand `line` to the writer thread and wait for its outcome until `deadline`.
fn write_through(
    tx: &std::sync::mpsc::SyncSender<WriteJob>,
    line: String,
    deadline: Instant,
) -> Result<(), WriteEnd> {
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
    tx.send(WriteJob {
        line,
        done: done_tx,
    })
    .map_err(|_| WriteEnd::WriterGone)?;
    match done_rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(WriteEnd::Failed(e)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(WriteEnd::Timeout),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(WriteEnd::WriterGone),
    }
}

/// Config for a stdio-based upstream MCP server.
#[derive(Debug, Clone)]
pub(crate) struct StdioConfig {
    pub(crate) name: String,
    pub(crate) command: String,
    pub(crate) args: Vec<String>,
    pub(crate) env: std::collections::HashMap<String, String>,
    pub(crate) cwd: Option<String>,
    /// How long to wait for one response line before declaring the upstream mute.
    pub(crate) timeout: Duration,
}

/// Client for a single upstream MCP server over stdio (spawned process).
pub(crate) struct StdioMcpClient {
    config: StdioConfig,
    /// Running child process (if connected).
    child: Option<std::process::Child>,
    /// Response lines pumped off the child's stdout by a dedicated reader thread.
    /// Reading through a queue instead of straight off the pipe is what makes
    /// the deadline in `read_line` possible: a blocking `BufRead::read_line` on a
    /// mute upstream is uninterruptible, and the caller is a blocking-pool thread
    /// holding this client's mutex. The queue closes when stdout hits EOF.
    stdout_rx: Option<std::sync::Arc<LineQueue>>,
    /// Queue into the writer thread that owns the child's stdin. Writing through
    /// a thread instead of straight into the pipe is what makes the deadline in
    /// `write_line` possible — see `spawn_stdin_writer`. Dropping this sender is
    /// what closes stdin, one hop later than dropping the handle itself.
    stdin_tx: Option<std::sync::mpsc::SyncSender<WriteJob>>,
    /// When was the last spawn attempted (for rate limiting).
    last_spawn: Option<Instant>,
    /// JSON-RPC request counter.
    request_id: u64,
}

impl StdioMcpClient {
    /// Create a new stdio MCP client (not yet connected).
    pub(crate) fn new(config: StdioConfig) -> Self {
        Self {
            config,
            child: None,
            stdout_rx: None,
            stdin_tx: None,
            last_spawn: None,
            request_id: 0,
        }
    }

    /// Build from an `UpstreamMcpServer` config.
    pub(crate) fn from_upstream_config(
        name: String,
        transport: &crate::mcp_upstream_config::UpstreamTransport,
        timeout_secs: u32,
    ) -> Option<Self> {
        match transport {
            crate::mcp_upstream_config::UpstreamTransport::Stdio {
                command,
                args,
                env,
                cwd,
            } => Some(Self::new(StdioConfig {
                name,
                command: command.clone(),
                args: args.clone(),
                env: env.clone(),
                cwd: cwd.clone(),
                timeout: Duration::from_secs(timeout_secs.max(1) as u64),
            })),
            crate::mcp_upstream_config::UpstreamTransport::Http { .. } => None,
        }
    }

    /// Spawn the process and perform the MCP initialize handshake.
    /// Returns the tool definitions exposed by the server.
    pub(crate) fn spawn_and_initialize(&mut self) -> Result<Vec<UpstreamToolDef>, String> {
        // Rate limit: don't spawn more than once every MIN_RESPAWN_INTERVAL
        if let Some(last) = self.last_spawn {
            let elapsed = last.elapsed();
            if elapsed < MIN_RESPAWN_INTERVAL {
                return Err(format!(
                    "Upstream '{}' respawning too fast ({}ms since last spawn, min {}ms)",
                    self.config.name,
                    elapsed.as_millis(),
                    MIN_RESPAWN_INTERVAL.as_millis()
                ));
            }
        }

        // Tear down any previous process
        self.shutdown_internal();

        self.last_spawn = Some(Instant::now());

        // Build the command with a sanitized environment.
        // We clear the parent env to prevent credential leakage (ANTHROPIC_API_KEY,
        // AWS_SECRET_ACCESS_KEY, etc.) to potentially untrusted MCP server processes,
        // then re-add only the variables needed for normal operation.
        let command = expand_tilde(&self.config.command);
        let args: Vec<String> = self.config.args.iter().map(|a| expand_tilde(a)).collect();
        let mut cmd = std::process::Command::new(&command);
        cmd.args(&args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped());

        // On Windows, CREATE_NO_WINDOW suppresses the console so Stdio::inherit()
        // for stderr would go to a null handle. Pipe it and log instead.
        #[cfg(target_os = "windows")]
        cmd.stderr(std::process::Stdio::piped());
        #[cfg(not(target_os = "windows"))]
        cmd.stderr(std::process::Stdio::inherit());

        crate::cli::apply_no_window(&mut cmd);

        cmd.env_clear();

        // Re-add safe passthrough variables needed by child processes
        const SAFE_ENV_KEYS: &[&str] = &[
            "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SHELL", "TERM",
        ];
        for key in SAFE_ENV_KEYS {
            if let Ok(val) = std::env::var(key) {
                cmd.env(key, val);
            }
        }

        // PATH needs augmentation: Tauri GUI processes launched from Finder/Dock
        // inherit a minimal PATH that misses common dev tool locations like
        // Homebrew and ~/.cargo/bin. Upstream MCP binaries (e.g. `mdkb`) fail
        // to spawn as a result. Prepend common dev bin dirs when they exist,
        // then append the inherited PATH.
        let mut path_parts: Vec<std::path::PathBuf> = Vec::new();
        #[cfg(target_os = "macos")]
        let candidate_prefixes: &[&str] = &[
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
        ];
        #[cfg(target_os = "linux")]
        let candidate_prefixes: &[&str] = &["/usr/local/bin", "/usr/local/sbin", "/snap/bin"];
        #[cfg(target_os = "windows")]
        let candidate_prefixes: &[&str] = &[];
        for p in candidate_prefixes {
            let pb = std::path::PathBuf::from(p);
            if pb.is_dir() {
                path_parts.push(pb);
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            for sub in &[".cargo/bin", ".local/bin", ".bun/bin", "bin"] {
                let pb = std::path::PathBuf::from(&home).join(sub);
                if pb.is_dir() {
                    path_parts.push(pb);
                }
            }
        }
        if let Some(inherited) = std::env::var_os("PATH") {
            path_parts.extend(std::env::split_paths(&inherited));
        }
        if let Ok(joined) = std::env::join_paths(&path_parts) {
            cmd.env("PATH", joined);
        }

        // Apply user-configured env overrides on top of the safe set
        for (k, v) in &self.config.env {
            cmd.env(k, v);
        }

        if let Some(ref cwd) = self.config.cwd {
            cmd.current_dir(expand_tilde(cwd));
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Upstream '{}': failed to spawn '{}': {e}",
                self.config.name, command
            )
        })?;

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| format!("Upstream '{}': failed to get stdout", self.config.name))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| format!("Upstream '{}': failed to get stdin", self.config.name))?;

        // On Windows, forward the piped stderr to tracing so MCP server errors
        // aren't silently lost (CREATE_NO_WINDOW means no console to inherit).
        #[cfg(target_os = "windows")]
        if let Some(stderr) = child.stderr.take() {
            let upstream_name = self.config.name.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    match line {
                        Ok(l) if !l.is_empty() => {
                            tracing::warn!(
                                source = "mcp_proxy",
                                upstream = %upstream_name,
                                "stderr: {l}"
                            );
                        }
                        Err(_) => break,
                        _ => {}
                    }
                }
            });
        }

        self.stdout_rx = Some(spawn_stdout_reader(stdout));
        self.stdin_tx = Some(spawn_stdin_writer(stdin));
        self.child = Some(child);

        // MCP handshake
        let tools = self.do_initialize()?;
        Ok(tools)
    }

    /// Send the MCP initialize handshake and return tool definitions.
    fn do_initialize(&mut self) -> Result<Vec<UpstreamToolDef>, String> {
        // Send initialize
        let init_resp = self.rpc(
            "initialize",
            serde_json::json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "tuicommander",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }),
        )?;

        if init_resp.get("error").is_some() {
            return Err(format!(
                "Upstream '{}' initialize error: {}",
                self.config.name, init_resp["error"]
            ));
        }

        // Send notifications/initialized (fire-and-forget — no response expected)
        let _ = self.send_notification("notifications/initialized", serde_json::json!({}));

        // Fetch tool list
        let tools_resp = self.rpc("tools/list", serde_json::json!({}))?;
        let tools_arr = match tools_resp["result"]["tools"].as_array() {
            Some(arr) => arr.clone(),
            None => {
                tracing::warn!(
                    upstream = %self.config.name,
                    "tools/list response missing result.tools — got: {}",
                    serde_json::to_string(&tools_resp).unwrap_or_default()
                );
                Vec::new()
            }
        };

        let tools = tools_arr
            .into_iter()
            .filter_map(|tool| {
                let original_name = tool["name"].as_str()?.to_string();
                Some(UpstreamToolDef {
                    original_name,
                    definition: tool,
                })
            })
            .collect();

        Ok(tools)
    }

    /// Call a tool on the upstream server.
    pub(crate) fn call_tool(&mut self, tool_name: &str, args: Value) -> Result<Value, String> {
        if !self.is_alive() {
            return Err(format!(
                "Upstream '{}' process is not running",
                self.config.name
            ));
        }
        let resp = self.rpc(
            "tools/call",
            serde_json::json!({
                "name": tool_name,
                "arguments": args
            }),
        )?;
        Ok(resp.get("result").cloned().unwrap_or(resp))
    }

    /// Check if alive and refresh the tool list. Used for health checks.
    pub(crate) fn health_check(&mut self) -> Result<Vec<UpstreamToolDef>, String> {
        if !self.is_alive() {
            return Err(format!(
                "Upstream '{}' process is not running",
                self.config.name
            ));
        }
        let tools_resp = self.rpc("tools/list", serde_json::json!({}))?;
        let tools_arr = tools_resp["result"]["tools"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let tools = tools_arr
            .into_iter()
            .filter_map(|tool| {
                let original_name = tool["name"].as_str()?.to_string();
                Some(UpstreamToolDef {
                    original_name,
                    definition: tool,
                })
            })
            .collect();
        Ok(tools)
    }

    /// Check if the child process is still running.
    pub(crate) fn is_alive(&mut self) -> bool {
        match &mut self.child {
            None => false,
            Some(child) => {
                // try_wait returns None if still running, Some(status) if exited
                match child.try_wait() {
                    Ok(None) => true, // still running
                    Ok(Some(_)) | Err(_) => {
                        // exited or error
                        self.child = None;
                        self.stdin_tx = None;
                        if let Some(queue) = self.stdout_rx.take() {
                            queue.close();
                        }
                        false
                    }
                }
            }
        }
    }

    /// Gracefully shut down the child process.
    /// Closes stdin, waits up to 2s for voluntary exit, then kills.
    pub(crate) fn shutdown(&mut self) {
        self.shutdown_internal();
    }

    fn shutdown_internal(&mut self) {
        // Close stdin first — signals EOF to the child
        drop(self.stdin_tx.take());
        if let Some(queue) = self.stdout_rx.take() {
            queue.close();
        }

        if let Some(mut child) = self.child.take() {
            // Wait up to 2s for voluntary exit
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break, // exited voluntarily
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
    }

    /// Send a JSON-RPC request and read the response, matching by `id`.
    /// Server notifications (messages without an `id` field) are skipped.
    fn rpc(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.request_id += 1;
        let id = self.request_id;

        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        // One deadline for the whole exchange — the write and every line read
        // while waiting for the reply — rather than by a message count: counting
        // made a chatty upstream fail a call it had answered correctly, because a
        // backlog it produced while nothing was listening was charged against the
        // budget meant for the reply. It starts before the write because a child
        // that stopped reading its stdin blocks there, not at the reply.
        let deadline = Instant::now() + self.config.timeout;
        self.write_line(&body, deadline)?;

        // Loop until we get a response with matching id — skip notifications
        // and log messages the server may send in between.
        loop {
            let msg = self.read_line(deadline)?;
            match msg.get("id") {
                Some(resp_id) if resp_id.as_u64() == Some(id) => return Ok(msg),
                Some(_) => {
                    tracing::debug!(
                        upstream = %self.config.name,
                        "Skipping response with mismatched id (expected {id}): {msg}"
                    );
                }
                None => {
                    tracing::debug!(
                        upstream = %self.config.name,
                        "Skipping server notification while waiting for id {id}: {msg}"
                    );
                }
            }
        }
    }

    /// Send a notification (no response expected).
    fn send_notification(&mut self, method: &str, params: Value) -> Result<(), String> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        });
        let deadline = Instant::now() + self.config.timeout;
        self.write_line(&body, deadline)
    }

    /// Write a JSON value as a newline-delimited line to stdin, waiting until
    /// `deadline` for the child to take it.
    ///
    /// On timeout the client is torn down, for the same reason `read_line` does
    /// it and for one more: killing the child is what unblocks the writer thread
    /// still parked on the pipe.
    fn write_line(&mut self, value: &Value, deadline: Instant) -> Result<(), String> {
        let tx = self
            .stdin_tx
            .clone()
            .ok_or_else(|| format!("Upstream '{}': stdin not available", self.config.name))?;

        let mut line = serde_json::to_string(value).map_err(|e| {
            format!(
                "Upstream '{}': failed to serialize request: {e}",
                self.config.name
            )
        })?;
        line.push('\n');

        match write_through(&tx, line, deadline) {
            Ok(()) => Ok(()),
            Err(WriteEnd::Failed(e)) => Err(format!(
                "Upstream '{}': failed to write to stdin: {e}",
                self.config.name
            )),
            Err(WriteEnd::Timeout) => {
                tracing::warn!(
                    upstream = %self.config.name,
                    "upstream stopped reading its stdin; tearing it down"
                );
                self.shutdown_internal();
                Err(format!(
                    "Upstream '{}': timed out writing the request — the server stopped reading its stdin",
                    self.config.name
                ))
            }
            Err(WriteEnd::WriterGone) => Err(format!(
                "Upstream '{}': stdin writer stopped",
                self.config.name
            )),
        }
    }

    /// Read a newline-delimited JSON response from stdout, waiting until
    /// `deadline` for it.
    ///
    /// On timeout the client is torn down. That is not tidiness: the request we
    /// gave up on may still be answered later, and leaving the pipe in place
    /// would hand that stale reply to the next call as if it were its own.
    fn read_line(&mut self, deadline: Instant) -> Result<Value, String> {
        let rx = self
            .stdout_rx
            .as_ref()
            .ok_or_else(|| format!("Upstream '{}': stdout not available", self.config.name))?;

        let line = match rx.recv_deadline(deadline) {
            Ok(line) => line,
            Err(ReadEnd::Timeout) => {
                let dropped = rx.dropped();
                let message = format!(
                    "Upstream '{}': timed out after {}ms waiting for a response",
                    self.config.name,
                    self.config.timeout.as_millis()
                );
                tracing::warn!(
                    source = "mcp_proxy",
                    upstream = %self.config.name,
                    dropped,
                    "{message}"
                );
                self.shutdown_internal();
                return Err(message);
            }
            Err(ReadEnd::Closed) => {
                return Err(format!(
                    "Upstream '{}': server closed stdout (process may have crashed)",
                    self.config.name
                ));
            }
        };

        serde_json::from_str(line.trim()).map_err(|e| {
            format!(
                "Upstream '{}': invalid JSON from server: {e} (line: {line:?})",
                self.config.name
            )
        })
    }
}

impl Drop for StdioMcpClient {
    fn drop(&mut self) {
        self.shutdown_internal();
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    /// Create a test config that runs a simple echo-style MCP server
    /// implemented as a shell script.
    fn make_config_for_echo_server(script: &str) -> StdioConfig {
        // Write the script to a temp file
        let mut tmp = std::env::temp_dir();
        tmp.push(format!("tuic-mcp-test-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, script).unwrap();
        // Make it executable
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        StdioConfig {
            name: "test".to_string(),
            command: "sh".to_string(),
            args: vec![tmp.to_str().unwrap().to_string()],
            env: HashMap::new(),
            cwd: None,
            timeout: Duration::from_secs(30),
        }
    }

    /// A minimal MCP server script (shell) that responds correctly to the handshake.
    fn minimal_mcp_script() -> String {
        r#"#!/bin/sh
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized)
            # No response for notifications
            ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"Echo tool","inputSchema":{"type":"object"}}]}}\n' "$id"
            ;;
        tools/call)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"echoed"}],"isError":false}}\n' "$id"
            ;;
        *)
            printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id"
            ;;
    esac
done
"#.to_string()
    }

    fn protocol_offer_probe_script() -> String {
        r#"#!/bin/sh
offered=wrong
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^\"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            if echo "$line" | grep -q '"protocolVersion":"2025-11-25"'; then
                offered=legacy
            fi
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized) ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"%s","description":"Protocol offer probe","inputSchema":{"type":"object"}}]}}\n' "$id" "$offered"
            ;;
    esac
done
"#.to_string()
    }

    #[test]
    fn initialize_offers_legacy_protocol_revision_over_stdio() {
        let config = make_config_for_echo_server(&protocol_offer_probe_script());
        let mut client = StdioMcpClient::new(config);

        let tools = client.spawn_and_initialize().unwrap();
        assert_eq!(tools[0].original_name, "legacy");
        client.shutdown();
    }

    #[test]
    fn spawn_and_initialize_returns_tools() {
        let config = make_config_for_echo_server(&minimal_mcp_script());
        let mut client = StdioMcpClient::new(config);

        let tools = client.spawn_and_initialize().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].original_name, "echo");
        assert!(client.is_alive());

        client.shutdown();
        // After shutdown the process should be dead
        assert!(!client.is_alive());
    }

    #[test]
    fn call_tool_returns_result() {
        let config = make_config_for_echo_server(&minimal_mcp_script());
        let mut client = StdioMcpClient::new(config);
        client.spawn_and_initialize().unwrap();

        let result = client
            .call_tool("echo", serde_json::json!({"message": "hello"}))
            .unwrap();

        assert_eq!(result["content"][0]["text"].as_str().unwrap(), "echoed");
    }

    #[test]
    fn is_alive_returns_false_before_spawn() {
        let config = StdioConfig {
            name: "test".to_string(),
            command: "echo".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            timeout: Duration::from_secs(30),
        };
        let mut client = StdioMcpClient::new(config);
        assert!(!client.is_alive());
    }

    #[test]
    fn is_alive_returns_false_after_process_exits() {
        // A script that exits immediately after the handshake
        let script = r#"#!/bin/sh
IFS= read -r line
id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
IFS= read -r _notif
IFS= read -r line2
id2=$(echo "$line2" | sed 's/.*"id":\([0-9]*\).*/\1/')
printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[]}}\n' "$id2"
exit 0
"#;
        let config = make_config_for_echo_server(script);
        let mut client = StdioMcpClient::new(config);
        client.spawn_and_initialize().unwrap();

        // Give the process a moment to exit
        std::thread::sleep(Duration::from_millis(200));
        assert!(!client.is_alive());
    }

    #[test]
    fn spawn_fails_for_nonexistent_command() {
        let config = StdioConfig {
            name: "bad".to_string(),
            command: "this_command_does_not_exist_xyz_12345".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            timeout: Duration::from_secs(30),
        };
        let mut client = StdioMcpClient::new(config);
        let result = client.spawn_and_initialize();
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("failed to spawn"));
    }

    #[test]
    fn respawn_rate_limit_blocks_too_fast_respawn() {
        let config = StdioConfig {
            name: "test".to_string(),
            command: "this_command_does_not_exist_xyz_12345".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
            timeout: Duration::from_secs(30),
        };
        let mut client = StdioMcpClient::new(config);

        // First spawn attempt (will fail but updates last_spawn)
        // We manually set last_spawn to simulate a recent spawn
        client.last_spawn = Some(Instant::now());

        // Second attempt should be blocked by rate limiter
        let result = client.spawn_and_initialize();
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(
            err.contains("too fast") || err.contains("min"),
            "Expected rate limit error, got: {err}"
        );
    }

    #[test]
    fn shutdown_is_idempotent() {
        let config = make_config_for_echo_server(&minimal_mcp_script());
        let mut client = StdioMcpClient::new(config);
        client.spawn_and_initialize().unwrap();

        client.shutdown();
        client.shutdown(); // second call should not panic
        assert!(!client.is_alive());
    }

    #[test]
    fn env_vars_are_passed_to_child() {
        // Script that reads an env var and outputs it in the tool list
        let script = r#"#!/bin/sh
TEST_VAR_VALUE="$TUIC_TEST_ENV_VAR"
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized) ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"%s","description":"d","inputSchema":{"type":"object"}}]}}\n' "$id" "$TEST_VAR_VALUE"
            ;;
    esac
done
"#;
        let mut env = HashMap::new();
        env.insert(
            "TUIC_TEST_ENV_VAR".to_string(),
            "hello-from-env".to_string(),
        );

        let mut tmp = std::env::temp_dir();
        tmp.push(format!("tuic-mcp-env-test-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&tmp, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let config = StdioConfig {
            name: "env-test".to_string(),
            command: "sh".to_string(),
            args: vec![tmp.to_str().unwrap().to_string()],
            env,
            cwd: None,
            timeout: Duration::from_secs(30),
        };

        let mut client = StdioMcpClient::new(config);
        let tools = client.spawn_and_initialize().unwrap();
        assert_eq!(tools[0].original_name, "hello-from-env");
        client.shutdown();
    }

    #[test]
    fn from_upstream_config_returns_some_for_stdio() {
        let transport = crate::mcp_upstream_config::UpstreamTransport::Stdio {
            command: "npx".to_string(),
            args: vec![],
            env: HashMap::new(),
            cwd: None,
        };
        let client = StdioMcpClient::from_upstream_config("test".to_string(), &transport, 30);
        assert!(client.is_some());
    }

    #[test]
    fn from_upstream_config_returns_none_for_http() {
        let transport = crate::mcp_upstream_config::UpstreamTransport::Http {
            url: "http://localhost:8080/mcp".to_string(),
        };
        let client = StdioMcpClient::from_upstream_config("test".to_string(), &transport, 30);
        assert!(client.is_none());
    }

    #[test]
    fn rpc_skips_interleaved_notifications() {
        // Server sends a notification after initialized and before the
        // tools/list response — rpc() must skip it and return the correct response.
        let script = r#"#!/bin/sh
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized)
            # Emit a server notification (no id) — this used to cause "0 tools"
            printf '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'
            ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"alpha","description":"A","inputSchema":{"type":"object"}},{"name":"beta","description":"B","inputSchema":{"type":"object"}}]}}\n' "$id"
            ;;
        tools/call)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}\n' "$id"
            ;;
    esac
done
"#;
        let config = make_config_for_echo_server(script);
        let mut client = StdioMcpClient::new(config);
        let tools = client.spawn_and_initialize().unwrap();

        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].original_name, "alpha");
        assert_eq!(tools[1].original_name, "beta");
        client.shutdown();
    }

    /// A mute upstream used to park the calling thread inside `read_line`
    /// forever. The stdio client is held behind a mutex and driven from the
    /// blocking pool, so one such call wedges every other call to that upstream
    /// and never gives the pool thread back.
    #[test]
    fn call_tool_gives_up_on_a_mute_upstream() {
        // Handshake answers; `tools/call` is read and deliberately left unanswered.
        let script = r#"#!/bin/sh
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized) ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"hang","description":"H","inputSchema":{"type":"object"}}]}}\n' "$id"
            ;;
        tools/call)
            # Silence. The upstream is alive but will never answer.
            ;;
    esac
done
"#;
        let mut config = make_config_for_echo_server(script);
        config.timeout = Duration::from_millis(300);

        // Drive the call off-thread so a client with no deadline fails the test
        // instead of hanging it.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut client = StdioMcpClient::new(config);
            client.spawn_and_initialize().expect("handshake");
            let result = client.call_tool("hang", serde_json::json!({}));
            let _ = tx.send((result, client.is_alive()));
        });

        let (result, still_alive) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("call_tool never returned — no read deadline");
        let err = result.expect_err("a mute upstream must not report success");
        assert!(
            err.contains("timed out"),
            "expected a timeout error, got: {err}"
        );
        assert!(
            !still_alive,
            "a timed-out client must be torn down so the next call cannot read a stale reply"
        );
    }

    /// The reply may sit behind any amount of server chatter. Bounding that by
    /// a message count meant a healthy upstream that logs while it works failed
    /// a call it had answered correctly; the wait is bounded by the deadline the
    /// read already had, so the number of skipped messages does not matter.
    #[test]
    fn a_chatty_upstream_still_delivers_its_reply() {
        let script = r#"#!/bin/sh
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized)
            i=0
            while [ $i -lt 500 ]; do
                printf '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","n":%s}}\n' "$i"
                i=$((i+1))
            done
            ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"delta","description":"D","inputSchema":{"type":"object"}}]}}\n' "$id"
            ;;
    esac
done
"#;
        let config = make_config_for_echo_server(script);
        let mut client = StdioMcpClient::new(config);
        let tools = client
            .spawn_and_initialize()
            .expect("500 notifications must not cost the upstream its reply");

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].original_name, "delta");
        client.shutdown();
    }

    /// A stdout that never runs out of lines, reporting how much of it the
    /// reader actually pulled.
    struct EndlessLines {
        pulled: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl EndlessLines {
        /// 64 bytes including the newline, so the counts below are in lines.
        const LINE: &'static [u8] =
            b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"p\":0}\n";
    }

    impl std::io::Read for EndlessLines {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let n = (buf.len() / Self::LINE.len()) * Self::LINE.len();
            if n == 0 {
                return Ok(0);
            }
            for chunk in buf[..n].chunks_mut(Self::LINE.len()) {
                chunk.copy_from_slice(Self::LINE);
            }
            self.pulled
                .fetch_add(n, std::sync::atomic::Ordering::Relaxed);
            Ok(n)
        }
    }

    /// Nothing drains the reader between calls, so an unbounded queue lets an
    /// upstream that chatters while idle grow TUIC's memory for as long as it
    /// keeps talking. The queue drops instead of growing — and drops instead of
    /// parking, because a parked reader parks the child on its stdout write, and
    /// a child that has stopped reading its stdin can then park TUIC in
    /// `write_line` with no deadline armed yet.
    #[test]
    fn an_idle_upstream_that_never_stops_talking_cannot_grow_the_queue() {
        use std::sync::atomic::Ordering;
        let pulled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let queue = spawn_stdout_reader(EndlessLines {
            pulled: pulled.clone(),
        });

        std::thread::sleep(Duration::from_millis(200));
        let (lines, bytes, dropped) = {
            let state = queue.inner.lock().unwrap();
            (state.lines.len(), state.bytes, state.dropped)
        };
        let read = pulled.load(Ordering::Relaxed) / EndlessLines::LINE.len();

        assert!(
            read > MAX_QUEUED_LINES,
            "the child must have written more than the queue can hold ({read} lines)"
        );
        assert!(
            lines <= MAX_QUEUED_LINES && bytes <= MAX_QUEUED_BYTES,
            "the queue must stay inside its bounds: {lines} lines / {bytes} bytes"
        );
        assert!(dropped > 0, "what did not fit must be counted as dropped");

        // The reader is still running: it drops, it does not park.
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            pulled.load(Ordering::Relaxed) / EndlessLines::LINE.len() > read,
            "a lossy queue must never stop the reader"
        );
        queue.close();
    }

    /// A pipe whose reader never reads: `write_all` parks and does not return.
    struct NeverAccepted {
        entered: std::sync::Arc<std::sync::atomic::AtomicBool>,
        release: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl std::io::Write for NeverAccepted {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.entered
                .store(true, std::sync::atomic::Ordering::Release);
            while !self.release.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// A request larger than the pipe buffer parks in `write_all` until the child
    /// reads it, and a child that stopped reading its stdin never does. The caller
    /// is a blocking-pool thread holding the upstream's mutex, so that one write
    /// used to wedge the upstream for the life of the process — the deadline could
    /// not help, because it was only armed after the write returned.
    #[test]
    fn a_request_to_an_upstream_that_stopped_reading_gives_up_on_the_deadline() {
        let entered = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let release = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let tx = spawn_stdin_writer(NeverAccepted {
            entered: entered.clone(),
            release: release.clone(),
        });

        let started = Instant::now();
        let outcome = write_through(
            &tx,
            "{}\n".to_string(),
            started + Duration::from_millis(150),
        );

        assert_eq!(outcome, Err(WriteEnd::Timeout));
        assert!(
            entered.load(std::sync::atomic::Ordering::Acquire),
            "the write must actually have been attempted"
        );
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the write must end on its deadline, not when the child feels like reading"
        );

        // Let the parked writer thread finish so the test leaves nothing behind.
        release.store(true, std::sync::atomic::Ordering::Release);
    }

    #[test]
    fn a_write_that_the_child_accepts_reports_success_and_sends_the_exact_bytes() {
        /// Shares the written bytes with the test.
        struct Recorder(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Recorder {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let written = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let tx = spawn_stdin_writer(Recorder(written.clone()));

        let deadline = Instant::now() + Duration::from_secs(5);
        assert_eq!(
            write_through(&tx, "{\"id\":1}\n".to_string(), deadline),
            Ok(())
        );
        assert_eq!(
            write_through(&tx, "{\"id\":2}\n".to_string(), deadline),
            Ok(())
        );
        assert_eq!(
            String::from_utf8(written.lock().unwrap().clone()).unwrap(),
            "{\"id\":1}\n{\"id\":2}\n"
        );
    }

    #[test]
    fn a_write_to_a_broken_pipe_reports_the_failure_rather_than_timing_out() {
        struct Broken;
        impl std::io::Write for Broken {
            fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "gone"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let tx = spawn_stdin_writer(Broken);
        let outcome = write_through(
            &tx,
            "{}\n".to_string(),
            Instant::now() + Duration::from_secs(5),
        );
        assert!(
            matches!(outcome, Err(WriteEnd::Failed(ref e)) if e.contains("gone")),
            "got {outcome:?}"
        );
    }

    /// A child that never writes a newline used to grow one `String` for as long
    /// as it kept writing. The line is capped and discarded whole — the retained
    /// tail of an over-long line is itself a line nobody sent.
    #[test]
    fn a_line_that_never_ends_is_dropped_rather_than_grown() {
        struct NeverANewline {
            pulled: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        }
        impl std::io::Read for NeverANewline {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'x');
                self.pulled
                    .fetch_add(buf.len(), std::sync::atomic::Ordering::Relaxed);
                Ok(buf.len())
            }
        }
        let pulled = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let queue = spawn_stdout_reader(NeverANewline {
            pulled: pulled.clone(),
        });

        std::thread::sleep(Duration::from_millis(200));
        let (lines, bytes) = {
            let state = queue.inner.lock().unwrap();
            (state.lines.len(), state.bytes)
        };
        assert!(
            pulled.load(std::sync::atomic::Ordering::Relaxed) > MAX_LINE_BYTES,
            "the child must have written past the cap for this to prove anything"
        );
        assert_eq!(
            (lines, bytes),
            (0, 0),
            "an unterminated line must never reach the queue"
        );
        queue.close();
    }

    /// An upstream that refills the queue faster than TUIC drains it kept a call
    /// alive forever when the read preferred a ready line over the clock: every
    /// wait found something to parse, so the timeout arm was never reached.
    #[test]
    fn a_full_queue_does_not_outrank_the_deadline() {
        let queue = LineQueue::new();
        for i in 0..8 {
            assert!(queue.push(format!("{{\"n\":{i}}}")));
        }
        let deadline = Instant::now();
        assert!(
            matches!(queue.recv_deadline(deadline), Err(ReadEnd::Timeout)),
            "being out of time outranks having something to parse"
        );
    }

    #[test]
    fn rpc_skips_multiple_notifications() {
        // Server sends 3 notifications before the tools/list response.
        let script = r#"#!/bin/sh
while IFS= read -r line; do
    method=$(echo "$line" | sed 's/.*"method":"\([^"]*\)".*/\1/')
    id=$(echo "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
    case "$method" in
        initialize)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1.0"}}}\n' "$id"
            ;;
        notifications/initialized)
            printf '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'
            printf '{"jsonrpc":"2.0","method":"notifications/progress","params":{"token":"abc"}}\n'
            printf '{"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"starting"}}\n'
            ;;
        tools/list)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"gamma","description":"G","inputSchema":{"type":"object"}}]}}\n' "$id"
            ;;
        tools/call)
            printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"ok"}],"isError":false}}\n' "$id"
            ;;
    esac
done
"#;
        let config = make_config_for_echo_server(script);
        let mut client = StdioMcpClient::new(config);
        let tools = client.spawn_and_initialize().unwrap();

        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].original_name, "gamma");
        client.shutdown();
    }
}
