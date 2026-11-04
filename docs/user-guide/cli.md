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
Install and update stage the new executable beside the installed path, then rename it into place. A running `fastaf` process keeps its original executable; installing over a symlink replaces the link without changing its target.
The CLI status check probes the install directory with a temporary sibling file. It does not open the installed executable for writing: on macOS, even a write-open without changed bytes can invalidate its cached signature.

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

A directory lands in the sidebar and becomes the active repo. `fastaf <dir>` and `fastaf open <dir>` call the selected running server over local IPC through MCP `repo action=add`; development builds need no registered OS URL handler. Registration is explicit and takes effect immediately, without a confirmation dialog or a connected desktop window. Reopening preserves existing workspaces, terminals, names and groups. Registration does not create a terminal; use `fastaf new` for a shell. Server errors produce a nonzero exit code.

### Temporary directories are refused

`fastaf <dir>` registers the directory **permanently** — the sidebar keeps it across restarts. A temporary directory therefore becomes a row that points at something the operating system later deletes, and nothing records who added it. `fastaf` refuses such a path instead:

```
$ fastaf "$TMPDIR/scratch"
Refusing to register "/var/folders/.../T/scratch" as a repository: it is inside a
temporary directory, which the OS deletes while the sidebar entry stays behind forever.
For a shell there instead: fastaf new /var/folders/.../T/scratch
```

A path is refused when it is at or below the temp root of **the shell you run `fastaf` from** (`TMPDIR` on macOS and Linux, `TEMP`/`TMP` on Windows) or below `/tmp`. Running the check in the CLI rather than in the app is what makes a custom `TMPDIR` — for example the `~/Gits/.tmp` this repository's Rust suites use — count as temporary; the app process has a different one and cannot see yours.

Only registration is refused. `fastaf new <dir>` still opens a shell in a temporary directory, because a session is disposable in the same way the directory is.

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

`capture` supports `raw` and `text`; `--format log` is not supported by the
CLI and returns an error.

# Kill a session
fastaf kill <id-or-name>

# Resize a session
fastaf resize <id-or-name> 120x40

# Pause/resume output
fastaf pause <id-or-name>
fastaf resume <id-or-name>
```

Session targets are resolved by the server. Use the PTY ID, its stable
`tuic_session`, the terminal alias (for example `tu-33`), a unique short PTY-ID
prefix, or a unique display name; an ambiguous target is rejected rather than
guessed.

### Sending keys

Each argument is either a **key name** or **literal text** — matched whole, never as a substring, so `fastaf send build "Enter the room"` types the sentence instead of pressing Return mid-word. Adjacent literals are joined with a single space.

Key names: `Enter`, `Space`, `Tab`, `Escape`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, and any `C-<letter>` (`C-c`, `C-d`, `C-u`, …).

## Agent Orchestration

### Generic MCP calls

Use `fastaf mcp <tool> [<json>|-]` to call a native MCP tool over the local
socket. Omit the JSON argument for `{}`, or pass `-` to read a JSON object from
stdin. The tool's text payload is printed unchanged with a trailing newline,
so it can be piped to `jq`:

```bash
fastaf mcp session '{"action":"list"}' | jq length
fastaf mcp agent '{"action":"wait","timeout_ms":8000}'
cat <<'JSON' | fastaf mcp agent -
{"action":"send","to":"peer-id","message":"it's ready"}
JSON
```

Tool and protocol errors go to stderr with exit code 1. Invalid JSON or CLI
arguments exit 2 before connecting. Managed callers send `$TUIC_SESSION` for
peer binding; callers outside FastAF register an external identity for
that invocation.

### Workflow actions

`fastaf workflow [<json>|-]` calls the grouped `workflow` MCP tool. Use a typed action envelope:

```bash
fastaf workflow '{"action":"story","input":{"action":"list_plans"}}'
fastaf workflow '{"action":"run","input":{"action":"get","run_id":"run-id"}}'
```

The other actions are `proposal_create`, `report` and `launch`, each with its typed payload under `input`. Proposal creation requires the run's active bound coordinator and a stable `proposalKey`; retries return the same story. Ordinary story creation is not a substitute. Managed callers retain their caller binding. `fastaf story` still calls the shared story service with `--project` support; `fastaf automations` still calls the separate scheduler and works when `workflow` is disabled. The old workflow MCP names are removed without aliases. Reconnect after installing the updated backend to discover the new tool.

Register an existing local directory directly through MCP:

```bash
fastaf mcp repo '{"action":"add","path":"/absolute/path/to/project"}'
```

Both forms use the same backend registration operation. Git directories get a
workspace for their checked-out branch; plain directories get a shell workspace.
`ui action=tab` with a `tuic://open-repo` URL returns an error directing the caller
to `repo action=add`.

### Detached commands

Run `fastaf bg <log> -- <cmd> [args...]` from a managed terminal to return at
once while the command runs in a separate process group. The command's stdout
and stderr append to `<log>`, after a header with the full command, and its exit
code is written to `<log>.exit`. When it finishes, `fastaf` requests a
`BG DONE exit=<code> log=<log> cmd=…` wake for the originating session.
The `cmd` label contains only the first line and at most 120 Unicode characters,
including a final `…` when text is omitted. Read the log header for the full command. If that session is busy, the wake is queued
until it becomes idle. `<log>.wake` records the request outcome as JSON:
`queued`, `mailed`, `retrying`, or `failed`, with `tuic_session` and the number
of queue attempts. A queue lookup or request failure falls
back to MCP agent mail addressed to the same `TUIC_SESSION`; that mail includes
the `BG DONE` text and the queue error. `queued` means the queue took the
request, not that the agent later submitted it. `mailed` means the mail was
surfaced to the caller; inbox-only mail remains a failure. If both paths fail
after a transient socket error or server error, the runner retries up to six
queue-then-mail attempts with exponential delays of 0.2–3.2 seconds (6.2
seconds of total retry waiting). A permanent queue rejection ends the retry
immediately after mail fails. `retrying` records an attempt still in progress;
`failed` records the last queue and mail errors. Each IPC read has its own
three-second deadline, so a slow or unavailable server can extend the elapsed
time beyond the retry waiting period. The command works
on macOS, Linux, and Windows.

```bash
fastaf bg "$HOME/Gits/.tmp/build.log" -- make check
```

The detached command does not inherit `TUIC_SESSION` or `TUIC_PARENT`. It is
not the foreground peer: `TUIC_BG_COMMAND=1` marks the command tree as an
ancestry boundary, including when an agent scrubs its bridge environment. Its progress reports and agent hooks must not change
the foreground composer state. The runner retains the original caller identity
for completion queueing and mail. Socket, app-instance and other environment
settings remain inherited. A command that needs a peer identity must establish
its own binding instead of using the foreground caller.

On Windows, the detached runner does not inherit the launcher's input or output pipes. Capturing the launcher output therefore returns before the background command completes.

Each background runner generates one completion key and reuses it on queue
retries. The backend remembers the last 128 accepted keys per live terminal,
so a lost reply does not enqueue the same completion again within that window.
A recognized acceptance remains `queued` in the wake file even after the queue
has drained. If every queue receipt is lost and mail also fails, the wake file
reports `uncertain`, not a proven delivery failure; inspect backend state before
retrying manually. `uncertain` also prevents automatic child closure.

If a BG DONE entry remains in the backend queue for 60 seconds, the backend
records one warning under source `bg-wake`. Read `/logs?source=bg-wake` on the
owning instance. Its JSON data reports the composer, question, uncertainty and
foreground gates, process-probe generations, and a fresh process tree for the
foreground group and matching detached runner. It records at most 128 process
rows, marks truncation, and distinguishes an unavailable inventory from an empty
tree. It excludes argv, prompt text and environment values. This warning uses
the normal bounded log ring, not durable delivery storage; collect it before
ring overflow or restart. It does not retry a possibly submitted message or
clear `background_work`.

`TUIC_SESSION` is required; without it, `fastaf bg` exits 2 before starting a
command. The launcher prints the wake-status path and removes stale `.exit`
and `.wake` files before detaching. If no `BG DONE` arrives, inspect `.exit`
for command completion and `.wake` for both queue and mail failures. Both
errors are also appended to the log. Neither status file can start a new agent
turn while FastAF is unavailable.

The instance config directory also holds `bg-wakes/<TUIC_SESSION>.json`. It is
marked `retrying` while a background command is active or its wake is being
retried, then records the final result. Automatic managed-child idle closure
reads this record and keeps a child open after a failed wake.

```bash
# Spawn an AI agent (the prompt is required — the agent starts on it)
fastaf agent spawn claude "review the failing tests"
fastaf agent spawn codex "add a changelog entry" --repo /path/to/repo
fastaf agent spawn codex "review" --name reviewer --model gpt-5 --args exec --args --full-auto \
  --cwd /path/to/repo --rows 40 --cols 120 --json

# List running agents
fastaf agent ls

# Deliver a message to a registered peer's INBOX (peer registry)
fastaf agent send <peer-uuid> "fix the tests"

# Type a prompt into an agent's TERMINAL and submit it (no peer routing)
fastaf agent type <id-or-name> "fix the tests"

# Wait for mail or inspect peers without polling
fastaf agent wait --timeout-ms 60000 --json
fastaf agent inbox --json
fastaf agent list-peers --path /path/to/repo --json
fastaf agent stats --json

# Server-owned session state and output
fastaf session status <id-or-name> --json
fastaf session wait <id-or-name> --until idle --timeout-ms 60000 --json
fastaf session output <id-or-name> --limit 50 --json

# Server-owned worktree lifecycle
fastaf repo worktree-list /path/to/repo --json
fastaf repo worktree-create /path/to/repo --branch feature/task --spawn-session --json
fastaf repo worktree-remove /path/to/repo <branch> --json
```

`agent wait` and `session wait` size their IPC read timeout from `--timeout-ms`
(60 seconds by default) with a five-second transport margin. MCP worktree
creation and removal allow 305 seconds on Unix, four seconds beyond the server's
301-second request limit. Other Unix CLI requests retain a three-second read
timeout, so a stalled app fails promptly. A timed-out MCP action may still
complete on the server; inspect its state before retrying.

The orchestration commands above call the same MCP tools as an agent. They use
the local `mcp.sock` transport and send `$TUIC_SESSION` as `x-tuic-session`, so
a child spawned from a managed terminal records that terminal as its parent.
Outside FastAF, `fastaf` prints one notice and registers a headerless
external MCP caller. That caller is the parent of a child it spawns, but its
identity lasts only for that `fastaf` invocation, so a later `fastaf` call cannot
read the mail the child sends back.
Use `--json` for the unmodified server payload. A server error is printed to
stderr and makes `fastaf` exit non-zero.

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
after a `Buffered` line. The CLI validates this current report contract through
`message_id`, `delivered`, and `delivery_path`; it does not require the removed
`accepted` compatibility field.

`fastaf agent type` keeps the agent-safe framing: the text and the Enter are sent
as **separate** PTY writes, because a raw-mode Ink TUI treats a combined
`text\r` as a prefill and leaves it unsent. `fastaf send` does not do this.

`fastaf agent send` uses `$TUIC_SESSION` when it runs inside a FastAF
session. Outside one, it registers a headerless external caller for the MCP
connection and prints a notice on stderr. It has no terminal, automatic wake-up,
or managed parent relationship; a spawned child cannot reply to it.

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
- **macOS/Linux:** Unix domain socket at `<platform config dir>/com.tuic.commander/mcp.sock` for the default instance.
- **Windows:** Named pipe at `\\.\pipe\tuicommander-mcp`

Use `fastaf --instance <id> <command>` or `TUIC_APP_INSTANCE=<id> fastaf <command>`
to select the same namespace as `tuic-remote --instance <id>`. An explicit
`--instance` takes precedence over the environment. Invalid ids fail before any
connection. Named Unix sockets use the server's short SHA-256-based name in the OS
temp directory. The bridge accepts `tuic-bridge --instance <id>` and the same
environment variable; it searches only that instance's alternative sockets.

On Unix, `TUIC_SOCKET` overrides the selected socket path. Windows retains the
existing named-pipe endpoint. The clients and server share instance validation,
config paths and IPC names through `tuic-ipc`; CLI and bridge also share HTTP
request and response framing.

If FastAF is not running, `fastaf open` and `fastaf new` will launch it automatically.

## Automations

`fastaf automations` accepts a backend action JSON object. It uses the selected
instance's MCP endpoint and the same validation, results and errors as HTTP/IPC.

```bash
fastaf automations '{"action":"list"}'
fastaf automations '{"action":"update","id":"review","enabled":false}'
fastaf automations '{"action":"run_now","id":"review"}'
fastaf automations '{"action":"list_runs","id":"review","limit":10}'
fastaf --instance staging automations '{"action":"summary","window":"7d"}'
cat definition-action.json | fastaf automations -
```

Actions: list, get, create, update, pause, resume, delete, run_now, run, list_runs,
summary, preview, preview_definition and preset. See the HTTP API Automations
table for the shared input/result shapes. Create and update accept a complete
definition; update also accepts id and enabled instead. Creation records the
bound caller session, including an external MCP identity when run outside TUIC.
Success prints JSON; backend rejection prints its exact message after `fastaf:`
on stderr and exits 1. Invalid CLI JSON exits 2.

Automation templates (#1622-be11): the shared automation action accepts
**templates** (catalogue) and **template** (draft). Draft inputs are template_id,
repository, run_config and optional timezone (host local by default).
Drafts have fresh ids and start disabled; no definition or run is created until
an explicit create action. These actions match across HTTP, IPC, MCP and CLI.

### Design Mode through MCP UI actions

Use `fastaf mcp ui '{"action":"design_start","session_id":"<terminal>","url":"http://localhost:3000"}'` to start Design Mode. Browser commands use `design_stop`, `design_reload`, `design_navigate`, `design_screenshot`, `design_errors` or `design_eval` with `repo_path` from the lifecycle result; `design_navigate` also needs `url`, and `design_eval` needs `script`. `design_status` lists bindings for an armed caller. Caller ownership and extension host grants still apply. The old `fastaf mcp design_mode` entry is removed with no alias. Also replace literal task calls with `fastaf mcp agent` task_get/task_cancel, and story/workflow_* calls with `fastaf workflow` and its typed actions. Reconnect cached MCP clients and review external allow rules for the grouped domains.
