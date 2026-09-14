//! Minimal MCP client for the peer registry.
//!
//! `fastaf agent send` must reach the SAME authoritative delivery path the MCP
//! `agent action=send` tool uses, so a message to a registered peer lands in
//! that peer's inbox instead of being typed into a PTY. That path resolves the
//! SENDER from the MCP protocol session, so this client performs the three
//! steps a normal MCP client does: `initialize`, then `agent action=register`
//! with our own `$TUIC_SESSION` to reclaim our peer identity, then the call.
//!
//! Deliberately NOT a second copy of the delivery logic: duplicating it would
//! give two implementations of exactly-once inbox routing that could drift.

use serde_json::{Value, json};

use crate::ipc;

/// Protocol revision this client speaks. Kept in step with the server's
/// advertised revision; the server negotiates down if it is older.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// The fastaf session UUID of the PTY this CLI runs inside, injected by TUIC.
/// Absent when `fastaf` is run from a plain terminal outside FastAF.
fn tuic_session() -> Option<String> {
    std::env::var("TUIC_SESSION").ok().filter(|s| !s.is_empty())
}

fn post(body: &Value, session: Option<&str>) -> Result<ipc::Response, String> {
    let mut extra: Vec<(&str, &str)> = vec![("Accept", "application/json, text/event-stream")];
    if let Some(sid) = session {
        extra.push(("Mcp-Session-Id", sid));
    }
    ipc::request_with_headers("POST", "/mcp", Some(&body.to_string()), &extra)
        .map_err(|e| e.to_string())
}

/// Unwrap a JSON-RPC envelope, then the MCP `content[0].text` payload the
/// tools return. Both layers can carry an error and both are reported verbatim:
/// a caller must never see a success for a message the registry refused.
fn unwrap_tool_result(resp: &ipc::Response) -> Result<Value, String> {
    if !resp.is_success() {
        return Err(format!("HTTP {}: {}", resp.status, resp.body));
    }
    let envelope: Value = resp
        .json()
        .map_err(|e| format!("Malformed MCP response: {e}"))?;
    if let Some(err) = envelope.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown MCP error");
        return Err(message.to_string());
    }
    let text = envelope
        .pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .ok_or("MCP response carried no tool payload")?;
    let payload: Value =
        serde_json::from_str(text).map_err(|e| format!("Malformed tool payload: {e}"))?;
    if let Some(err) = payload.get("error").and_then(Value::as_str) {
        return Err(err.to_string());
    }
    Ok(payload)
}

/// Open an MCP session and bind it to this PTY's peer identity.
fn connect() -> Result<String, String> {
    let session = tuic_session().ok_or(
        "TUIC_SESSION is not set: `fastaf agent send` addresses the peer registry \
         and must run inside a FastAF session. To type a prompt into an \
         agent's terminal instead, use `fastaf agent type <target> <text>`.",
    )?;

    let init = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": "fastaf-cli", "version": env!("CARGO_PKG_VERSION") },
        }
    });
    let resp = post(&init, None)?;
    if !resp.is_success() {
        return Err(format!("MCP initialize failed: HTTP {}", resp.status));
    }
    let mcp_session = resp
        .header("mcp-session-id")
        .ok_or("MCP initialize returned no Mcp-Session-Id header")?
        .to_string();

    // Prefer our own identity so the recipient sees the real sender. This
    // succeeds from a plain shell pane, where nothing else holds the identity.
    //
    // It FAILS in the common case of an agent shelling out while connected: the
    // agent already owns `$TUIC_SESSION` on its own MCP session, and the server
    // refuses a second claim rather than stealing a live binding. That refusal
    // is correct, so we do not fight it — we fall back to an anonymous identity
    // (register with no `tuic_session`, the server mints an MCP-scoped UUID)
    // named after our session so the recipient can still tell who sent it.
    // `replaces` is deliberately NOT used: it would supersede the agent's own
    // identity and strand its inbox.
    let named = register_call(2, json!({ "action": "register", "tuic_session": session }));
    if let Err(e) = unwrap_tool_result(&post(&named, Some(&mcp_session))?) {
        if !e.contains("already registered") {
            return Err(format!("Could not bind CLI identity: {e}"));
        }
        let anon = register_call(
            2,
            json!({ "action": "register", "name": format!("{session} (cli)") }),
        );
        unwrap_tool_result(&post(&anon, Some(&mcp_session))?)
            .map_err(|e| format!("Could not bind CLI identity: {e}"))?;
    }

    Ok(mcp_session)
}

/// Human-readable outcome line for a delivery report.
///
/// `accepted`/`ok` only mean "buffered". `delivered` is false exactly when the
/// route is `inbox_only`: nothing will surface the message until the recipient
/// polls. Printing that as "Delivered" is how a reply to an agent with no PTY
/// silently vanished once — so the two cases read differently here.
pub fn delivery_line(to: &str, report: &Value) -> String {
    let route = report["delivery_path"].as_str().unwrap_or("inbox_only");
    if report["delivered"].as_bool() == Some(true) {
        return format!("Delivered to {to} ({route})");
    }
    let mut line =
        format!("Buffered for {to} ({route}) — unread until the recipient polls its inbox");
    if let Some(warning) = report["warning"].as_str() {
        line.push_str(&format!("\nwarning: {warning}"));
    }
    line
}

fn register_call(id: u64, arguments: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": { "name": "agent", "arguments": arguments }
    })
}

/// Deliver `message` to peer `to` through the registry.
///
/// Returns the delivery report so the caller can print the route. `accepted`
/// alone only means "buffered", so callers must not treat it as delivery.
pub fn agent_send(to: &str, message: &str) -> Result<Value, String> {
    let mcp_session = connect()?;
    let call = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "agent",
            "arguments": { "action": "send", "to": to, "message": message }
        }
    });
    let resp = post(&call, Some(&mcp_session))?;
    let payload = unwrap_tool_result(&resp)?;
    if payload.get("accepted").and_then(Value::as_bool) != Some(true) {
        return Err(format!("Registry did not accept the message: {payload}"));
    }
    Ok(payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(status: u16, body: &str, headers: &[(&str, &str)]) -> ipc::Response {
        ipc::Response {
            status,
            body: body.to_string(),
            headers: headers
                .iter()
                .map(|(k, v)| (k.to_ascii_lowercase(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn header_lookup_is_case_insensitive() {
        let resp = response(200, "", &[("Mcp-Session-Id", "abc")]);
        assert_eq!(resp.header("mcp-session-id"), Some("abc"));
        assert_eq!(resp.header("MCP-SESSION-ID"), Some("abc"));
        assert_eq!(resp.header("absent"), None);
    }

    #[test]
    fn tool_payload_is_unwrapped_through_both_envelopes() {
        let resp = response(
            200,
            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text",
               "text":"{\"accepted\":true,\"delivery_path\":\"sse_channel_and_inbox\"}"}]}}"#,
            &[],
        );
        let payload = unwrap_tool_result(&resp).expect("payload");
        assert_eq!(payload["accepted"], serde_json::json!(true));
        assert_eq!(payload["delivery_path"], "sse_channel_and_inbox");
    }

    /// The whole point of the story: a refusal must not read as a success.
    #[test]
    fn a_tool_level_error_is_surfaced_verbatim() {
        let resp = response(
            200,
            r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text",
               "text":"{\"error\":\"Recipient not found\"}"}]}}"#,
            &[],
        );
        assert_eq!(
            unwrap_tool_result(&resp).unwrap_err(),
            "Recipient not found"
        );
    }

    #[test]
    fn a_jsonrpc_level_error_is_surfaced_verbatim() {
        let resp = response(
            200,
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32000,
               "message":"FastAF IPC request failed"}}"#,
            &[],
        );
        assert_eq!(
            unwrap_tool_result(&resp).unwrap_err(),
            "FastAF IPC request failed"
        );
    }

    #[test]
    fn a_live_route_reads_as_delivered() {
        let report = json!({ "delivered": true, "delivery_path": "sse_channel_and_inbox" });
        assert_eq!(
            delivery_line("peer-1", &report),
            "Delivered to peer-1 (sse_channel_and_inbox)"
        );
    }

    /// `accepted` alone means "buffered". Announcing that as delivery is how a
    /// reply to a peer with no PTY vanished in silence — so it must not read
    /// as delivered, and the warning the registry sends must reach the user.
    #[test]
    fn an_inbox_only_route_is_never_announced_as_delivered() {
        let report = json!({
            "accepted": true,
            "delivered": false,
            "delivery_path": "inbox_only",
            "warning": "Recipient has no live channel",
        });
        let line = delivery_line("peer-1", &report);
        assert!(!line.contains("Delivered"), "{line}");
        assert!(line.contains("inbox_only"), "{line}");
        assert!(line.contains("Recipient has no live channel"), "{line}");
    }

    /// A report that omits the flag is unproven, not proven good.
    #[test]
    fn a_report_without_a_delivered_flag_is_not_delivered() {
        let line = delivery_line("peer-1", &json!({ "accepted": true }));
        assert!(!line.contains("Delivered"), "{line}");
    }

    #[test]
    fn a_non_2xx_response_is_never_a_success() {
        let resp = response(503, "unavailable", &[]);
        assert!(
            unwrap_tool_result(&resp)
                .unwrap_err()
                .starts_with("HTTP 503")
        );
    }
}
