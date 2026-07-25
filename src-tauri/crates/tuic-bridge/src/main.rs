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
const MCP_WAIT_DEFAULT_MS: u64 = 60_000;
const MCP_WAIT_MAX_MS: u64 = 300_000;
/// Bounded transport overhead beyond the server-side wait. This covers HTTP
/// framing and scheduler latency without turning unrelated calls into long
/// hangs; the requested wait itself remains authoritative.
const MCP_WAIT_RESPONSE_MARGIN_MS: u64 = 5_000;

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
                if name_str.starts_with("mcp-") && name_str.ends_with(".sock") {
                    if let Ok(Ok(stream)) = tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        tokio::net::UnixStream::connect(&entry.path()),
                    )
                    .await
                    {
                        return Ok(IpcStream::Unix(stream));
                    }
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

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

/// Write a JSON line to stdout (MCP stdio transport delimiter is \n).
/// Exits the process if stdout is closed — the MCP client is gone, nothing left to do.
fn emit(json: &Value) {
    let mut stdout = io::stdout().lock();
    if writeln!(
        stdout,
        "{}",
        serde_json::to_string(json).unwrap_or_default()
    )
    .is_err()
    {
        std::process::exit(0);
    }
    let _ = stdout.flush();
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
        "POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
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
        "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "tuic-bridge", "version": env!("CARGO_PKG_VERSION") } }
    });
    let (body, sid) = post_mcp(&serde_json::to_string(&init_body).unwrap(), None).await?;
    let sid = sid.ok_or_else(|| "server did not return mcp-session-id".to_string())?;
    Ok((sid, body))
}

// ---------------------------------------------------------------------------
// SSE listener
// ---------------------------------------------------------------------------

struct BridgeState {
    session_id: Mutex<Option<String>>,
    connected: AtomicBool,
    /// Handle to the SSE listener task — aborted and restarted on reconnect.
    sse_handle: Mutex<Option<tokio::task::JoinHandle<()>>>,
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
// Main
// ---------------------------------------------------------------------------

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    eprintln!(
        "tuic-bridge v{} starting ({})",
        env!("CARGO_PKG_VERSION"),
        ipc_endpoint()
    );

    let state = Arc::new(BridgeState {
        session_id: Mutex::new(None),
        connected: AtomicBool::new(false),
        sse_handle: Mutex::new(None),
    });

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
            } else {
                if let Ok((sid, _)) = server_initialize().await {
                    eprintln!("tuic-bridge: reconnected to TUIC");
                    *bg_state.session_id.lock().unwrap() = Some(sid);
                    bg_state.connected.store(true, Ordering::Release);
                    start_sse_listener(&bg_state);
                    emit_tools_changed();
                    consecutive_failures = 0;
                }
            }
        }
    });

    // Stdin reader in blocking thread → channel → async handler
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
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

    while let Some(line) = rx.recv().await {
        let request: Value = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("tuic-bridge: invalid JSON: {e}");
                continue;
            }
        };

        let method = request["method"].as_str().unwrap_or("");
        let id = request.get("id").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => {
                // Proxy to server when connected to get dynamic instructions.
                // The server response includes intent protocol, active sessions, etc.
                // Fall back to a minimal local response only when offline.
                let proxied = if state.connected.load(Ordering::Acquire) || {
                    // Try lazy connect if not yet connected
                    if let Ok((sid, _)) = server_initialize().await {
                        eprintln!("tuic-bridge: connected to TUIC");
                        *state.session_id.lock().unwrap() = Some(sid);
                        state.connected.store(true, Ordering::Release);
                        start_sse_listener(&state);
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
                                resp["result"]["capabilities"]["tools"]["listChanged"] =
                                    Value::Bool(true);
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

                emit(&proxied.unwrap_or_else(|| serde_json::json!({
                    "jsonrpc": "2.0", "id": id,
                    "result": {
                        "protocolVersion": "2025-03-26",
                        "capabilities": { "tools": { "listChanged": true } },
                        "serverInfo": { "name": "tuicommander", "version": env!("CARGO_PKG_VERSION") }
                    }
                })));
            }
            "notifications/initialized" => {} // Acknowledgment, no response

            // Proxy to server
            _ => {
                // Lazy reconnect attempt if disconnected
                if !state.connected.load(Ordering::Acquire)
                    && let Ok((sid, _)) = server_initialize().await
                {
                    eprintln!("tuic-bridge: reconnected to TUIC");
                    *state.session_id.lock().unwrap() = Some(sid);
                    state.connected.store(true, Ordering::Release);
                    start_sse_listener(&state);
                    emit_tools_changed();
                }

                if state.connected.load(Ordering::Acquire) {
                    let sid = state.session_id.lock().unwrap().clone();
                    match post_mcp(&line, sid.as_deref()).await {
                        Ok((body, new_sid)) => {
                            // Update session ID if server returned a new one
                            if let Some(s) = new_sid {
                                *state.session_id.lock().unwrap() = Some(s);
                            }
                            // Forward raw JSON response to stdout
                            let mut stdout = io::stdout().lock();
                            let _ = writeln!(stdout, "{body}");
                            let _ = stdout.flush();
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
                } else {
                    emit_offline_response(method, &id);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_http_response, response_timeout, tuic_session_header_line};
    use tokio::io::AsyncWriteExt;

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
