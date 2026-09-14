# fastaf CLI

The `fastaf` command line tool lets you control FastAF from the terminal. It combines the best of VS Code's `code` CLI, Zed's editor integration, and tmux's session management into a single binary.

## Installation

**From the app:** Settings > General > Command Line Interface > Install fastaf CLI

**First launch:** FastAF offers to install the CLI on first run.

**From the CLI itself:** `fastaf install-cli`

The binary is installed to:
- **macOS:** `/usr/local/bin/fastaf` (requires admin password)
- **Linux:** `/usr/local/bin/fastaf` (requires sudo)
- **Windows:** `%LOCALAPPDATA%\Microsoft\WindowsApps\fastaf.exe` (no admin needed)

The CLI auto-updates silently when FastAF starts — no manual update needed.

## Opening Files and Repos

```bash
# Open a file (launches FastAF if not running)
fastaf file.rs

# Open at specific line and column
fastaf file.rs:42
fastaf file.rs:42:10
fastaf open --goto file.rs:42

# Open the current directory as a repo (adds it to the sidebar and activates it)
fastaf .
fastaf /path/to/project

# Open with --wait (for use as $EDITOR)
fastaf open --wait file.rs

# Diff two files
fastaf diff old.rs new.rs
```

A directory is treated as a **repo**, not as a terminal: it lands in the sidebar and becomes the active repo. A folder FastAF does not know yet is confirmed once in the app before it is added — after that, `fastaf .` activates it silently. Use `fastaf new` when what you want is a shell.

### Using as $EDITOR

```bash
export EDITOR="fastaf open --wait"
git commit  # opens commit message in FastAF
```

## Session Management

These commands mirror tmux semantics:

```bash
# List all sessions (short IDs; --json for scripts)
fastaf ls
fastaf ls --json

# Create a new session
fastaf new
fastaf new -n "my-session"
fastaf new -n "build" /path/to/repo

# Create a session and run something in it
fastaf run pnpm dev
fastaf run -n "tests" cargo nextest run

# Send input to a session
fastaf send <id-or-name> "make test" Enter

# Capture session output
fastaf capture <id-or-name>
fastaf capture <id-or-name> -n 50          # last 50 lines
fastaf capture <id-or-name> --format raw

# Kill a session
fastaf kill <id-or-name>

# Resize a session
fastaf resize <id-or-name> 120x40

# Pause/resume output
fastaf pause <id-or-name>
fastaf resume <id-or-name>
```

Session targets accept full UUIDs, ID prefixes (the short ID `fastaf ls` prints), exact names, or a name prefix — case-insensitive. An ambiguous target is rejected rather than guessed.

### Sending keys

Each argument is either a **key name** or **literal text** — matched whole, never as a substring, so `fastaf send build "Enter the room"` types the sentence instead of pressing Return mid-word. Adjacent literals are joined with a single space.

Key names: `Enter`, `Space`, `Tab`, `Escape`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, and any `C-<letter>` (`C-c`, `C-d`, `C-u`, …).

## Agent Orchestration

```bash
# Spawn an AI agent (the prompt is required — the agent starts on it)
fastaf agent spawn claude "review the failing tests"
fastaf agent spawn codex "add a changelog entry" --repo /path/to/repo

# List running agents
fastaf agent ls

# Deliver a message to a registered peer's INBOX (peer registry)
fastaf agent send <peer-uuid> "fix the tests"

# Type a prompt into an agent's TERMINAL and submit it (no peer routing)
fastaf agent type <id-or-name> "fix the tests"
```

### Two delivery channels, chosen explicitly

`fastaf agent send` and `fastaf agent type` are not interchangeable, and neither
guesses which one you meant.

| Command | Route | Target | Use when |
|---|---|---|---|
| `fastaf agent send` | peer registry → recipient inbox | a **registered peer's** `tuic_session` UUID | the recipient is an orchestrator or any peer, including one with no terminal of its own |
| `fastaf agent type` | PTY write | a session **ID or name** | you want the text to appear in a terminal and be submitted |
| `fastaf send` | PTY write | a session ID or name | raw keys, no agent framing (see *Sending keys*) |

`fastaf agent send` is the CLI counterpart of the MCP `agent action=send` tool and
uses the same delivery path, so both report the same `delivery_path` and both
land the payload exactly once. It exits non-zero — with the registry's own
message — when the recipient is not registered or the message is empty.

Acceptance is not delivery, and the output says which one you got:

```
Delivered to <peer> (sse_channel_and_inbox)
```

means something surfaced the message — a waiter, the SSE channel, or the
recipient's terminal. Whereas:

```
Buffered for <peer> (inbox_only) — unread until the recipient polls its inbox
warning: Recipient has NO terminal and no active wait: nothing will wake it. …
```

means the registry took the message but nothing will wake the recipient: it sits
unread until that peer calls `agent action=wait`/`inbox`. Both exit 0, because
the registry accepted the message in both cases — do not block on an answer
after a `Buffered` line.

`fastaf agent type` keeps the agent-safe framing: the text and the Enter are sent
as **separate** PTY writes, because a raw-mode Ink TUI treats a combined
`text\r` as a prefill and leaves it unsent. `fastaf send` does not do this.

`fastaf agent send` must run inside a FastAF session (it reads
`$TUIC_SESSION` to identify the sender). It binds that identity when it is free;
when the agent in that pane is itself connected over MCP it already owns the
identity, so the CLI registers an anonymous sender named `<session> (cli)`
rather than stealing a live binding.

## tmux Compatibility

`fastaf` can act as a drop-in replacement for tmux. When invoked as `tmux` (via symlink), it translates tmux commands to FastAF equivalents.

### Setting Up the Alias

```bash
# Create tmux -> fastaf symlink
fastaf alias

# Remove the alias (restores original tmux if installed)
fastaf alias --remove
```

### Supported tmux Commands

When invoked as `tmux`, the following commands are supported:

| tmux Command | Behavior |
|---|---|
| `tmux` | Create new session in cwd |
| `tmux new-session -s name` | Create named session |
| `tmux list-sessions` | List sessions |
| `tmux kill-session -t target` | Kill session |
| `tmux kill-server` | Kill all sessions |
| `tmux send-keys -t target "cmd" Enter` | Send input |
| `tmux capture-pane -t target` | Capture output |
| `tmux resize-pane -t target -x 120 -y 40` | Resize |
| `tmux attach-session` | Focus FastAF window |
| `tmux has-session -t target` | Check if session exists (exit code) |

Key names are translated: `Enter`, `Space`, `Tab`, `Escape`, `C-c`, `C-d`, `C-z`, etc.

## System Commands

```bash
# Check FastAF status — version, session/agent counts, and which
# sessions are waiting on you right now
fastaf status

# Install CLI to system PATH
fastaf install-cli
fastaf install-cli --path /custom/path

# Create/remove tmux alias
fastaf alias
fastaf alias --remove
```

## IPC Architecture

The CLI communicates with FastAF via IPC:
- **macOS/Linux:** Unix domain socket at `~/.config/com.fastaf.ide/mcp.sock`
- **Windows:** Named pipe at `\\.\pipe\tuicommander-mcp`

Override with `$TUIC_SOCKET` environment variable.

If FastAF is not running, `fastaf open` and `fastaf new` will launch it automatically.
