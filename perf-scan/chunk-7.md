# Chunk 7 — HTTP/MCP server, SSE, MCP proxy, relay, tunnel audit

Scope: `src-tauri/src/mcp_http/` (router, middleware, SSE, MCP transport),
`src-tauri/src/mcp_proxy/`, `src-tauri/src/relay_client.rs`, the Rust side of
the tunnel path and `tunnel_audit.db`. Same methodology, severity scale and
verification ladder as `performance_scan.md`. Finding ids F60-F69. Read-only
pass; no code was modified, no session was created or closed.

Per-session WS findings (F13, F14, F15, F18, F19) are chunk 2b's and are not
repeated. Where this chunk touches the same file it says so and stops at the
boundary.

---

## Files evaluated

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src-tauri/src/mcp_http/mod.rs` (`shared_routes` 535-889, `build_router` 891-1462, `start_server` 1545-1900) | 7 | 2026-08-16 | F67; router built per `axum::serve`, not per request (clean) |
| `src-tauri/src/mcp_http/mod.rs` (MCP session reaper 1580-1660) | 7 | 2026-08-16 | contributes to F66 (reaper does not sweep `messaging_channels`) |
| `src-tauri/src/mcp_http/auth.rs` (`basic_auth_middleware` 207-330) | 7 | 2026-08-16 | clean (cookie fast path, bcrypt on `spawn_blocking`, rate-limit map swept) |
| `src-tauri/src/mcp_http/sse_routes.rs` | 7 | 2026-08-16 | F64 (measured; downgrades chunk 2 F9's SSE note) |
| `src-tauri/src/mcp_http/static_files.rs` + `CompressionLayer` (`mod.rs:1447-1451`) | 7 | 2026-08-16 | F67 |
| `src-tauri/src/mcp_http/mcp_transport.rs` (`mcp_post` 4978-5236) | 7 | 2026-08-16 | F60, F62 |
| `src-tauri/src/mcp_http/mcp_transport.rs` (`apply_initialize_identity` 704-744, `refresh_mcp_session` 771-792, `join_peer_identity_locked` 542-553) | 7 | 2026-08-16 | F60 |
| `src-tauri/src/mcp_http/mcp_transport.rs` (`resolve_allowed_upstreams` 1208-1220, `merged_tool_definitions_for_mode` 1258-1272) | 7 | 2026-08-16 | F62 |
| `src-tauri/src/mcp_http/mcp_transport.rs` (`mcp_get` 5237-5336, `mcp_delete` 5347-5410) | 7 | 2026-08-16 | F66 |
| `src-tauri/crates/tuic-bridge/src/main.rs` (`post_mcp` 280-328, health loop 738-780, `start_sse_listener` 473-503) | 7 | 2026-08-16 | F60 |
| `src-tauri/src/mcp_proxy/registry.rs` (`run_health_checks` 1217-1327, `health_check_entry` 1329-1345) | 7 | 2026-08-16 | F61 |
| `src-tauri/src/mcp_proxy/registry.rs` (`dispatch_tool_call` 1011-1067) | 7 | 2026-08-16 | contributes to F63 |
| `src-tauri/src/mcp_proxy/stdio_client.rs` (`rpc` 377-416, `read_line` 458-480) | 7 | 2026-08-16 | F63 |
| `src-tauri/src/mcp_proxy/http_client.rs` (`resolve_bearer` 180-200, `call_tool` 381-400, `decode_response` 470-506) | 7 | 2026-08-16 | F69 |
| `src-tauri/src/credentials.rs` (`get` 242-266, `load` 173-207) | 7 | 2026-08-16 | contributes to F69 (vault memoised; negative lookup is not) |
| `src-tauri/src/relay_client.rs` | 7 | 2026-08-16 | F65 |
| `src-tauri/src/lib.rs:1190-1200` (relay spawn gate) | 7 | 2026-08-16 | clean when disabled (verified); contributes to F65 |
| `src-tauri/src/tunnels/audit.rs`, `tunnels/manager.rs:114-196`, `tunnels/backoff.rs` | 7 | 2026-08-16 | F68 |
| `src/invoke.ts` (`ensureSse` 110-128, `listen` 163-206), `src/transport.ts:2371-2412` | 7 | 2026-08-16 | F64 |

---

## Findings

### F60 — 19 bridge processes each open a fresh IPC connection every 3 s and take a process-global lock, while already holding a live SSE stream (P2)

`tuic-bridge/src/main.rs:738-745` runs, per bridge process, forever:

```rust
loop {
    tokio::time::sleep(Duration::from_secs(3)).await;
    if bg_state.connected.load(Ordering::Acquire) {
        let health = post_mcp(r#"{"jsonrpc":"2.0","id":0,"method":"ping"}"#, sid).await;
```

`post_mcp` (`main.rs:280-305`) is **not** a pooled client: it calls
`connect_ipc()` and writes a hand-rolled `HTTP/1.1` request with
`Connection: close`. So each tick is a full Unix-socket connect → accept →
hyper connection task → tower stack → teardown.

**Measured** on this machine, 2026-08-16: `pgrep -f target/debug/tuic-bridge`
returns **19** live bridges across **15** distinct parents (Codex opens two per
agent, as `mcp_transport.rs:712-716` documents). 19 ÷ 3 s = **~6.3 socket
accepts per second, 24/7**, purely for liveness.

The server side of each ping is not free either. `mcp_post`'s `"ping"` arm
(`mcp_transport.rs:5074-5093`) calls `refresh_mcp_session`
(`:771-792`), which unconditionally calls `apply_initialize_identity`
(`:704-744`). When the bridge asserts `x-tuic-session` — every managed PTY does,
the header is added at `main.rs:295` — that function takes the **process-global**
`PEER_IDENTITY_BIND_LOCK` (`:711`), runs `peer_identity_ownership_locked`
(`:507-526`, two DashMap lookups plus a `receiver_count()` probe), and then
`join_peer_identity_locked` (`:542-553`) or `bind_peer_identity_locked` — two
`String` allocations, a DashMap insert, and a linear scan of the reverse vector.
All of it re-establishes a binding that has not changed since the previous tick.

So: **~6.3 acquisitions/second of one process-wide mutex, plus ~6.3
connect/accept cycles/second**, at rest, on an idle machine. Cost per event is
small; the frequency and the global lock are the problem, and both are pure
polling — methodology C.12.

The redundancy is structural, not incidental: the same bridge **already holds a
persistent SSE stream** on `GET /mcp` (`main.rs:473-503` → `mcp_get`), and that
stream carries a server keep-alive comment every 15 s
(`mcp_transport.rs:5333-5335`). Liveness is already being pushed; the 3 s POST
loop measures it a second time by polling. A bridge that watched its own SSE
stream for keep-alive silence would need zero periodic requests.

Not claimed: I did not measure the CPU cost of an accept cycle (that needs
`POST /diagnostics`, a mutation, which this pass avoided). The 19 and the 3 s
are measured; the 6.3/s is their quotient.

Side note for whoever fixes this: the ping also keeps `last_activity` fresh, so
the 1 h idle reaper (`mod.rs:1583-1590`) can never fire for a bridge session.
That is correct today — a bridge dies with its agent's stdin — but any fix that
keeps a heartbeat must keep that property deliberately rather than by accident.

### F61 — the upstream health checker refetches every tool list every 60 s regardless of demand, and re-probes dead upstreams with no backoff (P2)

`spawn_health_checker` (`mcp_proxy/registry.rs:945-950`) ticks every
`HEALTH_CHECK_INTERVAL = 60s` (`:47`) and calls `run_health_checks`
(`:1217-1327`). "Health check" is not a ping: `health_check_entry`
(`:1329-1345`) issues a full **`tools/list`** JSON-RPC request
(`http_client.rs:403-406`, `stdio_client.rs:300-323`) and the result is written
back unconditionally — `*entry.tools.write() = tools;` (`:1258`) — with only the
**count** compared (`old_count != new_count`, `:1273`) to decide whether to
signal `mcp_tools_tx`.

**Measured** via `GET :9876/mcp/upstream-status`, 2026-08-16: **10 upstreams
configured** — 6 `ready`, 3 `failed`, 1 `disabled` — carrying **129 tools**
between the ready ones. The probe predicate (`:1233-1241`) returns `true` for
`Ready`, `Failed`, `Connecting`, and `CircuitOpen` past its backoff, so **9 of
the 10 are probed every minute**: ~12 900 upstream round-trips per day, of which
the 6 ready ones return the full JSON-Schema definitions of 129 tools, which are
then deserialized into fresh `Vec<Value>` and dropped if the count matched. All
of this runs whether or not any MCP client has asked for a tool list.

The `Failed` arm is the sharper edge. `CircuitOpen` is gated on
`!entry_ref.cb.is_open()` — it respects the circuit breaker's backoff.
`Failed` is not gated at all, so a **permanently** dead upstream is probed at the
full 60 s rate forever, while a *transiently* failing one is throttled. That is
inverted. Three of the configured upstreams are corporate URLs that are
unreachable from here (`quill`, `gh-metrics`, `openrouter-key-manager`; the live
`/logs?source=mcp_registry` shows `Health check failed permanently` for two of
them), and each attempt runs against a `timeout_secs: 10` default
(`registry.rs:266`) — so three requests per minute that exist only to hang and
time out.

Payload volume per refresh is an **estimate** and was not measured: I did not
issue a `tools/list` against the live server because doing so mints an MCP
protocol session. 129 tool definitions with realistic JSON Schemas is on the
order of 100 KB; treat the shape as certain and the number as indicative.

### F62 — every MCP `tools/call` reads and parses `repo-settings.json` from disk, and throws it away for native tools (P2)

`mcp_post`'s `"tools/call"` arm computes the upstream allowlist *before*
branching on the tool kind (`mcp_transport.rs:5184`):

```rust
let allowed = resolve_allowed_upstreams(&state, session_id_str.as_deref());
let (result, is_error) = if tool_name.contains("__") { … } else { … native … };
```

`resolve_allowed_upstreams` (`:1208-1220`) calls
`crate::config::load_repo_settings()` (`config.rs:2183`), which is
`load_json_config` (`config.rs:146-169`) — an **uncached** synchronous
`std::fs::read_to_string` plus `serde_json::from_str`, with no in-memory copy
and no mtime check.

**Measured**: `repo-settings.json` is **10 606 bytes** on this machine
(2026-08-16). So every MCP tool call — the busiest MCP path there is, one per
agent action across all 15 agents — performs a blocking 10 KB file read and a
full JSON parse **inside an async axum handler**, occupying a tokio worker
thread for the duration, and discards the result entirely whenever the tool is
native (no `__` in the name), which is the common case.

The same call sits on two more paths: `merged_tool_definitions_for_mode:1268`
(per `tools/list`, defensible) and `handle_meta_call_tool:1550`. A fourth
`load_repo_settings()` is in `build_mcp_instructions` (`:907`), once per
`initialize` — fine.

Two independent fixes, either sufficient: hoist the call inside the
`tool_name.contains("__")` branch so native calls never pay it, and/or give
`load_repo_settings` the mtime-checked cache the config layer already has the
machinery for. The first is three lines and removes the cost from the majority
of calls.

### F63 — a stdio MCP upstream that stops answering wedges its client mutex and leaks a blocking-pool thread per call, with no timeout anywhere (P2)

`StdioMcpClient::rpc` (`mcp_proxy/stdio_client.rs:377-416`) writes a request and
then loops on `read_line` (`:458-470`), which is
`std::io::BufRead::read_line` — a **blocking read with no timeout and no
deadline**. There is no `Duration` anywhere in the file, and the `timeout_secs`
config field (`registry.rs:266`) is threaded into `HttpMcpClient::new`
(`http_client.rs:115-129`) only; the stdio constructor
(`stdio_client.rs:47-56`) ignores it.

Failure scenario: an upstream process that is alive (so `is_alive()` at
`:283` passes — it only calls `try_wait`) but has stopped writing to stdout —
deadlocked, waiting on its own network call, `SIGSTOP`ped. Then:

1. `dispatch_tool_call` (`registry.rs:1053-1067`) has already entered
   `spawn_blocking`, and `guard.call_tool(...)` never returns → **one
   blocking-pool thread parked forever**.
2. The `std::sync::Mutex` around the client (`registry.rs:173`) is held for that
   whole time, so every subsequent call to the same upstream blocks on the
   mutex — each one *also* inside its own `spawn_blocking` → **one more parked
   thread per call**.
3. `health_check_entry` (`:1337-1341`) joins the same queue every 60 s, adding a
   thread per minute indefinitely.

Nothing above ever times out, so the upstream never transitions to
`CircuitOpen`/`Failed` and the circuit breaker never opens — the mechanism that
exists to contain this cannot see it. The blocking pool's ceiling is tokio's
default 512 threads; past that, every `spawn_blocking` in the process queues,
which includes the bcrypt path in `auth.rs:307` and each native MCP handler
(`run_blocking_handler`, per the comment at `mcp_transport.rs:5181-5183`).

This chunk found the shape, not an occurrence: no hung stdio upstream was
observed (the one stdio upstream here, `maccontrol`, is `ready`). The fix is
either a read deadline on the pipe or moving the RPC behind
`tokio::time::timeout` on the `spawn_blocking` join — the latter frees the
caller but *not* the thread, so the deadline belongs on the read.

### F64 — the browser client subscribes to the whole event bus unfiltered; the filtered helper that exists has no caller (P2)

`src/invoke.ts:115` is the shared browser-mode event source:

```ts
_sseSource = new EventSource(`${origin}/events`);
```

No `?types=`. `sse_events` (`sse_routes.rs:31-36`) treats an absent `types` as
"forward everything", so a browser/PWA tab receives **every** `AppEvent` in the
process — including every `pty-parsed` for every session — each one built into a
`serde_json::Value` by `event_payload` (`:119-276`) and stringified (`:51`)
specifically for that client, pushed over the wire, and `JSON.parse`d on the
browser main thread at `invoke.ts:135` before being dropped because no listener
is registered for its type (`:137`).

`transport.ts:2371-2412` (`subscribeEvents`) does build a filtered
`?types=…` URL from its handler keys — and grepping `src/` for its name finds
**no production caller**; only `remoteEventBridge.ts:27` builds a filtered URL,
and that one points at a *different* (remote) instance's base URL. So the
correct pattern exists, is unused, and the used path is the unfiltered one.

**Measured** (12 s `GET :9876/events`, unfiltered, 2026-08-16): 13 events,
1 958 bytes total — **~1.1 events/s, ~163 B/s, ~150 B/event**, with
`pty-parsed` (10) and `repo-changed` (3) the only types seen. Two things follow,
and they point in opposite directions:

- The chunk 2 F9 note that `event_payload` + `to_string` run **once per
  connected SSE client** is confirmed by inspection, and **measured as cheap at
  this rate**: N clients × 163 B/s. It is a structural per-recipient
  serialization (methodology A.3), not a hot path today. Recorded so nobody
  optimises it ahead of F60/F62.
- The unfiltered subscription is the real cost, and it is not on the server:
  it is bandwidth on a remote link and `JSON.parse` on the WebView main thread
  for events the client provably has no handler for. On a busy agent session
  `pty-parsed` rises well above 1.1/s (every `status-line` tick, though deduped
  per `(turn_epoch, task_name)` — chunk 2 F9).

Adjacent, not filed separately: `state.event_counter.fetch_add`
(`sse_routes.rs:50`) is a **process-global** counter shared by all streams, so
the `id:` sequence any single client sees is sparse and non-monotonic as soon as
two clients are connected. Nothing consumes `Last-Event-ID` today, so this is
latent, not broken — see Open questions.

### F65 — when the relay is enabled it ships the entire event bus to the cloud with no peer gate and no filter, on its own private tokio runtime (P3)

Cost when **disabled** is genuinely zero, and that is worth stating because it
was the question asked: `lib.rs:1190` gates the thread spawn on
`config.services.relay.enabled`, and `run` (`relay_client.rs:149-155`) returns
before subscribing if the flag, URL or token is empty. No task, no bus
subscriber, no residual work.

When enabled, three things stand out.

1. **No recipient gate.** The bus arm (`relay_client.rs:275-307`) serializes
   (`serde_json::to_vec`), AES-256-GCM-encrypts, and sends **every** `AppEvent`
   to the relay unconditionally. `PeerStatus::Waiting` / `Disconnected` /
   `Timeout` arrive on the same socket (`:332-342`) and are only *logged* — they
   never gate forwarding. So with zero mobile peers attached, the full event
   stream is still encrypted and pushed over WSS to a third-party server, at
   whatever rate the bus runs (measured baseline in F64: ~1.1 events/s here,
   higher with active agents).
2. **No type filter.** `/events` has `?types=`; the relay has nothing equivalent
   — `pty-parsed`, `repo-changed`, `github-pr-update`, everything goes. This is
   also a privacy surface given the module's own TRUST MODEL note
   (`relay_client.rs:1-11`: the relay operator can decrypt), but this document
   records it as waste.
3. **A second full runtime.** `lib.rs:1194-1198` spawns an OS thread and builds
   `tokio::runtime::Runtime::new()` inside it — the multi-thread flavour, so one
   worker thread per core plus a blocking pool, for a task that is one
   `select!` over two channels. `tokio::spawn` onto the existing runtime would
   do. Thread-count cost is an **estimate** from the default builder (workers =
   `available_parallelism`), not measured; the relay is disabled here.

Minor, same file: `serde_json::to_vec(evt)?` at `:303` propagates a
serialization error out of `connect_and_run`, which the caller reads as a
connection failure and answers with a reconnect plus backoff — a bad payload
would drop a healthy socket. And `awaiting_by_session` is pruned on `PtyExit`
(`:298`) but not on `SessionClosed`, so a session that closes without a PTY exit
leaves an entry behind for the life of the connection.

### F66 — the per-MCP-session messaging channel is never evicted when the client disconnects (P3)

This is the chunk 2b F13 pattern (`ws_clients`) in a second place.

`mcp_get` (`mcp_transport.rs:5279-5285`) creates or joins a
`broadcast::channel(64)` per MCP session id in `state.messaging_channels`
(`state.rs:1518`). The stream's cleanup lives **after** the `loop` inside
`async_stream::stream!` (`:5326-5329`):

```rust
    }   // <- loop, exits only on RecvError::Closed
    if let Some(mut meta) = cleanup_state.mcp_sessions.get_mut(&cleanup_sid) {
        meta.has_sse_stream = false;
    }
    cleanup_state.messaging_channels.remove(&cleanup_sid);
};
```

A generator's tail does not run when the generator is **dropped**, and dropping
is exactly what axum does to an SSE stream when the client disconnects. The
`break` path requires `RecvError::Closed`, which needs the `Sender` to be
dropped — and the only thing that drops it is the line that never runs. So on
every real disconnect the entry survives.

Nothing else reaps it either: the 60 s MCP session reaper
(`mod.rs:1583-1628`) removes `mcp_sessions`, `peer_agents`,
`orchestrator_peers`, `active_agent_waiters` and `agent_inbox` — not
`messaging_channels`. `mcp_delete` (`mcp_transport.rs:5347-5410`) removes
`mcp_sessions`, `mcp_to_session`, `session_to_mcp`, `peer_agents`,
`orchestrator_peers` and `agent_inbox` — not `messaging_channels`. Same
hand-maintained-enumeration failure as chunk 2's F8.

Amplitude is small and I want to be precise about why: a `broadcast::Sender`
with no receivers does not retain the values passed to `send`, so the orphaned
64-slot ring stays empty. The leak is one `Sender` + one UUID `String` +
one DashMap slot per MCP session that ever opened an SSE stream — a few hundred
bytes each, accumulating across every bridge reconnect (19 bridges × a
reconnect each time TUIC restarts or the socket rebinds). P3 on size, but it is
the kind that is invisible until someone counts.

The liveness logic downstream is, to its credit, robust to this:
`mcp_session_has_live_owner` (`:490-503`) tests `sender.receiver_count() > 0`
rather than trusting the map's existence. The stuck `has_sse_stream: true` flag
is read at `:128` and leads to a `channel.send()` at `:4116` that returns `Err`
and falls back correctly — a wasted attempt, not a misroute.

### F67 — static assets are recompressed on every request, with no cache (P3)

`mod.rs:1447-1451` wraps the whole router in
`CompressionLayer::new().compress_when(DefaultPredicate::new().and(SizeAbove::new(860)))`,
with `compression-gzip` and `compression-br` enabled
(`Cargo.toml:181`). `tower_http`'s compression is a streaming encoder: it
compresses the body as it passes, and stores nothing. `serve_embedded_file`
(`static_files.rs:135-146`) hands over the raw `include_dir` bytes each time, so
the *same* asset is re-encoded on every request.

**Measured** against the live instance, loopback, `dist/assets/DiffFileList-D6oE7wXu.js`
(1 066 889 bytes), three runs each:

| `Accept-Encoding` | Bytes sent | `time_total` |
|---|---|---|
| `identity` | 1 066 889 | 7.1 / 3.3 / 2.8 ms |
| `gzip` | 339 963 | 12.7 / 11.7 / 12.0 ms |
| `br` | 336 524 | 19.4 / 16.3 / 15.7 ms |

The timings are flat across repeats, which is the point: **there is no warm
cache**. ~9 ms (gzip) to ~13 ms (brotli) of CPU per megabyte per request, and
`dist/` is **13 MB** total.

Blast radius is bounded by `cache_control_for` (`static_files.rs:113-132`):
hashed `assets/*` are `immutable`, so a returning browser does not refetch.
The cost lands on first load, hard refresh, a new browser-mode client, and
service-worker precache — i.e. it is a first-paint tax on the web/PWA path, not
a steady-state one. Hence P3. Two cheap options: precompress `dist/` at build
time and serve `.br`/`.gz` directly, or keep a small `OnceLock` map of
already-encoded asset bodies (they are static for the process lifetime).

### F68 — the tunnel audit DB is never rotated, never checkpointed, and is opened at every launch even when tunnels are unused (P3)

Three small things in `tunnels/audit.rs`, all measurable on disk.

**`rotate()` has no caller.** `audit.rs:109-116` implements retention
(`DELETE … WHERE timestamp < datetime('now', ?1)`), and grepping
`src-tauri/src` for `.rotate(` finds exactly one hit — `audit.rs:248`, inside
the unit test. No scheduler, no startup sweep, no command. The table grows for
the life of the install.

**The WAL is never checkpointed.** Measured in the shared config dir,
2026-08-16:

```
tunnel_audit.db       4 096 B   (mtime 2026-05-10)
tunnel_audit.db-wal 358 472 B   (mtime 2026-06-08)
tunnel_audit.db-shm  32 768 B   (mtime 2026-08-14)
```

The main database is a single page; all committed data sits in a 358 KB WAL that
has never been folded back. The connection is opened once into
`state.tunnel_audit` (`state.rs:2362-2364`) and held for the process lifetime,
and nothing calls `wal_checkpoint`. The recent `-shm` mtime against the stale
`-wal` mtime is the signature of "every launch opens it, nothing writes".

**It is opened unconditionally.** `AppState::new` (`state.rs:2362`) runs
`AuditLog::open` — `Connection::open`, `PRAGMA journal_mode=WAL`, and three
`CREATE … IF NOT EXISTS` statements (`audit.rs:33-53`) — on the startup path,
whether or not the user has ever configured a tunnel. With a 358 KB WAL present
that also means WAL recovery at open.

**Write frequency is not a concern**, and I checked before assuming: `insert`
is called only from tunnel lifecycle transitions (`manager.rs:134`, `:158`,
`:176`, `:190`), and the retry path is bounded — `BackoffCalculator`
(`backoff.rs:14-17`) caps at 10 attempts with 1 s→30 s exponential backoff, so a
flapping tunnel produces ~10 rows and stops. Each `insert` is nonetheless its
own autocommit transaction at rusqlite's default `synchronous=FULL`, i.e. one
WAL fsync per row; `synchronous=NORMAL` is the standard WAL setting and would be
correct here, but at this write rate it is a footnote, not a cost.

On the cross-process contention AGENTS.md warns about: WAL permits many readers
and one writer across processes, and both instances write only on tunnel
transitions, so contention is theoretical rather than observed. Not filed.

### F69 — DROPPED by the 2026-08-17 verification pass (verdict: INCORRECT)

The keychain-storm claim below is contradicted by the current process-wide vault
cache; only a possible in-process map/mutex cost remains, which is not worth
filing. Text kept for the record; do not act on it.

<sub>Original: the credential vault is re-read per tool call, and an authed upstream with no stored credential hits the Keychain on every one (P3)</sub>

`HttpMcpClient::resolve_bearer` (`http_client.rs:180-200`) runs on **every**
`call_tool` (`:386`) and every `health_check` (`:404`), i.e. at minimum once per
upstream per 60 s from F61, plus once per proxied tool call. It calls
`read_stored_credential` → `credentials::get` (`credentials.rs:242-266`).

The common path is cheap and deliberately so: `load` (`:173-207`) is memoised
behind `guard.is_some()`, so a hit is a process-global mutex acquisition, a
`HashMap` lookup and a `String` clone of the token. Two notes on it: the mutex is
global across *all* credentials, and it is taken from inside an `async fn` with
no `spawn_blocking` — fine while it stays a memory lookup.

The miss path is not. When the key is absent from the vault and the credential is
`Credential::McpUpstream(_)`, `get` falls through to the lazy-migration branch
(`:252-264`) and calls `read_keyring_entry(service, user)` — a real macOS
Keychain query to `securityd`. **Nothing caches the negative result**, so an
upstream that has `has_auth == true` but no stored credential performs a Keychain
round-trip on every health check (every 60 s, forever) and on every tool call.

Whether any configured upstream is currently in that state was not determined —
`/mcp/upstream-status` does not expose `has_auth`, and reading the vault
directly is out of scope for a read-only pass. The mechanism is certain; the
occurrence is not. Filed P3 for that reason. A `HashSet` of known-absent keys, or
simply not retrying migration after the first miss, closes it.

---

## Not covered

- **Route handler bodies.** `build_router` wires ~250 routes across
  `git_routes.rs`, `github_routes.rs`, `fs_routes.rs`, `config_routes.rs`,
  `worktree_routes.rs`, `agent_routes.rs`, `plugin_routes.rs`,
  `plugin_docs.rs`, `log_routes.rs`. This pass read the router assembly, the
  middleware stack and the MCP/SSE/proxy/relay handlers. The per-route handlers
  are their own chunk — `config_routes.rs` (30 KB) in particular, given F62
  showed `load_json_config` is uncached and that file is the main caller.
- **`mcp_transport.rs` beyond the transport surface.** The file is 14 443
  lines. Read: `mcp_post`/`mcp_get`/`mcp_delete`, the identity-binding helpers,
  the tool-definition merge path, `refresh_mcp_session`. Not read: the ~40
  native tool handlers behind `handle_mcp_tool_call_with_context`, the agent
  messaging/inbox machinery, `run_blocking_handler`.
- **`mcp_proxy/registry.rs` beyond health/dispatch** (2 143 lines): OAuth flow,
  `apply_config_diff`, `connect_upstream`, `aggregated_tools_for_repo`'s clone
  volume, the tool-search index rebuild. Chunk 2b answered that
  `rebuild_tool_search_index` is change-signalled, not per-dispatch; the cost of
  a rebuild itself was not measured.
- **`mcp_http/session.rs`** — chunk 2b owns it (F14, F15, F18, F19). Not
  re-read.
- **`ai_stream.rs` / `ai_terminal.rs` / `ai_routes.rs`** — chunk 2b owns the
  first two; `ai_routes.rs` was not opened.
- **`auth.rs` beyond the middleware**: the QR/token issuance, Tailscale
  detection (`is_tailscale_ip`), TLS renewal task.
- **The relay server itself** (`tools/relay/`) — out of scope; only the client
  half in `src-tauri` was read.
- **Frontend tunnel store** (`src/stores/tunnels.ts`) — chunk 4b's, per the
  brief.
- **No profiler was run, and no live state was mutated.** Measured here:
  bridge process count (`pgrep`), upstream inventory (`GET /mcp/upstream-status`),
  `/events` rate and volume (12 s `GET /events`), static-asset compression
  timings (`curl -w`), and file sizes on disk (`ls`). Everything else is code
  inspection with estimates labelled as such.

---

## Open questions

- **Does the bridge's SSE stream actually detect a dead server?** F60's proposed
  fix — drop the 3 s POST loop and derive liveness from SSE keep-alive silence —
  assumes `sse_listener` (`tuic-bridge/src/main.rs:487`) observes the socket
  closing or the 15 s keep-alive stopping. I read the reconnect wrapper
  (`:483-501`) but not `sse_listener` itself, so I cannot promise it fails fast
  rather than hanging. Read that before removing the poll.
- **How many `messaging_channels` entries are actually resident right now?**
  F66's leak is code-certain but unquantified: there is no endpoint that exposes
  the map's length, and `POST /diagnostics` is a mutation this pass avoided.
  One line in the diagnostics snapshot (next to the existing event-bus
  subscriber count) would settle it, and would also confirm whether bridge
  reconnects are frequent enough to matter.
- **Is any upstream in F69's Keychain-miss state?** Needs `has_auth` per
  upstream cross-referenced against the vault's key set. Neither is exposed
  read-only. If none is, F69 collapses to "the vault mutex is taken per tool
  call", which is nearly free.
- **Does `pty-parsed` on the bus rise enough to make F64's unfiltered
  subscription hurt?** The 1.1 events/s I measured is an idle-ish baseline (the
  orchestrator's agents were between turns). Chunk 2's F9 argues every emitter
  is deduped or edge-triggered, which caps it — but nobody has sampled
  `/events` during a burst of concurrent agent activity. A 60 s sample with
  several agents mid-turn would set the real ceiling, and would also tell F65
  what the relay is shipping.
- **Is `resolve_allowed_upstreams`' disk read visible in the logs?** F62 is an
  obvious win regardless, but if `perfDebug` is on in the dev build, a `SLOW`
  line around a tool call would confirm the magnitude rather than leaving it as
  "10 606 bytes, blocking, per call". I did not check `:9877` (no worktree build
  was running).
