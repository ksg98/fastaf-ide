//! Which MCP transports an ACP connection may carry.
//!
//! This file used to hold the stdio `tuic-bridge` entry (story 796). That entry
//! is gone — ego reaches `tuicommander` over ACP (story 1156) — and what stays
//! here is the rule it shared with every transport: one the agent never
//! advertised is refused.

use agent_client_protocol::schema::{ProtocolVersion, v1};

/// Advertising stdio must not become a free pass for the other transports.
///
/// `http` and `sse` are real capabilities an agent either published or did
/// not, and the gate exists because an agent that answers `http == false`
/// still returns a session — so an ungated HTTP entry buys a session and no
/// tools, with nothing saying why.
#[test]
fn an_unadvertised_transport_is_still_refused() {
    let snapshot = tuicommander_lib::acp::capability_snapshot(&initialize_response(false, false))
        .expect("a v1 response must produce a snapshot");
    assert!(!snapshot.mcp_http);
    assert!(!snapshot.mcp_sse);

    let advertised = tuicommander_lib::acp::capability_snapshot(&initialize_response(true, true))
        .expect("a v1 response must produce a snapshot");
    assert!(advertised.mcp_http);
    assert!(advertised.mcp_sse);
}

fn initialize_response(http: bool, sse: bool) -> v1::InitializeResponse {
    let mut response = v1::InitializeResponse::new(ProtocolVersion::V1);
    response.agent_capabilities.mcp_capabilities.http = http;
    response.agent_capabilities.mcp_capabilities.sse = sse;
    response
}
