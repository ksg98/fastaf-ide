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
- Check that FastAF's MCP server is running (status bar shows the MCP icon)

**Teammates not spawning at all:**
- Claude Code decides whether to create a team based on task complexity. Be explicit: "Create an agent team with N teammates"
- Check Claude Code version: Agent Teams requires a recent version

**Too many permission prompts:**
- Pre-approve common operations in Claude Code's permission settings before spawning teammates

## Inter-Agent Messaging

FastAF includes a built-in messaging system that lets agents in different terminal tabs communicate directly. This works alongside (and independently from) Claude Code's native Agent Teams messaging.
There is no separate `swarm` action: callers compose the `agent` and `session` primitives documented below.

### How It Works

Every PTY session gets a stable `TUIC_SESSION` UUID injected as an environment variable. Agents use this as their identity to register, discover peers, and exchange messages through FastAF's MCP `messaging` tool.

When a channel-enabled Claude Code recipient is connected via SSE and already working, messages are **pushed in real-time** into that turn as MCP channel notifications (`notifications/claude/channel`). Idle or completed managed agents use terminal submission to start a real next turn; managed non-Claude agents do the same even when their MCP bridge has an SSE stream. Every message also lands in a buffered inbox as a fallback.

### What Gets Injected Automatically

FastAF injects these into every Claude Code PTY session — no manual configuration needed:

| Variable / Flag | Value | Purpose |
|---|---|---|
| `TUIC_SESSION` | Stable UUID per tab | Agent identity for messaging |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Unlocks TeamCreate/TaskCreate/SendMessage |
| `--dangerously-load-development-channels server:tuicommander` | *(CLI flag, agent spawn only)* | Enables real-time channel push from FastAF |

### Messaging Flow

> **Identity is automatic.** The bridge asserts your `$TUIC_SESSION` at connect
> (`x-tuic-session` header → server auto-bind), so an agent spawned inside FastAF
> is already a registered peer. `agent action=register` is only needed to set a friendly
> name/project, or from a standalone/external session where the env-var route is unavailable.
> External MCP clients do not need a plain-shell identity tab: call `agent action=register`
> without `tuic_session` to receive an MCP-scoped UUID, or supply an explicit UUID when the same
> identity must be reclaimed after reconnect.

> **Prefer blocking waits over polling.** `agent action=wait since=<ms>` returns as soon
> as new mail arrives; `session action=wait session_id=<id> until=idle|exited` blocks on a
> peer's lifecycle. Both default to 60 seconds, cap at 300000 ms, and return
> `{met, timed_out}`. They are event-driven end to end; the bridge deadline follows the
> requested wait instead of its ordinary ten-second timeout. A successful agent wait also returns every retained fresh message (up to the
> 100-message inbox capacity) and a per-recipient logical `next_since` cursor, so the normal path
> needs no separate inbox call. Incoming messages are also **typed into an idle peer's terminal**, so a waiting
> orchestrator is woken by its children without any poll loop.

1. **Register** *(optional — sets name/project)* — the agent reads its `$TUIC_SESSION`:
   ```
   agent action=register tuic_session="$TUIC_SESSION" name="worker-1" project="/path/to/repo"
   ```

2. **Discover peers** — Find other agents connected to FastAF:
   ```
   agent action=list_peers
   agent action=list_peers project="/path/to/repo"   # filter by repo
   ```

3. **Send a message** — Address by the recipient's `tuic_session` UUID:
   ```
   agent action=send to="<recipient-tuic-session>" message="PR review done, 3 issues found"
   ```

4. **Wait for and receive messages** — one blocking call returns the message bodies:
   ```
   agent action=wait since=1712000000000
   ```
   Pass the returned `next_since` to the next wait.

5. **Check inbox directly** — useful after a reported FIFO eviction or if channel push was missed:
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
| **Channel push** | Recipient has active SSE stream | Real-time | `--dangerously-load-development-channels server:tuicommander` on the recipient's CC process |
| **Inbox buffer** | Always | Poll-based | Registration only |

Messages are always buffered in the inbox regardless of whether channel push succeeds. The inbox holds up to 100 messages per agent (FIFO eviction). Individual messages are capped at 64 KB.

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
   agent action=register name="external-reviewer" project="/path/to/repo"
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
| **Real-time push** | Yes (MCP channel notifications) | No (polling only) |
| **Cross-app** | Any MCP client can participate | Claude Code processes only |
| **Discovery** | `list_peers` with project filter | Team config file |
| **Persistence** | In-memory ring buffer (lost on TUIC restart) | Files on disk (survives restart) |

Both systems work simultaneously. Claude Code agents spawned by FastAF can use either or both.

## Deprecated: it2 Shim

Earlier versions of FastAF used an `it2` shell script shim that emulated iTerm2's CLI to intercept teammate creation. This approach is deprecated — teammate spawning now uses direct MCP tool calls (`agent spawn`). The shim at `~/.tuicommander/bin/it2` is no longer needed.
