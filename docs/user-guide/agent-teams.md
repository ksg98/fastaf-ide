# Agent Teams

Agent Teams let Claude Code spawn teammate agents that work in parallel, each in its own fastestAF terminal tab. Teammates share a task list, communicate directly with each other, and coordinate autonomously.

## How It Works

fastestAF automatically injects `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` into every PTY session. This unlocks Claude Code's `TeamCreate`, `TaskCreate`, and `SendMessage` tools. When Claude Code spawns a teammate, fastestAF creates a new terminal tab via its MCP `agent spawn` tool — no external dependencies required.

## Setup

No configuration needed. Agent Teams is enabled by default for all Claude Code sessions launched from fastestAF.

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

Claude Code handles team creation, task assignment, and coordination. Each teammate appears as a separate tab in fastestAF's sidebar.

### Navigating Teammates

Claude Code supports two display modes for teammates:

| Mode | How it works | Requirement |
|------|-------------|-------------|
| **In-process** | All teammates run inside the lead's terminal. Use `Shift+Down` to cycle between them. | None |
| **Split panes** | Each teammate gets its own pane. | tmux or iTerm2 |

fastestAF works with both modes. In-process mode is the default and requires no extra setup. With split panes, each teammate appears as a separate fastestAF tab.

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
- Check that fastestAF's MCP server is running (status bar shows the MCP icon)

**Teammates not spawning at all:**
- Claude Code decides whether to create a team based on task complexity. Be explicit: "Create an agent team with N teammates"
- Check Claude Code version: Agent Teams requires a recent version

**Too many permission prompts:**
- Pre-approve common operations in Claude Code's permission settings before spawning teammates

## Inter-Agent Messaging

fastestAF includes a built-in messaging system that lets agents in different terminal tabs communicate directly. This works alongside (and independently from) Claude Code's native Agent Teams messaging.

### How It Works

Every PTY session gets a stable `TUIC_SESSION` UUID injected as an environment variable. Agents use this as their identity to register, discover peers, and exchange messages through fastestAF's MCP `messaging` tool.

When both sender and recipient are connected via SSE (the default for Claude Code agents), messages are **pushed in real-time** as MCP channel notifications (`notifications/claude/channel`). They also land in a buffered inbox as a fallback.

### What Gets Injected Automatically

fastestAF injects these into every Claude Code PTY session — no manual configuration needed:

| Variable / Flag | Value | Purpose |
|---|---|---|
| `TUIC_SESSION` | Stable UUID per tab | Agent identity for messaging |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Unlocks TeamCreate/TaskCreate/SendMessage |
| `--dangerously-load-development-channels server:tuicommander` | *(CLI flag, agent spawn only)* | Enables real-time channel push from fastestAF |

### Messaging Flow

> **Identity is automatic.** The bridge asserts your `$TUIC_SESSION` at connect
> (`x-tuic-session` header → server auto-bind), so an agent spawned inside fastestAF
> is already a registered peer. `agent action=register` is only needed to set a friendly
> name/project, or from a standalone session where the env-var route is unavailable.

> **Prefer blocking waits over polling.** `agent action=wait since=<ms>` returns as soon
> as new mail arrives; `session action=wait session_id=<id> until=idle|exited` blocks on a
> peer's lifecycle. Both cap at 8 s and return `{met, timed_out}` — on `timed_out` just call
> again. Incoming messages are also **typed into an idle peer's terminal**, so a waiting
> orchestrator is woken by its children without any poll loop.

1. **Register** *(optional — sets name/project)* — the agent reads its `$TUIC_SESSION`:
   ```
   agent action=register tuic_session="$TUIC_SESSION" name="worker-1" project="/path/to/repo"
   ```

2. **Discover peers** — Find other agents connected to fastestAF:
   ```
   agent action=list_peers
   agent action=list_peers project="/path/to/repo"   # filter by repo
   ```

3. **Send a message** — Address by the recipient's `tuic_session` UUID:
   ```
   agent action=send to="<recipient-tuic-session>" message="PR review done, 3 issues found"
   ```

4. **Check inbox** — Read buffered messages (useful if channel push was missed):
   ```
   agent action=inbox
   agent action=inbox limit=10 since=1712000000000
   ```

### Channel Push vs Inbox

| Delivery | When | Latency | Requires |
|----------|------|---------|----------|
| **Channel push** | Recipient has active SSE stream | Real-time | `--dangerously-load-development-channels server:tuicommander` on the recipient's CC process |
| **Inbox buffer** | Always | Poll-based | Registration only |

Messages are always buffered in the inbox regardless of whether channel push succeeds. The inbox holds up to 100 messages per agent (FIFO eviction). Individual messages are capped at 64 KB.

### Using Messaging from a Standalone Claude Code Session

If you run Claude Code outside fastestAF but still want to use TUIC messaging, you need to:

1. **Set `TUIC_SESSION`** — export a stable UUID:
   ```bash
   export TUIC_SESSION=$(uuidgen)
   ```

2. **Connect to TUIC's MCP server** — the MCP channel is a Unix socket (Windows: named
   pipe), reached through the `tuic-bridge` stdio adapter, **not** a TCP port. fastestAF
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
   config dir. It reads `$TUIC_SESSION` from its environment and forwards it as the
   `x-tuic-session` header, so identity binds automatically on connect.

3. **Enable channel push** *(optional, for real-time delivery)*:
   ```bash
   claude --dangerously-load-development-channels server:tuicommander
   ```

4. **(Optional) register a name** — identity auto-binds from `$TUIC_SESSION`; call
   `agent action=register` only to set a display name/project.

### Messaging vs Claude Code Native SendMessage

| Feature | TUIC Messaging | CC Native SendMessage |
|---------|---------------|----------------------|
| **Transport** | MCP tool call → server-side routing | File append + polling (`~/.claude/teams/`) |
| **Real-time push** | Yes (MCP channel notifications) | No (polling only) |
| **Cross-app** | Any MCP client can participate | Claude Code processes only |
| **Discovery** | `list_peers` with project filter | Team config file |
| **Persistence** | In-memory ring buffer (lost on TUIC restart) | Files on disk (survives restart) |

Both systems work simultaneously. Claude Code agents spawned by fastestAF can use either or both.

## Deprecated: it2 Shim

Earlier versions of fastestAF used an `it2` shell script shim that emulated iTerm2's CLI to intercept teammate creation. This approach is deprecated — teammate spawning now uses direct MCP tool calls (`agent spawn`). The shim at `~/.tuicommander/bin/it2` is no longer needed.
