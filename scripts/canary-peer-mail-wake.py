#!/usr/bin/env python3
"""Check that a real idle managed agent receives peer mail in its PTY."""

import json
import os
import sys
import time
import urllib.request


BASE = os.environ.get("TUIC_CANARY_URL", "http://127.0.0.1:9877").rstrip("/")
AGENT = sys.argv[1] if len(sys.argv) > 1 else "claude"
CAPACITY = sys.argv[2:] == ["--capacity"]
if AGENT not in {"claude", "codex"} or (len(sys.argv) > 2 and not CAPACITY):
    sys.exit("usage: canary-peer-mail-wake.py [claude|codex] [--capacity]")


def request(path, body=None, headers=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers={"Content-Type": "application/json", **(headers or {})},
        method=method,
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        raw = response.read()
        return json.loads(raw) if raw else None, response.headers


def mcp_call(sid, action, **args):
    result, _ = request(
        "/mcp",
        {"jsonrpc": "2.0", "id": action, "method": "tools/call",
         "params": {"name": "agent", "arguments": {"action": action, **args}}},
        {"Accept": "application/json, text/event-stream", "Mcp-Session-Id": sid},
    )
    if "error" in result:
        raise RuntimeError(result["error"])
    value = json.loads(result["result"]["content"][0]["text"])
    if "error" in value:
        raise RuntimeError(value["error"])
    return value


def initialize(extra_headers=None):
    initialized, headers = request(
        "/mcp",
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                    "clientInfo": {"name": "peer-mail-canary", "version": "1"}}},
        {"Accept": "application/json, text/event-stream", **(extra_headers or {})},
    )
    if "error" in initialized:
        raise RuntimeError(initialized["error"])
    return headers["Mcp-Session-Id"]


def output_text(output):
    return "\n".join(
        "".join(span["text"] for span in row["spans"])
        for row in output.get("lines", []) + output.get("screen", [])
    )


session_id = None
mcp_sid = None
reader_sid = None
try:
    mcp_sid = initialize()
    mcp_call(mcp_sid, "register", name="peer-mail-canary")
    spawned = mcp_call(
        mcp_sid, "spawn", agent_type=AGENT, name="peer-mail-canary-recipient",
        cwd=os.getcwd(),
        prompt="Reply CANARY_READY once. Do not call tools; wait for a new message.",
    )
    session_id = spawned["session_id"]
    peers = mcp_call(mcp_sid, "list_peers")["peers"]
    if not any(peer.get("session_id") == session_id for peer in peers):
        raise RuntimeError(f"{AGENT} spawn did not register a terminal peer")

    ready_by = time.monotonic() + 120
    while time.monotonic() < ready_by:
        sessions, _ = request("/sessions")
        recipient = next((item for item in sessions if item["session_id"] == session_id), None)
        state = recipient.get("state", {}) if recipient else {}
        if (recipient and state.get("shell_state") == "idle"
                and state.get("agent_state") in {"idle", "completed"}):
            break
        time.sleep(1)
    else:
        output, _ = request(f"/sessions/{session_id}/output?format=log")
        observed = output_text(output)
        raise RuntimeError(
            f"{AGENT} did not reach an idle composer in 120 s; "
            f"last state={state}; output tail={observed[-1000:]!r}"
        )

    sent = mcp_call(mcp_sid, "send", to=session_id, message="canary mail")
    if sent.get("delivery_path") != "wake_notification_and_inbox":
        raise RuntimeError(f"mail did not choose the PTY wake: {sent}")

    wake_by = time.monotonic() + 20
    while time.monotonic() < wake_by:
        output, _ = request(f"/sessions/{session_id}/output?format=log")
        observed = output_text(output)
        if "[TUIC] message available" in observed and "agent action=inbox" in observed:
            print(f"PASS {AGENT}: peer mail wake appeared in PTY within 20 s")
            break
        time.sleep(1)
    else:
        raise RuntimeError(f"{AGENT} PTY did not show PEER_MAIL_WAKE within 20 s")

    if CAPACITY:
        # The reader is a second MCP connection bound to this disposable PTY.
        # It observes the same inbox without relying on the agent's reply time.
        reader_sid = initialize({"X-Tuic-Session": session_id})
        baseline = mcp_call(reader_sid, "inbox", since=0, limit=100)
        deadline = time.monotonic() + 90
        for index in range(100):
            if time.monotonic() >= deadline:
                raise RuntimeError("capacity canary timed out before 100 sends")
            mcp_call(mcp_sid, "send", to=session_id, message=f"capacity-{index}")
        read = mcp_call(reader_sid, "inbox", since=baseline["next_since"], limit=100)
        if read["count"] != 100:
            raise RuntimeError(f"capacity canary read {read['count']} of 100 messages")
        mcp_call(mcp_sid, "send", to=session_id, message="capacity-101")
        unread = mcp_call(reader_sid, "inbox", since=read["next_since"])
        if unread["count"] != 1 or unread["messages"][0]["content"] != "capacity-101":
            raise RuntimeError(f"101st message is not readable: {unread}")
        print("PASS: inbox accepted and returned mail after 100 read messages")
finally:
    cleanup_errors = []
    if session_id:
        try:
            request(f"/sessions/{session_id}", method="DELETE")
        except OSError as error:
            cleanup_errors.append(f"session {session_id}: {error}")
    for sid in (reader_sid, mcp_sid):
        if sid:
            try:
                request("/mcp", headers={"Mcp-Session-Id": sid}, method="DELETE")
            except OSError as error:
                cleanup_errors.append(f"MCP session {sid}: {error}")
    if cleanup_errors:
        raise RuntimeError("cleanup needed: " + "; ".join(cleanup_errors))
