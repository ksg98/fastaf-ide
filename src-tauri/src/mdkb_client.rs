use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MdkbPing {
    pub pong: bool,
    pub version: Option<String>,
}

/// A symbol as mdkb reports it. `line_start`/`line_end` are **0-based** — see
/// `mdkb_commands::editor_line` for the conversion to editor lines.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MdkbSymbol {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line_start: u32,
    pub line_end: Option<u32>,
    pub signature: Option<String>,
    pub scope_context: Option<String>,
}

/// `code_find`'s envelope. `total` is the unclamped match count, so a capped
/// `symbols` cannot be mistaken for the whole set.
///
/// `cfg(unix)` because only the socket client decodes it; the Windows stub
/// answers without ever talking to a daemon.
#[cfg(unix)]
#[derive(Debug, Deserialize)]
struct CodeFindResponse {
    symbols: Vec<MdkbSymbol>,
}

// Unix sockets are not available on Windows
//
// Every method stays `async` with nothing to await: this stub must present the
// exact signature the socket client does, or every call site would need a cfg.
#[cfg(not(unix))]
#[allow(dead_code, clippy::unused_async_trait_impl)]
mod platform {
    use super::*;

    #[derive(Debug)]
    pub struct MdkbClient;

    impl MdkbClient {
        pub fn socket_path() -> PathBuf {
            PathBuf::new()
        }

        pub async fn connect() -> Result<Self> {
            bail!("mdkb: Unix socket client not available on this platform")
        }

        pub async fn call(&mut self, _method: &str, _params: Value) -> Result<Value> {
            bail!("mdkb: not available on this platform")
        }

        pub async fn ping_info(&mut self) -> Result<MdkbPing> {
            Ok(MdkbPing {
                pong: false,
                version: None,
            })
        }

        pub async fn symbols_in_file(
            &mut self,
            _root: &str,
            _file: &str,
        ) -> Result<Vec<MdkbSymbol>> {
            Ok(vec![])
        }

        pub async fn symbol_at_position(
            &mut self,
            _root: &str,
            _file: &str,
            _line: u32,
            _col: Option<u32>,
        ) -> Result<Option<MdkbSymbol>> {
            Ok(None)
        }

        pub async fn code_graph(
            &mut self,
            _root: &str,
            _name: &str,
            _direction: &str,
        ) -> Result<Vec<MdkbSymbol>> {
            bail!("mdkb: not available on this platform")
        }

        pub async fn code_find(
            &mut self,
            _root: &str,
            _name: &str,
            _kind: Option<&str>,
        ) -> Result<Vec<MdkbSymbol>> {
            Ok(vec![])
        }
    }
}

#[cfg(unix)]
mod platform {
    use super::*;
    use anyhow::Context;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    static REQUEST_ID: AtomicU64 = AtomicU64::new(1);

    const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

    fn unwrap_text_field(resp: &Value) -> Result<String> {
        match resp.get("text").and_then(Value::as_str) {
            Some(t) => Ok(t.to_string()),
            None => serde_json::to_string(resp).context("mdkb: serialize fallback response"),
        }
    }

    /// Pull the resolved symbols out of a `code_graph` envelope.
    ///
    /// A missing `symbols` is an error, not an empty result: mdkb sends `[]`
    /// when a symbol genuinely has no callers, so "absent" can only mean a
    /// daemon too old to carry the field, and reporting that as "no callers"
    /// would be a silent lie.
    pub(super) fn parse_code_graph_symbols(resp: &Value) -> Result<Vec<MdkbSymbol>> {
        let symbols = resp
            .get("symbols")
            .ok_or_else(|| anyhow::anyhow!("mdkb: code_graph response has no 'symbols'"))?;
        serde_json::from_value(symbols.clone()).context("mdkb: parse code_graph symbols")
    }

    #[derive(Debug)]
    pub struct MdkbClient {
        #[cfg(not(test))]
        stream: UnixStream,
        #[cfg(test)]
        pub(super) stream: UnixStream,
    }

    #[derive(Debug, Deserialize)]
    struct RpcResponse {
        #[allow(dead_code)]
        id: Value,
        result: Option<Value>,
        error: Option<RpcError>,
    }

    #[derive(Debug, Deserialize)]
    struct RpcError {
        code: i32,
        message: String,
    }

    impl MdkbClient {
        pub fn socket_path() -> PathBuf {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join(".mdkb/daemon-hook.sock")
        }

        pub async fn connect() -> Result<Self> {
            let path = Self::socket_path();
            let stream = UnixStream::connect(&path)
                .await
                .with_context(|| format!("mdkb: connect to {}", path.display()))?;
            Ok(Self { stream })
        }

        pub async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
            let id = REQUEST_ID.fetch_add(1, Ordering::Relaxed);
            let req = json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            });
            let body = serde_json::to_vec(&req)?;
            let len = u32::try_from(body.len()).context("request too large")?;

            self.stream.write_all(&len.to_le_bytes()).await?;
            self.stream.write_all(&body).await?;
            self.stream.flush().await?;

            let mut hdr = [0u8; 4];
            self.stream
                .read_exact(&mut hdr)
                .await
                .context("mdkb: read response header")?;
            let resp_len = u32::from_le_bytes(hdr) as usize;
            if resp_len == 0 || resp_len > MAX_RESPONSE_BYTES {
                bail!("mdkb: invalid response length {resp_len}");
            }

            let mut resp_buf = vec![0u8; resp_len];
            self.stream
                .read_exact(&mut resp_buf)
                .await
                .context("mdkb: read response body")?;

            let resp: RpcResponse =
                serde_json::from_slice(&resp_buf).context("mdkb: parse response")?;

            if let Some(err) = resp.error {
                bail!("mdkb RPC error {}: {}", err.code, err.message);
            }

            resp.result
                .ok_or_else(|| anyhow::anyhow!("mdkb: response missing both result and error"))
        }

        pub async fn ping_info(&mut self) -> Result<MdkbPing> {
            let resp = self.call("ping", json!({})).await?;
            Ok(MdkbPing {
                pong: resp.get("pong").and_then(Value::as_bool).unwrap_or(false),
                version: resp
                    .get("version")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
        }

        pub async fn symbols_in_file(&mut self, root: &str, file: &str) -> Result<Vec<MdkbSymbol>> {
            let resp = self
                .call(
                    "symbols_in_file",
                    json!({
                        "root": root,
                        "file": file,
                    }),
                )
                .await?;
            let text = unwrap_text_field(&resp)?;
            let symbols: Vec<MdkbSymbol> =
                serde_json::from_str(&text).context("mdkb: parse symbols_in_file response")?;
            Ok(symbols)
        }

        pub async fn symbol_at_position(
            &mut self,
            root: &str,
            file: &str,
            line: u32,
            col: Option<u32>,
        ) -> Result<Option<MdkbSymbol>> {
            let resp = self
                .call(
                    "symbol_at_position",
                    json!({
                        "root": root,
                        "file": file,
                        "line": line,
                        "col": col,
                    }),
                )
                .await?;
            let text = unwrap_text_field(&resp)?;
            if text == "null" || text.is_empty() {
                return Ok(None);
            }
            let sym: MdkbSymbol =
                serde_json::from_str(&text).context("mdkb: parse symbol_at_position response")?;
            Ok(Some(sym))
        }

        pub async fn code_graph(
            &mut self,
            root: &str,
            name: &str,
            direction: &str,
        ) -> Result<Vec<MdkbSymbol>> {
            let resp = self
                .call(
                    "code_graph",
                    json!({
                        "root": root,
                        "name": name,
                        "direction": direction,
                    }),
                )
                .await?;
            // `text` is prose written for agents — never parse it. The resolved
            // symbols ride alongside it in `symbols`.
            parse_code_graph_symbols(&resp)
        }

        pub async fn code_find(
            &mut self,
            root: &str,
            name: &str,
            kind: Option<&str>,
        ) -> Result<Vec<MdkbSymbol>> {
            let mut params = json!({ "root": root, "name": name });
            if let Some(k) = kind {
                params["kind"] = json!(k);
            }
            let resp = self.call("code_find", params).await?;
            let text = unwrap_text_field(&resp)?;
            // `code_find` is the one code method that does not return a bare
            // array: the row cap means `total` has to travel with the rows.
            let found: CodeFindResponse =
                serde_json::from_str(&text).context("mdkb: parse code_find response")?;
            Ok(found.symbols)
        }
    }
}

pub use platform::MdkbClient;

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{UnixListener, UnixStream};

    async fn spawn_mock_server() -> (PathBuf, tokio::task::JoinHandle<()>) {
        let dir = tempfile::tempdir().unwrap();
        let sock_path = dir.path().join("test.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();
        let path = sock_path.clone();

        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            loop {
                let mut hdr = [0u8; 4];
                if stream.read_exact(&mut hdr).await.is_err() {
                    break;
                }
                let len = u32::from_le_bytes(hdr) as usize;
                let mut body = vec![0u8; len];
                if stream.read_exact(&mut body).await.is_err() {
                    break;
                }

                let req: Value = serde_json::from_slice(&body).unwrap();
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");

                // Every arm mirrors the real 3.7.x wire shape, verbatim — the
                // shapes differ per method (bare array / envelope / prose +
                // symbols) and that difference is exactly what silently broke
                // before. An unknown method is an ERROR, never a null result:
                // a permissive fallback lets a new call "pass" against a shape
                // the daemon never sends.
                let response = match method {
                    "ping" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": {"pong": true, "version": "9.8.7"}
                    }),
                    "symbols_in_file" => {
                        // Bare array. Lines are 0-based, as mdkb stores them.
                        let symbols = json!([
                            {"name": "foo", "kind": "Function", "file_path": "src/main.rs", "line_start": 0, "line_end": 9, "col_start": 0, "col_end": 1, "signature": "fn foo()", "scope_context": "Module"},
                            {"name": "bar", "kind": "Method", "file_path": "src/main.rs", "line_start": 11, "line_end": 19, "col_start": 4, "col_end": 5, "signature": "fn bar(x: i32)", "scope_context": "ClassMember { class_name: None }"}
                        ]);
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"text": symbols.to_string(), "tokens": 0}
                        })
                    }
                    "symbol_at_position" => {
                        // Single object, and NO `scope_context` — this method
                        // sends `module_path` instead.
                        let sym = json!({
                            "name": "foo", "kind": "Function", "file_path": "src/main.rs",
                            "line_start": 41, "line_end": 47, "col_start": 0, "col_end": 1,
                            "signature": "fn foo()", "module_path": null
                        });
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"text": sym.to_string(), "tokens": 0}
                        })
                    }
                    "code_find" => {
                        // Envelope, not a bare array: `total` travels with the
                        // rows so a capped list cannot read as the whole set.
                        let found = json!({
                            "total": 7,
                            "showing": 1,
                            "symbols": [
                                {"name": "foo", "kind": "Function", "file_path": "src/main.rs", "line_start": 4, "line_end": 8, "col_start": 0, "col_end": 1, "signature": "fn foo()", "scope_context": "Module"}
                            ]
                        });
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {"text": found.to_string(), "tokens": 0}
                        })
                    }
                    "code_graph" => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        // `text` is prose for agents; `symbols` is the
                        // machine-readable half, in the envelope rather than
                        // stringified inside `text`.
                        "result": {
                            "text": "foo (Function) is called by 1 function(s):\n\n  sym#42 Method caller in src/lib.rs:6\n",
                            "tokens": 0,
                            "symbols": [
                                {"name": "caller", "kind": "Method", "file_path": "src/lib.rs", "line_start": 6, "line_end": 12, "col_start": 4, "col_end": 5, "signature": "fn caller()", "scope_context": "Module"}
                            ]
                        }
                    }),
                    other => json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": {"code": -32601, "message": format!("unknown tool: {other}")}
                    }),
                };

                let resp_bytes = serde_json::to_vec(&response).unwrap();
                let resp_len = resp_bytes.len() as u32;
                stream.write_all(&resp_len.to_le_bytes()).await.unwrap();
                stream.write_all(&resp_bytes).await.unwrap();
            }
            // Keep dir alive
            drop(dir);
        });

        // Wait for socket to be ready
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        (path, handle)
    }

    async fn connect_to_mock(path: &Path) -> platform::MdkbClient {
        let stream = UnixStream::connect(path).await.unwrap();
        platform::MdkbClient { stream }
    }

    #[tokio::test]
    async fn test_ping_reports_daemon_version() {
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        assert_eq!(
            client.ping_info().await.unwrap(),
            MdkbPing {
                pong: true,
                version: Some("9.8.7".to_string()),
            }
        );
    }

    #[tokio::test]
    async fn test_symbols_in_file() {
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        let symbols = client
            .symbols_in_file("/repo", "src/main.rs")
            .await
            .unwrap();
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "foo");
        // Passed through raw — 0-based here, converted at the command boundary.
        assert_eq!(symbols[0].line_start, 0);
        assert_eq!(symbols[1].name, "bar");
        assert_eq!(
            symbols[1].scope_context.as_deref(),
            Some("ClassMember { class_name: None }")
        );
    }

    #[tokio::test]
    async fn symbol_at_position_parses_a_response_without_scope_context() {
        // `symbol_at_position` omits `scope_context` where the other methods
        // send it. A required field would make this method fail to parse.
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        let sym = client
            .symbol_at_position("/repo", "src/main.rs", 42, None)
            .await
            .unwrap()
            .expect("symbol present");
        assert_eq!(sym.name, "foo");
        assert_eq!(sym.line_start, 41);
        assert_eq!(sym.scope_context, None);
    }

    #[tokio::test]
    async fn code_find_reads_rows_out_of_the_total_envelope() {
        // Regression: mdkb 3.7.14 wrapped the rows in {total, showing, symbols}.
        // Deserializing the envelope as a bare Vec fails, and the command layer
        // swallows the error as "no results" — a silent, total blind spot.
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        let symbols = client.code_find("/repo", "foo", None).await.unwrap();
        assert_eq!(symbols.len(), 1, "envelope rows must be unwrapped");
        assert_eq!(symbols[0].name, "foo");
        assert_eq!(symbols[0].file_path, "src/main.rs");
    }

    #[tokio::test]
    async fn code_graph_reads_symbols_never_the_prose() {
        // `text` is prose for agents and has never been JSON. The symbols must
        // come from the `symbols` field of the envelope.
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        let symbols = client.code_graph("/repo", "foo", "callers").await.unwrap();
        assert_eq!(symbols.len(), 1);
        assert_eq!(symbols[0].name, "caller");
        assert_eq!(symbols[0].file_path, "src/lib.rs");
        assert_eq!(symbols[0].line_start, 6);
    }

    #[test]
    fn code_graph_errors_when_the_daemon_omits_symbols() {
        // An mdkb older than the one that added `symbols` answers with `text`
        // alone. That must surface as an error the command layer logs, not as a
        // silent empty list that reads like "this symbol has no callers".
        let err = platform::parse_code_graph_symbols(&json!({
            "text": "foo (Function) has no indexed callers.", "tokens": 0
        }))
        .unwrap_err();
        assert!(err.to_string().contains("no 'symbols'"), "err: {err}");
    }

    #[test]
    fn code_graph_accepts_an_empty_symbol_list() {
        // "No callers" is an empty array, not an absent field — the two must
        // stay distinguishable, or the version guard above is useless.
        let symbols = platform::parse_code_graph_symbols(&json!({
            "text": "foo (Function) has no indexed callers.", "tokens": 0, "symbols": []
        }))
        .unwrap();
        assert!(symbols.is_empty());
    }

    #[tokio::test]
    async fn test_rpc_error_propagation() {
        let (path, _server) = spawn_mock_server().await;
        let mut client = connect_to_mock(&path).await;
        let err = client
            .call("bad_method", json!({"root": "/repo"}))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("unknown tool: bad_method"));
    }

    #[tokio::test]
    async fn test_connection_refused() {
        let result = MdkbClient::connect().await;
        // Will fail unless mdkb daemon is actually running — that's expected in test env
        // The important thing is it doesn't panic
        if let Err(err) = result {
            assert!(err.to_string().contains("mdkb: connect"));
        }
    }
}
