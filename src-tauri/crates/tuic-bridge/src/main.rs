//! Resilient MCP stdio ↔ IPC transport adapter for FastAF.
//! Proxies JSON-RPC messages from stdin to POST /mcp on the local IPC endpoint,
//! forwarding responses back to stdout. Stays alive even without TUIC running,
//! reconnects automatically, and emits `notifications/tools/list_changed` when
//! the connection state changes.
//!
//! Unix: connects via Unix domain socket at `<config_dir>/mcp.sock`
//! Windows: connects via named pipe at `\\.\pipe\tuicommander-mcp`

use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::{
    Arc, LazyLock, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// `$TUIC_SESSION` inherited from the parent agent PTY, read once at startup.
/// `None` when the bridge runs outside a TUIC-managed PTY (e.g. a bare CLI).
static TUIC_SESSION_ENV: LazyLock<Option<String>> =
    LazyLock::new(|| std::env::var("TUIC_SESSION").ok().filter(|s| !s.is_empty()));

const MCP_RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";
const MCP_WAIT_DEFAULT_MS: u64 = 60_000;
const MCP_WAIT_MAX_MS: u64 = 300_000;
/// Bounded transport overhead beyond the server-side wait. This covers HTTP
/// framing and scheduler latency without turning unrelated calls into long
/// hangs; the requested wait itself remains authoritative.
const MCP_WAIT_RESPONSE_MARGIN_MS: u64 = 5_000;
/// How long in-flight requests may keep running after stdin closes.
const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

fn wait_timeout_ms(request: &Value) -> Option<u64> {
    let name = request.pointer("/params/name").and_then(Value::as_str)?;
    let outer_arguments = request.pointer("/params/arguments")?;
    let arguments = if name == "call_tool" {
        let tool = outer_arguments.get("tool_name").and_then(Value::as_str)?;
        if !matches!(tool, "agent" | "session") {
            return None;
        }
        outer_arguments.get("arguments")?
    } else {
        if !matches!(name, "agent" | "session") {
            return None;
        }
        outer_arguments
    };
    if arguments.get("action").and_then(Value::as_str) != Some("wait") {
        return None;
    }
    Some(
        arguments
            .get("timeout_ms")
            .and_then(Value::as_u64)
            .filter(|timeout| *timeout > 0)
            .unwrap_or(MCP_WAIT_DEFAULT_MS)
            .min(MCP_WAIT_MAX_MS),
    )
}

fn response_timeout(body: &str) -> std::time::Duration {
    let Ok(request) = serde_json::from_str::<Value>(body) else {
        return MCP_RESPONSE_TIMEOUT;
    };
    wait_timeout_ms(&request)
        .map(|timeout| {
            std::time::Duration::from_millis(timeout.saturating_add(MCP_WAIT_RESPONSE_MARGIN_MS))
        })
        .unwrap_or(MCP_RESPONSE_TIMEOUT)
}

// ---------------------------------------------------------------------------
// Platform-specific IPC connection
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn config_dir() -> std::path::PathBuf {
    dirs::config_dir()
        .map(|d| d.join("com.fastaf.ide"))
        .unwrap_or_else(|| {
            dirs::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("."))
                .join(".tuicommander")
        })
}

#[cfg(unix)]
fn ipc_endpoint() -> String {
    config_dir().join("mcp.sock").to_string_lossy().to_string()
}

#[cfg(windows)]
fn ipc_endpoint() -> String {
    r"\\.\pipe\tuicommander-mcp".to_string()
}

/// Wrapper that provides a unified IPC stream type across platforms.
/// Both inner types implement AsyncRead + AsyncWrite + Unpin.
enum IpcStream {
    #[cfg(unix)]
    Unix(tokio::net::UnixStream),
    #[cfg(windows)]
    Pipe(tokio::net::windows::named_pipe::NamedPipeClient),
}

impl tokio::io::AsyncRead for IpcStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for IpcStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_flush(cx),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        match self.get_mut() {
            #[cfg(unix)]
            IpcStream::Unix(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            #[cfg(windows)]
            IpcStream::Pipe(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

/// Open a connection to the TUIC IPC endpoint.
/// Tries `TUIC_SOCKET` env var first, then `mcp.sock`, then any `mcp-*.sock` in config_dir.
async fn connect_ipc() -> Result<IpcStream, String> {
    #[cfg(unix)]
    {
        // Tests point the transport at a mock server on a temp socket.
        #[cfg(test)]
        if let Some(path) = tests::test_ipc_path() {
            let stream = tokio::net::UnixStream::connect(&path)
                .await
                .map_err(|e| format!("connect {}: {e}", path.display()))?;
            return Ok(IpcStream::Unix(stream));
        }

        // Explicit override via environment variable
        if let Ok(explicit) = std::env::var("TUIC_SOCKET") {
            let path = std::path::PathBuf::from(&explicit);
            let stream = tokio::net::UnixStream::connect(&path)
                .await
                .map_err(|e| format!("connect {}: {e}", path.display()))?;
            return Ok(IpcStream::Unix(stream));
        }

        let dir = config_dir();
        let primary = dir.join("mcp.sock");

        // Try primary socket first (with timeout to avoid hanging on stale sockets)
        if let Ok(Ok(stream)) = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::net::UnixStream::connect(&primary),
        )
        .await
        {
            return Ok(IpcStream::Unix(stream));
        }

        // Fall back to mcp-*.sock alternatives
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name_str) = name.to_str() else {
                    continue;
                };
                if name_str.starts_with("mcp-")
                    && name_str.ends_with(".sock")
                    && let Ok(Ok(stream)) = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        tokio::net::UnixStream::connect(&entry.path()),
                    )
                    .await
                {
                    return Ok(IpcStream::Unix(stream));
                }
            }
        }

        Err(format!(
            "connect {}: no live socket found",
            primary.display()
        ))
    }
    #[cfg(windows)]
    {
        const PIPE_NAME: &str = r"\\.\pipe\tuicommander-mcp";
        let client = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(PIPE_NAME)
            .map_err(|e| format!("connect {PIPE_NAME}: {e}"))?;
        Ok(IpcStream::Pipe(client))
    }
}

// ---------------------------------------------------------------------------
// Identity header
// ---------------------------------------------------------------------------

/// HTTP header the bridge asserts so the server can auto-bind this connection to
/// the agent's PTY session. The value is `$TUIC_SESSION`, inherited from the
/// parent agent process — the bridge never invents it. Absent env → no header,
/// and the server falls back to explicit `agent register`.
fn tuic_session_header_line(tuic_session: Option<&str>) -> String {
    match tuic_session {
        Some(s) if !s.is_empty() => format!("x-tuic-session: {s}\r\n"),
        _ => String::new(),
    }
}

/// Project the protocol version carried by a stdio request into the HTTP
/// transport header. Only the MCP date-revision grammar is reflected so an
/// untrusted downstream string can never inject another header.
fn request_protocol_version(body: &str) -> String {
    let parsed = serde_json::from_str::<Value>(body).ok();
    let candidate = parsed
        .as_ref()
        .and_then(|request| {
            request
                .pointer("/params/_meta/io.modelcontextprotocol~1protocolVersion")
                .or_else(|| request.pointer("/params/protocolVersion"))
        })
        .and_then(Value::as_str);
    candidate
        .filter(|version| {
            version.len() == 10
                && version.bytes().enumerate().all(|(index, byte)| {
                    if matches!(index, 4 | 7) {
                        byte == b'-'
                    } else {
                        byte.is_ascii_digit()
                    }
                })
        })
        .unwrap_or(LEGACY_PROTOCOL_VERSION)
        .to_string()
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

/// Write one already-serialized JSON line to stdout (MCP stdio transport delimiter
/// is \n). Concurrent request tasks share stdout, so the lock covers the whole
/// line — a response can never be interleaved with another.
/// Exits the process if stdout is closed — the MCP client is gone, nothing left to do.
fn emit_raw(line: &str) {
    let mut stdout = io::stdout().lock();
    if writeln!(stdout, "{line}").is_err() {
        std::process::exit(0);
    }
    let _ = stdout.flush();
}

/// Write a JSON line to stdout.
fn emit(json: &Value) {
    emit_raw(&serde_json::to_string(json).unwrap_or_default());
}

fn emit_tools_changed() {
    emit(&serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/tools/list_changed"
    }));
}

// ---------------------------------------------------------------------------
// HTTP-over-IPC transport
// ---------------------------------------------------------------------------

/// Send an HTTP POST to /mcp over an IPC connection.
/// Returns the response body and any mcp-session-id header value.
async fn post_mcp(
    body: &str,
    session_id: Option<&str>,
) -> Result<(String, Option<String>), String> {
    let mut stream = connect_ipc().await?;

    let mut headers = format!(
        "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nMCP-Protocol-Version: {}\r\nContent-Length: {}\r\nConnection: close\r\n",
        request_protocol_version(body),
        body.len()
    );
    if let Some(sid) = session_id {
        headers.push_str(&format!("mcp-session-id: {sid}\r\n"));
    }
    // Assert our PTY identity so the server auto-binds swarm identity without an
    // explicit `agent register` round-trip. Read once, cached at startup.
    headers.push_str(&tuic_session_header_line(TUIC_SESSION_ENV.as_deref()));
    headers.push_str("\r\n");

    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write headers: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write body: {e}"))?;

    // Do not wait for EOF: hyper may keep an accepted IPC connection alive even
    // when the request says `Connection: close`. Read exactly Content-Length and
    // drop our stream immediately, otherwise a keep-alive connection leaves an
    // accepted mcp.sock FD behind in TUIC. Wait calls derive this transport
    // deadline from their requested server timeout plus a bounded margin.
    let (header_section, response_body) =
        tokio::time::timeout(response_timeout(body), read_http_response(&mut stream))
            .await
            .map_err(|_| "read: response timed out".to_string())??;

    // Extract mcp-session-id from response headers
    let sid = header_section.lines().find_map(|line| {
        let lower = line.to_lowercase();
        if lower.starts_with("mcp-session-id:") {
            Some(line.split_once(':')?.1.trim().to_string())
        } else {
            None
        }
    });

    Ok((response_body, sid))
}

async fn read_http_response<R>(reader: &mut R) -> Result<(String, String), String>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(4096);
    let mut chunk = [0u8; 4096];
    loop {
        let n = reader
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            return Err("read: response ended before the declared body length".to_string());
        }
        buf.extend_from_slice(&chunk[..n]);

        let Some(header_end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            continue;
        };
        let body_start = header_end + 4;
        let headers = String::from_utf8_lossy(&buf[..header_end]).to_string();
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        });
        let Some(content_length) = content_length else {
            return Err("read: HTTP response missing Content-Length".to_string());
        };
        if buf.len() < body_start + content_length {
            continue;
        }
        let body =
            String::from_utf8_lossy(&buf[body_start..body_start + content_length]).to_string();
        return Ok((headers, body));
    }
}

/// Establish an MCP session with the TUIC server.
/// Returns (session_id, server_response_body).
async fn server_initialize() -> Result<(String, String), String> {
    let init_body = serde_json::json!({
        "jsonrpc": "2.0", "id": 0,
        "method": "initialize",
        "params": { "protocolVersion": LEGACY_PROTOCOL_VERSION, "capabilities": {}, "clientInfo": { "name": "tuic-bridge", "version": env!("CARGO_PKG_VERSION") } }
    });
    let (body, sid) = post_mcp(&serde_json::to_string(&init_body).unwrap(), None).await?;
    let sid = sid.ok_or_else(|| "server did not return mcp-session-id".to_string())?;
    Ok((sid, body))
}

/// Re-establish the upstream protocol session after TUIC restarts. Replaying
/// the downstream initialize preserves client-specific server behavior (for
/// example Grok's compact meta-tool surface) without exposing another response
/// to the downstream client.
async fn server_reinitialize(downstream_initialize: Option<String>) -> Result<String, String> {
    let (mut sid, _) = server_initialize().await?;
    if let Some(initialize) = downstream_initialize {
        let (_, restored_sid) = post_mcp(&initialize, Some(&sid)).await?;
        if let Some(restored_sid) = restored_sid {
            sid = restored_sid;
        }
    }
    Ok(sid)
}

// ---------------------------------------------------------------------------
// SSE listener
// ---------------------------------------------------------------------------

struct BridgeState {
    session_id: Mutex<Option<String>>,
    connected: AtomicBool,
    /// Handle to the SSE listener task — aborted and restarted on reconnect.
    sse_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Last initialize received from the stdio client. Replayed after an
    /// upstream restart so TUIC restores client-specific session metadata.
    downstream_initialize: Mutex<Option<String>>,
    /// Serializes reconnect attempts. Requests run concurrently, so without this
    /// every task that finds the bridge offline would fire its own `initialize`.
    reconnect_lock: tokio::sync::Mutex<()>,
}

impl BridgeState {
    fn new() -> Self {
        Self {
            session_id: Mutex::new(None),
            connected: AtomicBool::new(false),
            sse_handle: Mutex::new(None),
            downstream_initialize: Mutex::new(None),
            reconnect_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn downstream_initialize(&self) -> Option<String> {
        self.downstream_initialize.lock().unwrap().clone()
    }
}

/// Open a persistent GET /mcp SSE connection and forward server notifications to stdout.
/// Runs until the connection is closed or an error occurs.
async fn sse_listener(session_id: String) {
    let Ok(mut stream) = connect_ipc().await else {
        return;
    };

    let request = format!(
        "GET /mcp HTTP/1.1\r\nHost: localhost\r\nAccept: text/event-stream\r\nmcp-session-id: {session_id}\r\n{}\r\n",
        tuic_session_header_line(TUIC_SESSION_ENV.as_deref())
    );
    if stream.write_all(request.as_bytes()).await.is_err() {
        return;
    }

    // Read SSE events line by line using a simple buffer
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 1024];
    loop {
        let n = match stream.read(&mut tmp).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&tmp[..n]);

        // Process complete lines (SSE uses \n-delimited frames)
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..pos]).trim().to_string();
            buf.drain(..=pos);

            if let Some(data) = line.strip_prefix("data:") {
                let data = data.trim();
                if data.contains("tools/list_changed") {
                    emit_tools_changed();
                }
            }
        }
    }
}

/// Spawn (or restart) the SSE listener background task.
/// The spawned task auto-restarts the SSE connection when it drops,
/// with exponential backoff (1s → 2s → 4s, capped at 8s).
fn start_sse_listener(state: &Arc<BridgeState>) {
    let sid = state.session_id.lock().unwrap().clone();
    let Some(sid) = sid else { return };

    // Abort previous listener if any
    if let Some(handle) = state.sse_handle.lock().unwrap().take() {
        handle.abort();
    }

    let bridge_state = Arc::clone(state);
    let handle = tokio::spawn(async move {
        let mut backoff = std::time::Duration::from_secs(1);
        const MAX_BACKOFF: std::time::Duration = std::time::Duration::from_secs(8);
        loop {
            sse_listener(sid.clone()).await;
            if !bridge_state.connected.load(Ordering::Acquire) {
                break;
            }
            eprintln!(
                "tuic-bridge: SSE listener ended, reconnecting in {:?}",
                backoff
            );
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(MAX_BACKOFF);
            if !bridge_state.connected.load(Ordering::Acquire) {
                break;
            }
        }
    });
    *state.sse_handle.lock().unwrap() = Some(handle);
}

/// Respond when TUIC is not available.
fn emit_offline_response(method: &str, id: &Value) {
    match method {
        "tools/list" => emit(&serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": { "tools": [] }
        })),
        "tools/call" => emit(&serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "content": [{ "type": "text", "text": "FastAF MCP is unavailable. The app may still be running; enable its MCP server and retry." }],
                "isError": true
            }
        })),
        _ => emit(&serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        })),
    }
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

/// Re-establish the upstream session, at most one attempt at a time.
///
/// Concurrent request tasks all observe the same `connected == false`, so the
/// lock (plus the re-check after acquiring it) collapses their reconnect attempts
/// into a single `initialize` instead of one per queued request.
async fn ensure_connected(state: &Arc<BridgeState>) {
    let _guard = state.reconnect_lock.lock().await;
    if state.connected.load(Ordering::Acquire) {
        return;
    }
    if let Ok(sid) = server_reinitialize(state.downstream_initialize()).await {
        eprintln!("tuic-bridge: reconnected to TUIC");
        *state.session_id.lock().unwrap() = Some(sid);
        state.connected.store(true, Ordering::Release);
        start_sse_listener(state);
        emit_tools_changed();
    }
}

/// Proxy one request to TUIC and forward its response to stdout.
///
/// Spawned per request by [`dispatch_loop`]: a blocking call (`agent wait` /
/// `session wait` park server-side for up to 300s) must not delay the requests
/// behind it. Awaiting this inline was head-of-line blocking — an unrelated
/// `repo worktree_list` sent in the same parallel tool block inherited the whole
/// wait, and its own 10s transport timeout only started once the wait returned.
/// JSON-RPC responses may complete out of order; each carries its own `id`.
async fn proxy_request(state: Arc<BridgeState>, line: String, method: String, id: Value) {
    if !state.connected.load(Ordering::Acquire) {
        ensure_connected(&state).await;
    }
    if !state.connected.load(Ordering::Acquire) {
        emit_offline_response(&method, &id);
        return;
    }

    let sid = state.session_id.lock().unwrap().clone();
    match post_mcp(&line, sid.as_deref()).await {
        Ok((body, new_sid)) => {
            // Update session ID if server returned a new one — but only while the
            // connection we borrowed is still the live one. The health loop can
            // declare the bridge disconnected (and clear the session) while this
            // request is in flight; writing our id back then would resurrect a
            // session generation the reconnect path has already retired.
            // DEFERRED (2026-07-31) — a connection epoch stamped on each request
            // would close the remaining TOCTOU window. Not worth the machinery
            // until an actual stale-session report appears: the server
            // re-registers a stale session id on the next tools/call anyway.
            if let Some(s) = new_sid
                && state.connected.load(Ordering::Acquire)
            {
                *state.session_id.lock().unwrap() = Some(s);
            }
            // Forward raw JSON response to stdout
            emit_raw(&body);
        }
        Err(e) => {
            eprintln!("tuic-bridge: proxy error: {e}");
            // A single request timeout is not proof that TUIC stopped.
            // Preserve the MCP session/identity; the health loop applies
            // the three-failure hysteresis and owns disconnect decisions.
            emit(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": -32000,
                    "message": format!("FastAF IPC request failed: {e}")
                }
            }));
        }
    }
}

/// Handle the downstream `initialize` inline (it establishes the session every
/// later request depends on, so it must not race them).
///
/// Holds `reconnect_lock` for the whole exchange: being inline in the dispatch
/// loop only orders it against *unread* stdin lines, not against requests already
/// spawned. Sharing the lock with [`ensure_connected`] makes it the single owner
/// of session establishment, so a request-triggered reconnect can't open a second
/// upstream session concurrently and clobber `session_id`.
async fn handle_initialize(state: &Arc<BridgeState>, line: String, id: Value) {
    let _guard = state.reconnect_lock.lock().await;
    *state.downstream_initialize.lock().unwrap() = Some(line.clone());
    // Proxy to server when connected to get dynamic instructions.
    // The server response includes intent protocol, active sessions, etc.
    // Fall back to a minimal local response only when offline.
    let proxied = if state.connected.load(Ordering::Acquire) || {
        // Try lazy connect if not yet connected
        if let Ok((sid, _)) = server_initialize().await {
            eprintln!("tuic-bridge: connected to TUIC");
            *state.session_id.lock().unwrap() = Some(sid);
            state.connected.store(true, Ordering::Release);
            start_sse_listener(state);
            true
        } else {
            false
        }
    } {
        let sid = state.session_id.lock().unwrap().clone();
        match post_mcp(&line, sid.as_deref()).await {
            Ok((body, new_sid)) => {
                if let Some(s) = new_sid {
                    *state.session_id.lock().unwrap() = Some(s);
                }
                // Parse server response, inject listChanged capability
                // (the server doesn't advertise it but the bridge supports it)
                if let Ok(mut resp) = serde_json::from_str::<Value>(&body) {
                    resp["result"]["capabilities"]["tools"]["listChanged"] = Value::Bool(true);
                    Some(resp)
                } else {
                    None
                }
            }
            Err(e) => {
                eprintln!("tuic-bridge: initialize proxy error: {e}");
                state.connected.store(false, Ordering::Release);
                *state.session_id.lock().unwrap() = None;
                None
            }
        }
    } else {
        None
    };

    emit(&proxied.unwrap_or_else(|| {
        serde_json::json!({
            "jsonrpc": "2.0", "id": id,
            "result": {
                "protocolVersion": LEGACY_PROTOCOL_VERSION,
                "capabilities": { "tools": { "listChanged": true } },
                "serverInfo": { "name": "tuicommander", "version": env!("CARGO_PKG_VERSION") }
            }
        })
    }));
}

/// Read stdio requests and dispatch them, keeping the reader free at all times.
/// Returns once stdin is closed and every in-flight request has been answered.
async fn dispatch_loop(
    state: Arc<BridgeState>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<String>,
) {
    let mut inflight = tokio::task::JoinSet::new();

    while let Some(line) = rx.recv().await {
        // Reap finished tasks so the set doesn't grow across a long session.
        while inflight.try_join_next().is_some() {}

        let request: Value = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("tuic-bridge: invalid JSON: {e}");
                continue;
            }
        };

        let method = request["method"].as_str().unwrap_or("").to_string();
        let id = request.get("id").cloned().unwrap_or(Value::Null);

        match method.as_str() {
            "initialize" => handle_initialize(&state, line, id).await,
            "notifications/initialized" => {} // Acknowledgment, no response
            _ => {
                inflight.spawn(proxy_request(Arc::clone(&state), line, method, id));
            }
        }
    }

    // stdin closed: the client is gone. Give in-flight requests a short grace to
    // finish writing their responses, then let the JoinSet drop abort the rest —
    // a pending 300s `agent wait` must not keep the process alive after EOF.
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, async {
        while inflight.join_next().await.is_some() {}
    })
    .await;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    eprintln!(
        "tuic-bridge v{} starting ({})",
        env!("CARGO_PKG_VERSION"),
        ipc_endpoint()
    );

    let state = Arc::new(BridgeState::new());

    // Try initial connection
    match server_initialize().await {
        Ok((sid, _)) => {
            eprintln!("tuic-bridge: connected to TUIC");
            *state.session_id.lock().unwrap() = Some(sid);
            state.connected.store(true, Ordering::Release);
            start_sse_listener(&state);
        }
        Err(error) => {
            eprintln!("tuic-bridge: MCP endpoint unavailable, will retry in background: {error}");
        }
    }

    // Background reconnection loop. Hysteresis: disconnect only after N consecutive
    // health failures — a single transient (GC pause, socket accept lag, EOF during
    // Tauri bg work) must not flip the bridge offline.
    const HEALTH_FAIL_THRESHOLD: u32 = 3;
    let bg_state = Arc::clone(&state);
    tokio::spawn(async move {
        let mut consecutive_failures: u32 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if bg_state.connected.load(Ordering::Acquire) {
                let sid = bg_state.session_id.lock().unwrap().clone();
                let health = post_mcp(
                    &serde_json::to_string(
                        &serde_json::json!({"jsonrpc":"2.0","id":0,"method":"ping"}),
                    )
                    .unwrap(),
                    sid.as_deref(),
                )
                .await;
                if health.is_err() {
                    consecutive_failures += 1;
                    eprintln!(
                        "tuic-bridge: health check failed ({}/{})",
                        consecutive_failures, HEALTH_FAIL_THRESHOLD
                    );
                    if consecutive_failures >= HEALTH_FAIL_THRESHOLD {
                        eprintln!("tuic-bridge: connection lost");
                        *bg_state.session_id.lock().unwrap() = None;
                        bg_state.connected.store(false, Ordering::Release);
                        if let Some(h) = bg_state.sse_handle.lock().unwrap().take() {
                            h.abort();
                        }
                        emit_tools_changed();
                        consecutive_failures = 0;
                    }
                } else {
                    consecutive_failures = 0;
                }
            } else if let Ok(sid) = server_reinitialize(bg_state.downstream_initialize()).await {
                eprintln!("tuic-bridge: reconnected to TUIC");
                *bg_state.session_id.lock().unwrap() = Some(sid);
                bg_state.connected.store(true, Ordering::Release);
                start_sse_listener(&bg_state);
                emit_tools_changed();
                consecutive_failures = 0;
            }
        }
    });

    // Stdin reader in blocking thread → channel → async handler
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    if tx.send(l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
                _ => {}
            }
        }
    });

    dispatch_loop(state, rx).await;
}

#[cfg(test)]
mod tests {
    use super::{
        BridgeState, dispatch_loop, read_http_response, request_protocol_version, response_timeout,
        tuic_session_header_line,
    };
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Socket the mock IPC server listens on, read by `connect_ipc` under `cfg(test)`.
    static TEST_IPC_PATH: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
    /// Serializes the tests that install a mock server (the path above is global).
    /// Poisoning is ignored: a failing test must not cascade into the others.
    static TEST_IPC_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(super) fn test_ipc_path() -> Option<PathBuf> {
        TEST_IPC_PATH
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Holds the serialization lock and clears the global socket path on drop, so a
    /// panicking test leaves no mock installed for the next one.
    struct MockGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        _dir: tempfile::TempDir,
        stats: Arc<MockStats>,
    }

    impl Drop for MockGuard {
        fn drop(&mut self) {
            *TEST_IPC_PATH.lock().unwrap_or_else(|e| e.into_inner()) = None;
        }
    }

    /// What the mock server observed, so tests can assert on real transport behavior.
    #[derive(Default)]
    struct MockStats {
        /// Requests currently being served — the concurrency proof.
        in_flight: AtomicUsize,
        max_in_flight: AtomicUsize,
        initializes: AtomicUsize,
        tool_calls: AtomicUsize,
    }

    /// Mock TUIC IPC endpoint. Answers `initialize` with a session id and any other
    /// request with a JSON-RPC result, sleeping `slow_ms` when the body contains
    /// `"slow"` so a test can hold one request open while sending the next.
    async fn start_mock_ipc(slow_ms: u64) -> MockGuard {
        let lock = TEST_IPC_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("mcp.sock");
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        *TEST_IPC_PATH.lock().unwrap_or_else(|e| e.into_inner()) = Some(sock);

        let stats = Arc::new(MockStats::default());
        let server_stats = Arc::clone(&stats);
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let stats = Arc::clone(&server_stats);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 2048];
                    // One request per connection (the bridge sends `Connection: close`).
                    while let Ok(n) = stream.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            break;
                        }
                    }
                    let text = String::from_utf8_lossy(&buf).to_string();
                    // The SSE listener opens a GET /mcp stream; only count RPC posts.
                    if text.contains("\"initialize\"") {
                        stats.initializes.fetch_add(1, Ordering::SeqCst);
                    } else if text.contains("tools/call") {
                        stats.tool_calls.fetch_add(1, Ordering::SeqCst);
                    }

                    let now = stats.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                    stats.max_in_flight.fetch_max(now, Ordering::SeqCst);
                    if text.contains("slow") {
                        tokio::time::sleep(std::time::Duration::from_millis(slow_ms)).await;
                    }
                    stats.in_flight.fetch_sub(1, Ordering::SeqCst);

                    let body = r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nmcp-session-id: test-sid\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                    let _ = stream.flush().await;
                });
            }
        });
        MockGuard {
            _lock: lock,
            _dir: dir,
            stats,
        }
    }

    fn connected_state() -> Arc<BridgeState> {
        let state = Arc::new(BridgeState::new());
        *state.session_id.lock().unwrap() = Some("test-sid".to_string());
        state.connected.store(true, Ordering::Release);
        state
    }

    fn call(name: &str) -> String {
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{name}","arguments":{{"action":"list"}}}}}}"#
        )
    }

    /// The regression: a long request must not hold the reader hostage. Two slow
    /// (300ms) calls sent back-to-back finish in roughly one slow window, and the
    /// server sees both open at once.
    #[tokio::test]
    async fn concurrent_requests_are_not_serialized() {
        let mock = start_mock_ipc(300).await;
        let stats = &mock.stats;
        let state = connected_state();

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(call("slow_wait")).unwrap();
        tx.send(call("slow_other")).unwrap();
        drop(tx);

        let started = std::time::Instant::now();
        dispatch_loop(state, rx).await;
        let elapsed = started.elapsed();

        assert_eq!(stats.tool_calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            stats.max_in_flight.load(Ordering::SeqCst),
            2,
            "both requests must be in flight together — serialized dispatch is the bug"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(550),
            "two 300ms calls took {elapsed:?}: they ran back-to-back, not concurrently"
        );
    }

    /// A fast call sent behind a long one must not wait for it. Without concurrent
    /// dispatch the fast call could only be served after the slow one returned.
    #[tokio::test]
    async fn fast_request_is_served_while_a_slow_one_is_pending() {
        let mock = start_mock_ipc(400).await;
        let stats = &mock.stats;
        let state = connected_state();

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(call("slow_wait")).unwrap();
        tx.send(call("repo")).unwrap();
        drop(tx);

        let started = std::time::Instant::now();
        dispatch_loop(state, rx).await;

        assert_eq!(stats.tool_calls.load(Ordering::SeqCst), 2);
        assert_eq!(stats.max_in_flight.load(Ordering::SeqCst), 2);
        assert!(
            started.elapsed() < std::time::Duration::from_millis(650),
            "the fast call inherited the slow call's latency"
        );
    }

    /// Concurrency must not turn a reconnect into an `initialize` storm: three
    /// requests arriving while offline share a single re-initialize.
    #[tokio::test]
    async fn concurrent_requests_reconnect_only_once() {
        let mock = start_mock_ipc(0).await;
        let stats = &mock.stats;
        // Offline: no session id, connected = false.
        let state = Arc::new(BridgeState::new());

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        for _ in 0..3 {
            tx.send(call("session")).unwrap();
        }
        drop(tx);

        dispatch_loop(Arc::clone(&state), rx).await;

        assert_eq!(
            stats.initializes.load(Ordering::SeqCst),
            1,
            "each queued request fired its own initialize"
        );
        assert_eq!(stats.tool_calls.load(Ordering::SeqCst), 3);
        assert!(state.connected.load(Ordering::Acquire));
    }

    /// `initialize` must not open a second upstream session while an already
    /// spawned request is reconnecting. Both paths take `reconnect_lock`, so the
    /// offline burst produces exactly one session establishment (+ the proxied
    /// downstream initialize) instead of one per reconnect authority.
    #[tokio::test]
    async fn initialize_does_not_race_an_in_flight_reconnect() {
        let mock = start_mock_ipc(150).await;
        let stats = &mock.stats;
        // Offline, so the spawned tool call triggers a reconnect of its own.
        let state = Arc::new(BridgeState::new());

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(call("slow_session")).unwrap();
        tx.send(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#.to_string())
            .unwrap();
        drop(tx);

        dispatch_loop(Arc::clone(&state), rx).await;

        assert_eq!(
            stats.initializes.load(Ordering::SeqCst),
            2,
            "expected one session establishment + one proxied downstream initialize; \
             more means initialize and the request path reconnected concurrently"
        );
        assert_eq!(stats.tool_calls.load(Ordering::SeqCst), 1);
        assert!(state.connected.load(Ordering::Acquire));
    }

    /// `initialize` stays sequential: it establishes the session every later
    /// request needs, so it is answered before the loop dispatches anything else.
    #[tokio::test]
    async fn initialize_is_handled_before_later_requests() {
        let mock = start_mock_ipc(0).await;
        let stats = &mock.stats;
        let state = Arc::new(BridgeState::new());

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        tx.send(r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#.to_string())
            .unwrap();
        tx.send(call("session")).unwrap();
        drop(tx);

        dispatch_loop(Arc::clone(&state), rx).await;

        // One initialize to open the upstream session + the proxied downstream one.
        assert_eq!(stats.initializes.load(Ordering::SeqCst), 2);
        assert_eq!(stats.tool_calls.load(Ordering::SeqCst), 1);
        assert!(
            state.downstream_initialize().is_some(),
            "the downstream initialize must be retained for replay after a restart"
        );
    }

    #[test]
    fn header_emitted_when_session_present() {
        assert_eq!(
            tuic_session_header_line(Some("550e8400-e29b-41d4-a716-446655440a01")),
            "x-tuic-session: 550e8400-e29b-41d4-a716-446655440a01\r\n"
        );
    }

    #[test]
    fn header_absent_without_session() {
        assert_eq!(tuic_session_header_line(None), "");
        assert_eq!(tuic_session_header_line(Some("")), "");
    }

    #[test]
    fn request_protocol_version_projects_modern_meta_legacy_and_fallback() {
        let modern =
            r#"{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#;
        assert_eq!(request_protocol_version(modern), "2026-07-28");

        let legacy = r#"{"params":{"protocolVersion":"2025-11-25"}}"#;
        assert_eq!(request_protocol_version(legacy), "2025-11-25");
        assert_eq!(request_protocol_version("{}"), "2025-11-25");
        assert_eq!(request_protocol_version("not json"), "2025-11-25");
    }

    #[test]
    fn request_protocol_version_rejects_header_injection_and_bad_revisions() {
        let injected = r#"{"params":{"protocolVersion":"2025-11-25\r\nX-Evil: true"}}"#;
        let result = request_protocol_version(injected);
        assert_eq!(result, "2025-11-25");
        assert!(!result.contains(['\r', '\n', ':']));

        let bad = r#"{"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"latest"},"protocolVersion":"also-not-a-date"}}"#;
        assert_eq!(request_protocol_version(bad), "2025-11-25");
    }

    #[test]
    fn mcp_delivery_regression_wait_response_timeout_tracks_requested_server_deadline() {
        let ordinary =
            r#"{"method":"tools/call","params":{"name":"session","arguments":{"action":"list"}}}"#;
        let direct_wait =
            r#"{"method":"tools/call","params":{"name":"agent","arguments":{"action":"wait"}}}"#;
        let collapsed_wait = r#"{"method":"tools/call","params":{"name":"call_tool","arguments":{"tool_name":"session","arguments":{"action":"wait","timeout_ms":120000}}}}"#;
        let capped_wait = r#"{"method":"tools/call","params":{"name":"agent","arguments":{"action":"wait","timeout_ms":999999}}}"#;
        let short_wait = r#"{"method":"tools/call","params":{"name":"session","arguments":{"action":"wait","timeout_ms":1}}}"#;
        assert_eq!(response_timeout(ordinary).as_secs(), 10);
        assert_eq!(response_timeout(direct_wait).as_secs(), 65);
        assert_eq!(response_timeout(collapsed_wait).as_secs(), 125);
        assert_eq!(response_timeout(capped_wait).as_secs(), 305);
        assert_eq!(response_timeout(short_wait).as_millis(), 5_001);
    }

    #[tokio::test]
    async fn successful_action_ack_finishes_without_waiting_for_eof() {
        let (mut client, mut server) = tokio::io::duplex(1024);
        let response_body = r#"{"jsonrpc":"2.0","id":7,"result":{"ok":true}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nmcp-session-id: sid\r\n\r\n{response_body}",
            response_body.len()
        );
        let writer = tokio::spawn(async move {
            server.write_all(response.as_bytes()).await.unwrap();
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        });

        let (headers, body) = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            read_http_response(&mut client),
        )
        .await
        .expect("reader must not wait for the still-open server side")
        .unwrap();
        assert!(headers.contains("mcp-session-id: sid"));
        assert_eq!(body, response_body);
        writer.abort();
    }
}
