//! HTTP fetch API for plugins.
//!
//! Plugins declaring the `net:http` capability can make outbound HTTP requests
//! to URLs matching their declared `allowedUrls` patterns. Provides SSRF
//! protection by blocking unsafe schemes and validating URLs against patterns.

use std::collections::HashMap;

/// Maximum response body size (10 MB).
const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

/// Default request timeout in seconds.
const DEFAULT_TIMEOUT_SECS: u64 = 30;

/// Maximum redirect hops to follow. `redirect::Policy::custom` (below) does
/// not enforce a limit on its own, unlike `Policy::limited` which this
/// replaces — so the cap is re-implemented here.
const MAX_REDIRECTS: usize = 5;

/// Error carrying the specific reason a redirect hop failed SSRF validation.
/// Wrapped as a `source()` on the resulting `reqwest::Error` so the reason
/// isn't swallowed by reqwest's generic "error following redirect" `Display`
/// (see `describe_error`).
#[derive(Debug)]
struct RedirectRejected(String);

impl std::fmt::Display for RedirectRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RedirectRejected {}

/// Render an error together with its `source()` chain. Used for request
/// errors so a blocked redirect's specific reason (e.g. "Private network URLs
/// require explicit allowedUrls declaration") is visible instead of just
/// reqwest's generic "error following redirect".
fn describe_error(e: &(dyn std::error::Error + 'static)) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        msg.push_str(": ");
        msg.push_str(&s.to_string());
        source = s.source();
    }
    msg
}

/// Build an HTTP client whose redirect policy re-validates every hop with the
/// same SSRF guard (`validate_url`) applied to the initial request — closing
/// the gap where a 30x response could ferry a request to localhost/RFC1918
/// targets the caller never declared (SEC-2). Built per-request rather than
/// shared/pooled: the policy must close over this specific plugin's
/// `allowed_urls`, and reqwest's redirect policy is set at the client level
/// with no per-request override.
///
/// DEFERRED (2026-07-09) — DNS-rebinding: `validate_url`'s private-IP check
/// only triggers when a host parses as a literal `IpAddr`, so a hostname that
/// *resolves* to a private/localhost address (at the initial connect or at a
/// redirect hop) is not caught. Closing that needs a custom `dns_resolver`
/// that checks resolved addresses before connecting — deferred as a larger
/// refactor; this fix covers the literal-IP case for every hop.
fn client_for(allowed_urls: Vec<String>) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() > MAX_REDIRECTS {
                return attempt.error(RedirectRejected("too many redirects".into()));
            }
            match validate_url(attempt.url().as_str(), &allowed_urls) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(RedirectRejected(e)),
            }
        }))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))
}

/// Response returned to the plugin.
#[derive(Debug, Clone, serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/// Validate that a URL is safe to fetch.
/// - Must be http:// or https://
/// - Must match at least one allowed URL pattern (if any are specified)
/// - If `allowed_urls` is empty, allow any http/https URL (built-in plugins)
fn validate_url(url: &str, allowed_urls: &[String]) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("Invalid URL: {e}"))?;

    // Block unsafe schemes
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => {
            return Err(format!(
                "Scheme \"{scheme}\" is not allowed; use http or https"
            ));
        }
    }

    // Block localhost and private/RFC1918 IPs unless explicitly allowed.
    // This prevents plugins from reaching LAN hosts via SSRF.
    if let Some(host) = parsed.host_str() {
        let is_localhost = host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host == "[::1]"
            || host == "0.0.0.0";

        // Check if host is a private IP (RFC1918, CGNAT/Tailscale, IPv6 ULA/link-local).
        // DEFERRED (2026-07-09) — only catches a literal IP host; a hostname
        // that *resolves* to a private IP (DNS rebinding) is not caught here.
        // See `client_for`'s doc comment for the full note.
        let is_private = host
            .parse::<std::net::IpAddr>()
            .map(|ip| crate::mcp_http::auth::is_private_ip(&ip))
            .unwrap_or(false);

        if (is_localhost || is_private) && !allowed_urls.is_empty() {
            // Only allow if the host is explicitly declared in allowedUrls
            let host_allowed = allowed_urls.iter().any(|pattern| pattern.contains(host));
            if !host_allowed {
                let kind = if is_localhost {
                    "Localhost"
                } else {
                    "Private network"
                };
                return Err(format!(
                    "{kind} URLs require explicit allowedUrls declaration"
                ));
            }
        }
    }

    // If no allowed URLs specified (built-in plugin), allow anything http/https
    if allowed_urls.is_empty() {
        return Ok(());
    }

    // Match against allowed URL patterns
    // Patterns use simple prefix matching with optional trailing `*`
    for pattern in allowed_urls {
        if url_matches_pattern(url, pattern) {
            return Ok(());
        }
    }

    Err(format!(
        "URL \"{url}\" does not match any allowed URL pattern"
    ))
}

/// Check if a URL matches a pattern.
/// Pattern format: a URL prefix, optionally ending with `*` for wildcard suffix.
/// Examples:
///   "https://api.anthropic.com/*" matches "https://api.anthropic.com/api/oauth/usage"
///   "https://example.com/api/v1" matches exactly "https://example.com/api/v1"
fn url_matches_pattern(url: &str, pattern: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        url.starts_with(prefix)
    } else {
        url == pattern
    }
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

/// Make an HTTP request on behalf of a plugin.
///
/// Parameters:
/// - `url` — The URL to fetch
/// - `method` — HTTP method (GET, POST, PUT, DELETE, etc.)
/// - `headers` — Request headers
/// - `body` — Optional request body
/// - `plugin_id` — The requesting plugin's ID (also the manifest lookup key)
#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_http_fetch(
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    plugin_id: String,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<HttpResponse, String> {
    plugin_http_fetch_impl(&state, url, method, headers, body, plugin_id).await
}

pub(crate) async fn plugin_http_fetch_impl(
    state: &std::sync::Arc<crate::AppState>,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    plugin_id: String,
) -> Result<HttpResponse, String> {
    crate::plugins::check_plugin_capability(state, &plugin_id, "net:http")?;

    // Read allowed URLs from the on-disk manifest (source of truth), NOT from a
    // caller-supplied parameter — otherwise a scoped plugin could widen its own
    // allowlist and bypass the SSRF guard.
    let manifest = crate::plugins::read_single_manifest(&plugin_id)?;
    validate_url(&url, &manifest.allowed_urls)?;

    let method_str = method.as_deref().unwrap_or("GET");
    let http_method: reqwest::Method = method_str
        .parse()
        .map_err(|_| format!("Invalid HTTP method: {method_str}"))?;

    let client = client_for(manifest.allowed_urls.clone())?;
    let mut request = client.request(http_method, &url);

    if let Some(ref hdrs) = headers {
        for (key, value) in hdrs {
            request = request.header(key.as_str(), value.as_str());
        }
    }

    if let Some(ref b) = body {
        request = request.body(b.clone());
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("HTTP request failed: {}", describe_error(&e)))?;

    let status = response.status().as_u16();

    // Reject early if Content-Length advertises an oversized body
    if let Some(cl) = response.content_length()
        && cl as usize > MAX_RESPONSE_BYTES
    {
        return Err(format!(
            "Response body exceeds maximum size ({cl} bytes > {MAX_RESPONSE_BYTES} bytes)"
        ));
    }

    let resp_headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    // Stream the body with a running-total cap. Content-Length is optional for
    // chunked/streamed responses, so we must enforce the cap while collecting —
    // buffering the full body first would let a header-less huge response OOM
    // the host. Abort the moment the accumulated size exceeds MAX_RESPONSE_BYTES.
    use futures_util::StreamExt;
    let mut stream = response.bytes_stream();
    let mut body_bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read response body: {e}"))?;
        if body_bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!(
                "Response body exceeds maximum size (> {MAX_RESPONSE_BYTES} bytes)"
            ));
        }
        body_bytes.extend_from_slice(&chunk);
    }

    let body_str = String::from_utf8_lossy(&body_bytes).to_string();

    Ok(HttpResponse {
        status,
        headers: resp_headers,
        body: body_str,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- URL validation --

    #[test]
    fn validate_allows_https() {
        let result = validate_url("https://api.example.com/data", &[]);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_allows_http() {
        let result = validate_url("http://api.example.com/data", &[]);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_blocks_file_scheme() {
        let result = validate_url("file:///etc/passwd", &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not allowed"));
    }

    #[test]
    fn validate_blocks_data_scheme() {
        let result = validate_url("data:text/plain,hello", &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not allowed"));
    }

    #[test]
    fn validate_blocks_ftp_scheme() {
        let result = validate_url("ftp://example.com/file", &[]);
        assert!(result.is_err());
    }

    #[test]
    fn validate_rejects_invalid_url() {
        let result = validate_url("not a url", &[]);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Invalid URL"));
    }

    // -- URL pattern matching --

    #[test]
    fn pattern_wildcard_suffix() {
        assert!(url_matches_pattern(
            "https://api.anthropic.com/api/oauth/usage",
            "https://api.anthropic.com/*"
        ));
    }

    #[test]
    fn pattern_wildcard_no_match() {
        assert!(!url_matches_pattern(
            "https://evil.com/api",
            "https://api.anthropic.com/*"
        ));
    }

    #[test]
    fn pattern_exact_match() {
        assert!(url_matches_pattern(
            "https://example.com/api/v1",
            "https://example.com/api/v1"
        ));
    }

    #[test]
    fn pattern_exact_no_match() {
        assert!(!url_matches_pattern(
            "https://example.com/api/v2",
            "https://example.com/api/v1"
        ));
    }

    // -- Allowed URLs enforcement --

    #[test]
    fn validate_allows_matching_pattern() {
        let allowed = vec!["https://api.anthropic.com/*".to_string()];
        let result = validate_url("https://api.anthropic.com/api/oauth/usage", &allowed);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_rejects_non_matching_pattern() {
        let allowed = vec!["https://api.anthropic.com/*".to_string()];
        let result = validate_url("https://evil.com/steal-tokens", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not match"));
    }

    #[test]
    fn validate_allows_any_of_multiple_patterns() {
        let allowed = vec![
            "https://api.anthropic.com/*".to_string(),
            "https://api.github.com/*".to_string(),
        ];
        assert!(validate_url("https://api.github.com/repos", &allowed).is_ok());
        assert!(validate_url("https://api.anthropic.com/usage", &allowed).is_ok());
        assert!(validate_url("https://evil.com/x", &allowed).is_err());
    }

    // -- Localhost blocking --

    #[test]
    fn validate_blocks_localhost_without_declaration() {
        let allowed = vec!["https://api.example.com/*".to_string()];
        let result = validate_url("http://localhost:8080/api", &allowed);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Localhost"));
    }

    #[test]
    fn validate_blocks_127_without_declaration() {
        let allowed = vec!["https://api.example.com/*".to_string()];
        let result = validate_url("http://127.0.0.1:8080/api", &allowed);
        assert!(result.is_err());
    }

    #[test]
    fn validate_allows_localhost_with_declaration() {
        let allowed = vec!["http://localhost:8080/*".to_string()];
        let result = validate_url("http://localhost:8080/api", &allowed);
        assert!(result.is_ok());
    }

    #[test]
    fn validate_allows_localhost_for_builtin() {
        // Empty allowed_urls = built-in plugin, no restrictions
        let result = validate_url("http://localhost:8080/api", &[]);
        assert!(result.is_ok());
    }

    // -- Private IP (RFC1918) blocking --

    #[test]
    fn validate_blocks_rfc1918_10_network() {
        let allowed = vec!["http://*".to_string()];
        assert!(validate_url("http://10.0.0.1:8080/api", &allowed).is_err());
        assert!(validate_url("http://10.255.255.255/", &allowed).is_err());
    }

    #[test]
    fn validate_blocks_rfc1918_172_network() {
        let allowed = vec!["http://*".to_string()];
        assert!(validate_url("http://172.16.0.1/api", &allowed).is_err());
        assert!(validate_url("http://172.31.255.255/api", &allowed).is_err());
    }

    #[test]
    fn validate_blocks_rfc1918_192_168() {
        let allowed = vec!["http://*".to_string()];
        assert!(validate_url("http://192.168.1.1/api", &allowed).is_err());
        assert!(validate_url("http://192.168.68.100:3000/", &allowed).is_err());
    }

    #[test]
    fn validate_blocks_cgnat_tailscale() {
        let allowed = vec!["http://*".to_string()];
        assert!(validate_url("http://100.64.0.1/api", &allowed).is_err());
    }

    #[test]
    fn validate_allows_private_ip_with_explicit_declaration() {
        let allowed = vec!["http://192.168.1.100:8080/*".to_string()];
        assert!(validate_url("http://192.168.1.100:8080/api", &allowed).is_ok());
    }

    #[test]
    fn validate_allows_private_ip_for_builtin() {
        // Empty allowed_urls = built-in plugin, no restrictions
        assert!(validate_url("http://10.0.0.1/api", &[]).is_ok());
    }

    // -- Manifest is the source of truth (SSRF / scope-bypass fix) --

    /// A plugin whose manifest allows only host A must not be able to fetch
    /// host B — the allowlist is re-read from the on-disk manifest, so a caller
    /// can no longer widen it (the request parameter is gone entirely).
    #[tokio::test]
    async fn fetch_uses_manifest_allowlist_not_caller_supplied() {
        use std::sync::Arc;

        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        let plugin_id = "scoped-plugin";
        let plugin_dir = dir.path().join("plugins").join(plugin_id);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "scoped-plugin",
                "name": "Scoped Plugin",
                "version": "1.0.0",
                "minAppVersion": "0.0.0",
                "main": "main.js",
                "capabilities": ["net:http"],
                "allowedUrls": ["https://host-a.example.com/*"]
            }"#,
        )
        .unwrap();

        // The manifest — not any caller-supplied list — is the allowlist source.
        let manifest = crate::plugins::read_single_manifest(plugin_id).unwrap();
        assert_eq!(manifest.allowed_urls, vec!["https://host-a.example.com/*"]);

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        state
            .loaded_plugins
            .insert(plugin_id.to_string(), vec!["net:http".to_string()]);

        // Host B is not in the manifest — rejected before any network call.
        let err = plugin_http_fetch_impl(
            &state,
            "https://host-b.example.com/steal".to_string(),
            None,
            None,
            None,
            plugin_id.to_string(),
        )
        .await
        .unwrap_err();
        assert!(err.contains("does not match"), "unexpected error: {err}");

        // Cloud metadata / SSRF target is likewise rejected.
        let ssrf = plugin_http_fetch_impl(
            &state,
            "http://169.254.169.254/latest/meta-data/".to_string(),
            None,
            None,
            None,
            plugin_id.to_string(),
        )
        .await
        .unwrap_err();
        assert!(ssrf.contains("does not match"), "unexpected error: {ssrf}");
    }

    // -- Redirect re-validation (SEC-2: SSRF via redirect) --

    /// A plugin whose manifest explicitly declares its own localhost test
    /// server must still be blocked from following a redirect the server
    /// issues to an RFC1918 address the plugin never declared. Before the
    /// fix, `Policy::limited(5)` followed any redirect target unchecked.
    #[tokio::test]
    async fn fetch_blocks_redirect_to_undeclared_private_ip() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Server answers the initial (allowed) request with a redirect to a
        // private IP that is not covered by the plugin's allowedUrls pattern.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(
                    b"HTTP/1.1 302 Found\r\nLocation: http://192.168.1.1/steal\r\nContent-Length: 0\r\n\r\n",
                )
                .await;
        });

        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        let plugin_id = "redirect-plugin";
        let plugin_dir = dir.path().join("plugins").join(plugin_id);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            format!(
                r#"{{
                    "id": "redirect-plugin",
                    "name": "Redirect Plugin",
                    "version": "1.0.0",
                    "minAppVersion": "0.0.0",
                    "main": "main.js",
                    "capabilities": ["net:http"],
                    "allowedUrls": ["http://127.0.0.1:{port}/*"]
                }}"#
            ),
        )
        .unwrap();

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        state
            .loaded_plugins
            .insert(plugin_id.to_string(), vec!["net:http".to_string()]);

        let err = plugin_http_fetch_impl(
            &state,
            format!("http://127.0.0.1:{port}/start"),
            None,
            None,
            None,
            plugin_id.to_string(),
        )
        .await
        .unwrap_err();

        assert!(
            err.contains("Private network"),
            "redirect to an undeclared private IP must be blocked: {err}"
        );
    }

    // -- Streamed body size cap (Content-Length absent) --

    /// A response with no Content-Length that streams a body larger than
    /// MAX_RESPONSE_BYTES must be aborted mid-stream, not fully buffered.
    /// The server here uses chunked transfer-encoding (no Content-Length), so
    /// the early content_length() check can't catch it — only the running-total
    /// cap during collection can.
    #[tokio::test]
    async fn fetch_aborts_when_streamed_body_exceeds_cap_without_content_length() {
        use std::sync::Arc;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // Raw HTTP/1.1 chunked server: emits chunks totaling more than
        // MAX_RESPONSE_BYTES with NO Content-Length header.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            // Drain the request headers (read until we've seen the blank line).
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
                .await;
            // 64 KiB chunk, repeated past the cap. Stop once the client aborts
            // (write fails with broken pipe) or we've clearly exceeded the cap.
            let payload = vec![b'x'; 64 * 1024];
            let hdr = format!("{:x}\r\n", payload.len());
            let mut sent = 0usize;
            while sent <= MAX_RESPONSE_BYTES + 128 * 1024 {
                if sock.write_all(hdr.as_bytes()).await.is_err() {
                    break;
                }
                if sock.write_all(&payload).await.is_err() {
                    break;
                }
                if sock.write_all(b"\r\n").await.is_err() {
                    break;
                }
                sent += payload.len();
            }
        });

        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        let plugin_id = "streamer-plugin";
        let plugin_dir = dir.path().join("plugins").join(plugin_id);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("manifest.json"),
            r#"{
                "id": "streamer-plugin",
                "name": "Streamer Plugin",
                "version": "1.0.0",
                "minAppVersion": "0.0.0",
                "main": "main.js",
                "capabilities": ["net:http"],
                "allowedUrls": []
            }"#,
        )
        .unwrap();

        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        state
            .loaded_plugins
            .insert(plugin_id.to_string(), vec!["net:http".to_string()]);

        let err = plugin_http_fetch_impl(
            &state,
            format!("http://127.0.0.1:{port}/big"),
            None,
            None,
            None,
            plugin_id.to_string(),
        )
        .await
        .unwrap_err();
        assert!(
            err.contains("exceeds maximum size"),
            "expected size-cap error, got: {err}"
        );
    }
}
