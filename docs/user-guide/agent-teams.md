# Agent Teams

Agent Teams let Claude Code spawn teammate agents that work in parallel, each in its own FastAF terminal tab. Teammates share a task list, communicate directly with each other, and coordinate autonomously.

## How It Works

FastAF automatically injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` into every PTY session. This unlocks Claude Code's `TeamCreate`, `TaskCreate`, and `SendMessage` tools. When Claude Code spawns a teammate, FastAF creates a new terminal tab via its MCP `agent spawn` tool — no external dependencies required.

## Setup

No configuration needed. Agent Teams is enabled by default for all Claude Code sessions launched from FastAF.

To verify it's active, check the environment inside any terminal:

```bash
echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
# Should print: 1
```

## Usage

Tell Claude Code to create a team using natural language:

```
Create an agent team with 3 teammates to review this PR:
- One focused on security
- One on performance
- One on test coverage
```

Claude Code handles team creation, task assignment, and coordination. Each teammate appears as a separate tab in FastAF's sidebar.

### Navigating Teammates

Claude Code supports two display modes for teammates:

| Mode | How it works | Requirement |
|------|-------------|-------------|
| **In-process** | All teammates run inside the lead's terminal. Use `Shift+Down` to cycle between them. | None |
| **Split panes** | Each teammate gets its own pane. | tmux or iTerm2 |

FastAF works with both modes. In-process mode is the default and requires no extra setup. With split panes, each teammate appears as a separate FastAF tab.

### Key Controls (In-process Mode)

| Key | Action |
|-----|--------|
| `Shift+Down` | Cycle to next teammate |
| `Enter` | View a teammate's session |
| `Escape` | Interrupt a teammate's current turn |
| `Ctrl+T` | Toggle the shared task list |

### What Teams Can Do

- **Shared task list** — All teammates see task status and self-claim available work
- **Direct messaging** — Teammates message each other without going through the lead
- **Plan approval** — Require teammates to plan before implementing; the lead reviews and approves
- **Parallel work** — Each teammate has its own context window and works independently

## Good Use Cases

- **Code review** — Split review criteria across security, performance, and test coverage reviewers
- **Research** — Multiple teammates investigate different aspects of a problem simultaneously
- **Competing hypotheses** — Teammates test different debugging theories in parallel and challenge each other
- **New features** — Each teammate owns a separate module with no file conflicts

## Limitations

Agent Teams is an experimental Claude Code feature. Current limitations:

- **No session resumption** — `/resume` does not restore in-process teammates
- **One team per session** — Clean up before starting a new team
- **No nested teams** — Teammates cannot spawn their own teams
- **Token cost** — Each teammate is a separate Claude instance; costs scale linearly with team size
- **File conflicts** — Two teammates editing the same file leads to overwrites; assign distinct files to each

## Troubleshooting

**Teammates not appearing as tabs:**
- Verify the env var is set: `echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` should print `1`
- Check that FastAF's MCP server is running (the title bar's status cluster shows the MCP icon)

**Teammates not spawning at all:**
- Claude Code decides whether to create a team based on task complexity. Be explicit: "Create an agent team with N teammates"
- Check Claude Code version: Agent Teams requires a recent version

**Too many permission prompts:**
- Pre-approve common operations in Claude Code's permission settings before spawning teammates

## Inter-Agent Messaging

FastAF includes a built-in messaging system that lets agents in different terminal tabs communicate directly. This works alongside (and independently from) Claude Code's native Agent Teams messaging.
There is no separate `swarm` action: callers compose the `agent` and `session` primitives documented below.

### How It Works

Every PTY session gets a stable `TUIC_SESSION` UUID injected as an environment variable. Agents use this as their identity to register, discover peers, and exchange messages through FastAF's MCP `agent` tool.

Managed workers receive a payload-free terminal notice that tells them to read their inbox. If a worker is busy, FastAF waits for a safe idle composer before submitting the notice. This includes Claude Code workers with an SSE stream: a channel notification during one turn cannot start a later turn for unread mail. External Claude Code clients without a managed terminal can receive MCP channel notifications (`notifications/claude/channel`). Every message also lands in a buffered inbox.

A peer explicitly registered as an orchestrator keeps peer results and lifecycle payloads in its inbox. An idle/completed orchestrator receives only one coalesced notice that a message is available and should be read with `agent action=inbox` (`[TUIC] message available …`). The same safe notice may start a turn while background work keeps the task state `working`, but only when the shell is idle, the composer is confirmed ready and empty, and no question is active. A genuinely busy or non-quiescent orchestrator is never injected or steered. When that notice would cover nothing but child lifecycle events, it prints them instead (`[TUIC] child agent 8c261794 is now idle; child agent 8c261794 exited (exit 0)`) and no inbox read is needed — a peer message anywhere in the batch sends you back to the generic notice. An active `agent wait` receives the mail directly and suppresses that notice.

If writing that payload-free notice has an uncertain outcome, FastAF retries it at most once after five seconds. A second uncertain result exhausts the wake budget for the whole unread-mail group; later and newly coalesced mail stays inbox-only until a successful `agent action=inbox` or `agent action=wait` observation clears the group. Later mail then receives a fresh initial wake and one-retry budget.

### What Gets Injected Automatically

FastAF injects these into every Claude Code PTY session — no manual configuration needed:

| Variable / Flag | Value | Purpose |
|---|---|---|
| `TUIC_SESSION` | Stable UUID per tab | Agent identity for messaging |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Unlocks TeamCreate/TaskCreate/SendMessage |
| `--dangerously-load-development-channels server:tuicommander` | *(CLI flag, agent spawn only)* | Enables Claude's channel capability; managed peer mail still uses the PTY wake |

### Messaging Flow

> **Identity is automatic.** The bridge asserts your `$TUIC_SESSION` at connect
> (`x-tuic-session` header → server auto-bind), so an agent spawned inside FastAF
> is already a registered peer. `agent action=register` is only needed to set a friendly
> name/project, or from a standalone/external session where the env-var route is unavailable.
> External MCP clients do not need a plain-shell identity tab: call `agent action=register`
> without `tuic_session` to receive an MCP-scoped UUID, or supply an explicit UUID when the same
> identity must be reclaimed after reconnect. Reconnecting under a *new* UUID? Add
> `replaces="<old-uuid>"` or the old inbox is left behind — nothing links the two identities
> otherwise, and TUIC never guesses one from a name. The reply reports `mail_migrated`, or
> `mail_stranded` with a warning when the old identity still has a live terminal of its own.

> **Prefer blocking waits over polling.** `agent action=wait` returns as soon
> as new mail arrives; `session action=wait session_id=<id> until=idle|exited` blocks on a
> peer's lifecycle. Both default to 60 seconds, cap at 300000 ms, and return
> `{met, timed_out}`. They are event-driven end to end; the bridge deadline follows the
> requested wait instead of its ordinary ten-second timeout. A successful agent wait also returns every retained fresh message (up to the
> 100-message inbox capacity) and a per-recipient logical `next_since` cursor, so the normal path
> needs no separate inbox call. Ordinary idle workers receive a terminal notice that points to the inbox. An idle
> orchestrator instead receives a payload-free `agent action=inbox` wake; an active wait suppresses it.

1. **Register** *(optional — sets name/path)* — the agent reads its `$TUIC_SESSION`:
   ```
   agent action=register tuic_session="$TUIC_SESSION" name="worker-1" path="/path/to/repo"
   ```

2. **Discover peers** — Find other agents connected to FastAF:
   ```
   agent action=list_peers
   agent action=list_peers path="/path/to/repo"   # filter by repo
   ```

3. **Send a message** — Address by the recipient's `tuic_session` UUID:
   ```
   agent action=send to="<recipient-tuic-session>" message="PR review done, 3 issues found"
   agent action=send to="<recipient-tuic-session>" message="Stop the current edit; the requirement changed" urgency="urgent"
   ```

   `normal` is the default and follows the existing inbox, channel and idle-wake paths.
   Use `urgent` when the recipient must change course before its next step.
   The message body stays in the inbox; a working Claude Code or Codex recipient
   receives only a notice telling it to read `agent action=inbox`. The CLI
   queues that notice behind its current tool call. A long tool call therefore
   delays the notice until it ends. The notice identifies the sender by UUID;
   its display name and message body stay in the inbox. The sender receives
   `urgent_delivered=true` for a notice write, coalesced unread notice, active
   waiter, or already observed inbox. Otherwise `urgent_fallback_reason`
   explains the queued fallback. This receipt does not prove the agent acted.
   A question, a draft in the composer, an unknown agent type or an exited
   recipient prevents the busy-turn notice. One unread notice covers further
   urgent messages from the same sender until the recipient reads its inbox.

4. **Wait for and receive messages** — one blocking call returns the message bodies:
   ```
   agent action=wait
   ```
   Omit `since`: the server remembers where you got to and resumes from there, so a plain
   `wait` never re-reads mail you already saw. Pass it only to override — `since=0`
   deliberately replays the whole inbox. `next_since` comes back on every response,
   timeouts included.

5. **Check inbox directly** — useful after a reported lifecycle eviction or if channel push was missed:
   ```
   agent action=inbox
   agent action=inbox limit=10 since=1712000000000
   ```

`agent action=send` also returns `recipient_state` with the recipient's `shell_state` and
`agent_state` when the recipient is a managed PTY. External generated peers omit this field.

Automatic lifecycle notifications contain state only (`idle`, `completed`, or `exited`). They do
not contain the worker's result. Every worker reports completed output or a real blocker with
`agent action=send`; use `session action=output` only to investigate the anomaly where a child did
not send that report.

### Channel Push vs Inbox

| Delivery | When | Latency | Requires |
|----------|------|---------|----------|
| **Channel push** | External Claude client has an SSE stream and no managed PTY | Real-time | `--dangerously-load-development-channels server:tuicommander` on the recipient's CC process |
| **Managed wake** | Ordinary managed peer has a safe idle composer | Immediate or next idle transition | Managed PTY |
| **Orchestrator wake** | Registered parent is idle/completed and not waiting | Real-time, coalesced | Managed PTY + authoritative lifecycle |
| **Urgent notice** | Managed Claude Code or Codex recipient is working and the composer is safe | At the next tool boundary | `urgency="urgent"`; body remains in inbox |
| **Inbox buffer** | Always | Poll-based | Registration only |

The 2026-09-27 live CLI probes recorded in
`src-tauri/src/fixtures/agent_mail/urgent_cli_probe_2026_09_27.json` used Claude
Code 2.1.280 and Codex CLI 0.157.1. Enter alone queued the notice in both.
The immediate-send gestures were also probed for a possible future interrupt
mode: Claude's Ctrl+Enter interrupted the Bash call, and Codex's Escape
submitted steer instructions while the shell process continued. Urgent mail
does not use either gesture. A CLI update may change these key semantics;
the receipt reports the path FastAF took, not proof that the model obeyed
the notice.

Messages are always buffered in the inbox regardless of whether another delivery path succeeds. The inbox holds up to 100 messages per agent: it evicts safe lifecycle notices before peer mail, and rejects a peer send when only protected peer mail remains. Individual messages are capped at 64 KB.

### Using Messaging from a Standalone Claude Code Session

If you run Claude Code outside FastAF but still want to use TUIC messaging:

1. **Connect to TUIC's MCP server** — the MCP channel is a Unix socket (Windows: named
   pipe), reached through the `tuic-bridge` stdio adapter, **not** a TCP port. FastAF
   auto-installs this entry into each supported agent's config; to add it by hand:
   ```json
   {
     "mcpServers": {
       "tuicommander": {
         "command": "tuic-bridge",
         "args": []
       }
     }
   }
   ```
   The bridge finds the socket via `TUIC_SOCKET` → `mcp.sock` → any `mcp-*.sock` in the
   config dir.

2. **Register identity** — omit the UUID for a generated identity scoped to this MCP connection:
   ```text
   agent action=register name="external-reviewer" path="/path/to/repo"
   ```
   Pass `tuic_session="<stable-uuid>"` instead when a future reconnect must reclaim the same identity.
   Registration never creates a PTY.

3. **Enable channel push** *(optional, for real-time delivery)*:
   ```bash
   claude --dangerously-load-development-channels server:tuicommander
   ```


### Messaging vs Claude Code Native SendMessage

| Feature | TUIC Messaging | CC Native SendMessage |
|---------|---------------|----------------------|
| **Transport** | MCP tool call → server-side routing | File append + polling (`~/.claude/teams/`) |
| **Real-time push** | Managed terminal wake or external MCP channel notification | No (polling only) |
| **Cross-app** | Any MCP client can participate | Claude Code processes only |
| **Discovery** | `list_peers` with path filter | Team config file |
| **Persistence** | In-memory ring buffer (lost on TUIC restart) | Files on disk (survives restart) |

Both systems work simultaneously. Claude Code agents spawned by FastAF can use either or both.

## Deprecated: it2 Shim

Earlier versions of FastAF used an `it2` shell script shim that emulated iTerm2's CLI to intercept teammate creation. This approach is deprecated — teammate spawning now uses direct MCP tool calls (`agent spawn`). The shim at `~/.tuicommander/bin/it2` is no longer needed.

### Teams across configured remote connections

Desktop MCP peer discovery returns a connection-qualified `address` for every
remote peer. Use this address for mail instead of assuming a terminal alias is
globally unique. Mail reaches the owning daemon's native inbox and wake path;
remote replies and remote-to-remote messages pass through the desktop hub.
The mail link grants no remote spawn capability.

## Independent result readers

Use `agent action=subscribe subscription_id=pump filter=actionable` when a
coordinator and a watcher must not consume each other's mail. Read with
`agent action=inbox subscription_id=pump` or use the continuous HTTP SSE stream
`/agent/subscriptions/pump/events` with the bound `Mcp-Session-Id` header.
Routine lifecycle/idle messages do not wake this reader; peer RESULT/BLOCKED mail,
exits and failures remain actionable. Each batch has a cursor and has_more.
Process it, then call `agent action=ack subscription_id=pump cursor=<cursor>`.
Unacknowledged batches can replay after interruption, so deduplicate effects by
message ID. Acknowledged mail does not replay after reconnect with the same peer
UUID and subscription ID. The newest 1000 messages per peer survive restart;
missed_count reports matching unacknowledged retention losses. Use a different
subscription ID for each consumer. Legacy inbox readers keep their old cursor.

An ACP consumer can subscribe to `tuic://inbox/subscriptions/pump` for filtered
resource updates and idle wakes without a model wait loop. See the complete
[mail contract](../backend/mcp-http.md#durable-independent-mail-subscriptions)
for acknowledgement, retention, reader limits and HTTP transport details.
