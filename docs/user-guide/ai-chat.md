# AI Chat

AI Chat is a conversational AI companion that lives next to your terminals and sees what they see. Unlike spawning a full agent (Claude Code, Aider, …) in a PTY, the chat panel gives you a quick explain / summarise / suggest loop that shares the exact screen state of your active terminal.

Two progressive capability levels ride on the same panel:

| Level | What it does |
|-------|--------------|
| **Chat** (default) | Streaming Q&A with terminal context injection. You ask, the model sees the last N lines, replies in markdown. "Run this" and "Copy" on every code block. |
| **Agent** (ReAct loop) | The model *acts*: it reads the screen, sends input/keys, waits for patterns, asks for approval before destructive commands. Pause / resume between iterations. Built on six tools exposed both internally and as `ai_terminal_*` MCP tools. |

The same panel switches modes — no separate UI.

## Opening the panel

- **Hotkey:** `Cmd+Alt+A` (macOS) / `Ctrl+Alt+A` (others) — toggle.
- **Title bar:** chat icon at the right end of the title bar.
- **Context menu:** right-click a terminal → *Send selection to AI Chat* or *Explain this error*.

The panel docks on the right. Drag its left edge to resize it; the width applies
for the session and is not persisted across restarts.

### Detaching it into its own window

Click the detach icon in the header to move the chat into a separate 500x700
window. The main window shows a *Bring back* placeholder until you reattach or
close the detached one.

The detached window is a full chat, not a viewer: it opens on the conversation
you detached, and it sends, runs the agent, and pauses or stops it against the
terminal it was detached from. It stays on that terminal for its whole life — if
you focus a different terminal in the main window, the detached chat does not
follow. Detach with no terminal focused and the window is read-only, exactly as
the docked panel is.

The two windows hand the conversation over through disk; they are not linked
live. While both are open, neither sees what the other adds. When the detached
window closes or reattaches, the main window re-reads the conversation, so the
messages you sent from it are there.

One action does not work in the detached window: *Run* on a code block. It needs
the terminal's live view, which cannot cross a window boundary.

## Providers

AI Chat speaks to four provider families plus a custom endpoint. Add and configure them in `Settings > Providers`; pick the chat model in the panel's composer or through the Main slot:

| Provider | Default base URL | Notes |
|----------|------------------|-------|
| **Ollama** (local) | `http://localhost:11434/v1/` | Auto-detected — the settings tab shows live status and the model list pulled from `GET /api/tags`. No API key required. |
| **Anthropic** | `https://api.anthropic.com` | Direct Messages API. API key from Anthropic console. |
| **OpenAI** | `https://api.openai.com/v1` | Chat Completions. |
| **ChatGPT (sign in)** | *(none — loopback)* | Your ChatGPT Plus/Pro/Team plan instead of an API key. See [Sign in with ChatGPT](#sign-in-with-chatgpt). |
| **OpenRouter** | `https://openrouter.ai/api/v1` | Single key, many models. |
| **Custom** | *(editable)* | Any OpenAI-compatible endpoint. |

### Model recommendations

| Use case | Local (Ollama) | API |
|---|---|---|
| Enrichment / triage | Qwen 2.5 Coder 3B (Q4_K_M) | Haiku, GPT-4o-mini |
| Explain output, quick Q&A | Qwen 2.5 7B, Llama 3.3 8B | Haiku, GPT-4o-mini |
| Generate commands, review diffs | Qwen3-Coder 14B | Sonnet, GPT-4o |
| Agent loop (tool calling) | DeepSeek R1 32B, Qwen 27B | Sonnet, Opus |

API keys are stored in the OS keyring under service `tuicommander-ai-chat` — never written to disk in plaintext.

### Sign in with ChatGPT

1. `Settings > Providers > + Add`, type **ChatGPT (sign in)**, then **Add**.
2. On the new card, click **Sign in with ChatGPT**. Your browser opens OpenAI's sign-in page. If another program (a Codex login, a local proxy) already holds port 1455, the card shows a code instead — it is copied for you; paste it on the page that opens.
3. When the card reads *Signed in as …*, click **+ Add model**. The list comes live from your plan, with the reasoning levels each model offers.
4. Assign the model to a slot (Main for AI Chat and agents, or Headless for Smart Prompts in API mode, PR review, the changelog and the improvement scan).

The tokens are kept in the OS keychain and refresh themselves. **Sign out** on the card forgets them. Usage counts against your ChatGPT plan's limits, and a limit reached shows up as the model's error message. This rides the same sign-in Codex uses; OpenAI can change or stop third-party access, so keep an API-key provider if you depend on it.

FastAF signs in on its own and never reads Codex CLI's `~/.codex/auth.json`: each refresh replaces the refresh token, so two programs sharing one login would sign each other out.

### Local MLX models (Apple Silicon)

On Apple Silicon Macs, MLX models run natively via the MLX framework and are significantly faster than GGUF models for small inference tasks like enrichment and triage.

**Option A: mlx_lm.server (recommended for enrichment)**

Serves an MLX model with an OpenAI-compatible API. Configure as a Custom provider in TUIC.

```bash
# Install
pipx install mlx-lm

# Start server (port 8899, Qwen 2.5 Coder 3B 4-bit)
mlx_lm.server --model mlx-community/Qwen2.5-Coder-3B-Instruct-4bit --port 8899
```

In `Settings > Providers`, add a **Custom** provider with base URL `http://127.0.0.1:8899/v1/` and model name `mlx-community/Qwen2.5-Coder-3B-Instruct-4bit`. Assign it to the **Triage** slot.

Benchmark (M4): ~120 tok/s generation vs ~98 tok/s for the same model via Ollama GGUF.

**Option B: Ollama with MLX tags**

Some models have native MLX tags on the Ollama registry (e.g. `qwen3.5:4b-mlx-bf16`). These run on Ollama's built-in MLX runner automatically. Check available tags with `ollama pull <model>:<size>-mlx-<dtype>`.

**Option C: MLX → GGUF conversion**

For MLX models without Ollama MLX tags, convert to GGUF and import into Ollama:

```bash
# 1. Download MLX model
pipx run --spec huggingface_hub hf download \
  mlx-community/Qwen2.5-Coder-3B-Instruct-4bit \
  --local-dir /tmp/model-mlx

# 2. Dequantize MLX → HF safetensors
mlx_lm.convert --hf-path /tmp/model-mlx --mlx-path /tmp/model-hf -d

# 3. Convert HF → GGUF (requires llama.cpp + torch)
git clone --depth 1 https://github.com/ggerganov/llama.cpp /tmp/llama.cpp
cd /tmp/llama.cpp && cmake -B build -DGGML_METAL=ON && cmake --build build --target llama-quantize -j
python3 convert_hf_to_gguf.py /tmp/model-hf --outtype f16 --outfile /tmp/model-f16.gguf
./build/bin/llama-quantize /tmp/model-f16.gguf /tmp/model-q4.gguf Q4_K_M

# 4. Import into Ollama
cat > /tmp/Modelfile <<'EOF'
FROM /tmp/model-q4.gguf
TEMPLATE """{{ if .System }}<|im_start|>system
{{ .System }}<|im_end|>
{{ end }}{{ if .Prompt }}<|im_start|>user
{{ .Prompt }}<|im_end|>
{{ end }}<|im_start|>assistant
"""
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
EOF
ollama create my-model -f /tmp/Modelfile
```

Note: double quantization (MLX 4-bit → bf16 → GGUF Q4_K_M) introduces quality loss. Prefer Option A for MLX models or pull the native GGUF from Ollama when available (`ollama pull qwen2.5-coder:3b`).

## Context injection

Every turn the backend assembles a compact context from the currently-attached terminal:

- **Clean screen text** — last `context_lines` rows from the `VtLogBuffer` (ANSI-stripped, TUI alternate-screen suppressed). Default: 150. Tune in settings.
- **Session state** — shell busy / idle, CWD, last exit code, detected agent type, terminal mode (`Shell` vs `FullscreenTui`).
- **Recent parsed events** — errors, questions, rate limits, status lines.
- **Git context** — branch, short diff stats, staged file list (same variables Smart Prompts use).
- **Session knowledge** (when the agent has been active) — compact markdown summary of recent command outcomes, error→fix pairs, TUI apps seen.

The panel follows the focused terminal automatically — the header shows the active terminal's name as a badge. When no terminal is focused (e.g. a Git or settings tab is active), the panel enters **frozen state**: a banner reads "No terminal focused — chat is read-only", the input placeholder changes to "Focus a terminal first…", and the send button is disabled. Focus any terminal tab to resume.

## Conversations

- **Per-terminal state** — each terminal tab maintains its own independent chat history, streaming state, and conversation ID (keyed by `tuicSession`). Switching tabs switches the conversation. Messages sent from a tab always target that tab's PTY session.
- **Desktop and browser/PWA persistence** — conversations autosave to the same backend store on every transport, and closing a terminal flushes pending messages immediately. Reloading the page restores the latest conversation for that terminal. The history panel lists, opens, and deletes the same saved conversations in desktop and browser/PWA mode.
- Hard cap: **100 messages** per conversation in memory; older messages are evicted FIFO. Saved conversations keep the full history on disk.
- Streaming uses a Tauri `Channel<ChatStreamEvent>` on desktop and a dedicated WebSocket in browser/PWA mode — you see tokens as they arrive. Cancel mid-stream with the stop button or `cancel_ai_chat`.
- **Conversation history panel** — click the clock/history icon in the header to open a slide-in list of all saved conversations. Each row shows the title, terminal session name, message count, and date. Click a row to load that conversation into the current terminal's chat.

## Run-this, copy, and actions

Every fenced code block in the AI reply has a small toolbar:

| Action | Effect |
|--------|--------|
| **Run** | Sends the block to the attached terminal via `sendCommand()` (handles Ink raw mode). Disabled when no terminal is attached. |
| **Copy** | Clipboard. |
| **Insert** | Prepends the block to the current prompt input (for refinement). |

Language hints in the fence control button visibility — a ` ```text ` block hides *Run*.

## Message menu, new conversations and forks

Each message has a **⋯** button that appears when you hover the message or move
keyboard focus to it:

| Entry | Effect |
|-------|--------|
| **Copy message** | The whole raw message, fenced code included. |
| **Show raw Markdown** / **Show formatted message** | Answers only. Changes the view of that one message. |
| **Quote reply** | Adds the message as a `>` quote under your draft and focuses the composer. Nothing is sent. |
| **Fork from here** | Answers only. The turns up to that answer become a new saved conversation titled "Fork: …". The original stays in History. |

Reactions and comments are not offered here; they exist only in the phone's Chat
tab ([below](#ego-chat-on-the-phone-acp)).

Each turn reaches the model with the terminal context and your one new message,
not with the earlier turns of the chat. Quote reply is how you point at an
earlier answer. A fork is therefore a branch of the transcript: the model sees
no earlier turns in either conversation.

Commands typed alone in the composer (a lone `/` lists them):

| Command | Effect |
|---------|--------|
| `/clear`, `/new` | Saves the conversation on screen and starts an empty one. Refused while a reply is running, and the draft is kept. |
| `/fork` | Forks at the last completed answer. While a reply is still running here, the fork is saved to History and not opened. |

A path or a sentence that starts with a slash is still an ordinary message.

Three ways to clear, from lightest to heaviest:

- `Cmd/Ctrl+K` with the cursor in the chat hides the messages on screen. Nothing
  is deleted, History opens them again, and the terminal's scrollback is left
  alone. With the cursor in the terminal the same key clears the terminal's
  scrollback, as before.
- `/clear` starts a new conversation and keeps the old one in History.
- The trash in the header, **Delete conversation**, is the one action that
  deletes.

**Sending and failures.** A message you send shows **Sending…** until the reply
starts. A message that could not be sent stays as **Not sent**, and a turn the
provider failed stays as **No reply**, each with its reason, **Retry** (the same
text, model and effort; your current draft is untouched) and **Discard**. Neither
is written to the saved conversation. A failed agent task has **Run the task
again** on its error row.

**Images and long notices.** A `[image: /path]` marker in a message shows as a
framed preview above it; the model itself still receives text only. A long
notice or error shows its first line and opens on click.

The header dot says what the chat is doing: idle, working (a pulse) or waiting
for you (an approval is open, or the run is paused). A conversation that is busy
in another terminal carries the same dot on its History row.

## Agent mode (ReAct)

Flip the panel into agent mode via the header toggle or the command palette (`Agent: start`). Give it a goal ("set up pnpm and install deps", "fix the failing test") and press Enter. The loop:

1. Assemble context.
2. Ask the LLM with six tools available: `read_screen`, `send_input`, `send_key`, `wait_for`, `get_state`, `get_context`.
3. Dispatch tool calls — each appears as a collapsible card in the panel.
4. Record outcomes into the session knowledge store.
5. Stop on `end_turn` or when cancelled.

### Safety gates

The `SafetyChecker` trait inspects every would-be `send_input`. Three verdicts:

- **Allow** — common commands, `ls`, `git status`, `cargo build`, editor launches …
- **NeedsApproval** — destructive patterns (`rm -rf`, `git reset --hard`, `git push --force`, `DROP TABLE`, `dd of=`, package uninstall …). The panel shows a *Pending approval* card with a one-line reason. Approve / reject with a click or `approve_conversation_action`.
- **Block** — hard-coded refusals (e.g. `rm -rf /`, `:(){ :|:& };:`).

Pause / resume any time — the loop cleanly stops between iterations.

### Session knowledge

As the agent runs, the `SessionKnowledgeBar` footer shows live telemetry:

- Commands run this session (count).
- Last 5 outcomes with kind badges (Success / Error / TuiLaunched / Timeout …).
- Last 5 errors with inferred `error_type` (e.g. `rust-error-borrow`, `npm-missing-module`).
- TUI mode indicator + list of TUI apps seen.

OSC 133 semantic prompts (`OSC 133;A/B/C/D`) feed accurate exit codes when the shell supports them (modern `bash`/`zsh`/`fish` with the integration enabled). Without OSC 133, the PTY silence timer records an `Inferred` outcome so the loop still learns.

Knowledge persists to `<config_dir>/ai-sessions/<session_id>.json` with a 2 s debounced background flush. Reopening a session rehydrates the store.

## Scheduled tasks

A scheduled task is a goal the agent works on by itself on a schedule. Manage
them in **Settings > AI Chat > Scheduled tasks**: type a goal, choose
**Every** <step> <minutes, hours or day>, optionally tick **Run once**, and
click **Add task**. Each row shows the goal, its schedule ("Every 15 min",
"Every 2 hours", "Every day") and next run (or "paused"), an on/off switch and
Remove. **Runs once** and **Added by agent** badges mark those tasks.

Only intervals that tick evenly are offered, so a task never runs at uneven
gaps:

- every **5, 6, 10, 12, 15, 20 or 30 minutes**
- every **1, 2, 3, 4, 6, 8 or 12 hours**
- once a **day**, at **09:00 UTC** (choosing **day** hides the step)

An older task saved with another interval (for example every 45 minutes) keeps
running and can still be switched off or removed, but you cannot create one or
change a task to one.

The backend checks the schedule every 30 seconds, in the desktop app and in a
`tuic-remote` daemon alike. Each task gets **one terminal**: its first run opens
a shell named `cron:<task id>`, and later runs reuse it while it is open. Close
it and the next run opens a new one. If the previous run is still going, that
turn is skipped. Removing a task leaves its terminal open for you to read. A
run stops after 5 minutes by default. A run-once task switches itself off after
it fires. When a task finishes or times out, a toast says so.

**Destructive commands wait for your approval.** A scheduled task runs with
standard trust (Assisted), never unrestricted. When its agent wants to run a
command the safety checker holds for approval (`rm -rf`, `git reset --hard`,
`git push --force`, …), a toast that stays on screen says **Scheduled task
wants to run:** and the command, with **Approve** and **Deny**. The task's
conversation is not open in the AI Chat panel, so answer from the toast. Each
answer applies to that one request only and cannot be replayed. A browser or
phone connected to FastAF sees the notice without buttons ("Open FastAF on the
computer running it to approve"): only the desktop app can answer. If nobody
answers, the run ends at the task's time limit and the "Scheduled task timed
out" toast appears. Hard-blocked commands are always refused.

The agent can manage tasks too, with three tools: `schedule_task` (a goal of at
most 500 characters, an `interval_minutes` of 5, 6, 10, 12, 15, 20, 30, 60, 120,
180, 240, 360, 480, 720 or 1440, the last meaning daily at 09:00 UTC, and
optionally `one_shot`; any other interval is refused), `list_schedules` and
`cancel_schedule`. It cannot add a task once 10 tasks are switched on. Tasks are
stored in `<config_dir>/ai-cron.json`; tasks saved by FastAF 1.x keep firing.

## AI suggestions

Right-click a terminal tab in a pane's own tab strip (shown when a split pane
holds more than one tab) and choose **Toggle AI Suggestions** to turn
suggestions on or off for that terminal. The main tab bar's menu does not have
it. They start on for a terminal running an
agent and off for a plain shell. While they are on, a failed or timed-out command
shows a toast with **Investigate**: it opens AI Chat on that terminal and starts
the agent on a goal built from the failure. AI Chat must be enabled. A terminal
raises at most one suggestion every 30 seconds.

## Settings reference

**Settings > Providers** (always shown) holds the providers, their models and API
keys (OS keyring, masked with an eye-toggle), the Main and Headless slots,
**Test connection** and the headless agent.

**Settings > AI Chat** appears only while AI Chat is enabled (Experimental
Features on, plus its **AI Chat** sub-toggle). Below the page header come a
**Parameters** card and a **Scheduled tasks** card (see
[Scheduled tasks](#scheduled-tasks)). **Parameters** holds:

| Field | Stored in | Notes |
|-------|-----------|-------|
| Temperature | `ai-chat-config.json` | Default `0.7` |
| Extended thinking | `ai-chat-config.json` (`reasoning_effort`) | The reasoning-effort levels the Main slot's model advertises |

These `ai-chat-config.json` fields have no Settings control; edit the file to
change them:

| Field | Notes |
|-------|-------|
| `context_lines` | Default `150`. Raise for richer context, lower for smaller prompts. |
| `agent_model_overrides` | Per-task-phase model routing. Keys: `plan`, `search`, `read`, `write` (matching `ToolPhase`). When set, the agent loop selects the model by tool phase. |
| `experimental_ai_block_enrichment` | Default off. When on, each completed OSC 133 block is sent to the provider for a one-line `semantic_intent`. Rate-limited to ~10/min, silent on failure. |

## Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` | Toggle panel |
| `Cmd+Enter` (panel focused) | Send message |
| `Esc` (panel focused) | Cancel in-flight stream |
| `Cmd+K` / `Ctrl+K` (cursor in the chat) | Clear the chat view; nothing is deleted |
| *(palette)* Agent: start / stop / pause / resume | Agent-mode control |

## Files & storage

| Path | Purpose |
|------|---------|
| `<config_dir>/ai-chat-config.json` | Provider, model, base URL, temperature, context budget |
| `<config_dir>/ai-chat-conversations/<id>.json` | Saved conversation bodies |
| `<config_dir>/ai-sessions/<session_id>.json` | Per-session knowledge store |
| `<config_dir>/ai-cron.json` | Scheduled tasks |
| OS keyring (`tuicommander-ai-chat` / `api-key`) | Provider API key |

## ego chat on the phone (ACP)

Everything above describes the desktop panel, which runs on FastAF's own engine.
The **Chat** tab of the mobile companion is a different chat: it talks to
[ego](ai-agents.md) over ACP, one cross-repository conversation list for the
whole app, and it needs an ego executable on the host. The 2.1.2 sync brought
these changes to it. The desktop panel has its own version of the message
menu, `/clear`, `/fork`, sending states and image previews
([above](#message-menu-new-conversations-and-forks)); reactions and comments
are here only:

- **Message actions.** The **⋯** button on a message (always shown on touch
  screens) opens **Copy message**, **Show raw Markdown** / **Show formatted
  message** (answers only) and **Quote reply**, which appends the message as a
  `>` quote to the draft and never sends.
- **Reactions and comments.** Answers that carry a native message ID also offer
  **Thumbs up**, **Thumbs down**, **Heart**, **Celebrate** and **Comment on
  message**. A reaction is sent to the conversation as an ordinary user turn;
  tap its mark to remove it. A mark means the host accepted the action, not that
  the model read it. If the host accepted an action but could not save its mark,
  the error says **Do not resend**.
- **Sending receipts.** Submitted text and attachments show **Sending…** at
  once, also while another turn runs. A failed submission shows **Send failed**
  with **Retry**, which resends the original payload and leaves a newer draft
  alone. Check the conversation before retrying: a lost receipt does not prove
  the agent missed the first submission.
- **`/clear` and `/fork`.** `/clear` starts a fresh conversation, the same
  action as **New**; saved history is kept, and it waits for the current turn.
  `/fork` opens a new conversation from the last successfully completed turn,
  also while a turn runs.
- **Long messages.** A message capped in the stream offers **Show full text**.
- **Images.** A message with `[image: /absolute/path.png]` attachments shows
  framed previews above its text; an unreadable file shows **Image unavailable**.
- **Diagrams.** The host tells attended ego sessions that fenced `mermaid`
  blocks render as diagrams, so the agent may prefer them over ASCII.
- **Layout.** The title and the conversation picker share one header row, and
  **+** starts a new conversation.

## See also

- [`docs/backend/mcp-http.md`](../backend/mcp-http.md) — the MCP tool family external agents use + OAuth 2.1 upstream auth.
- [`docs/api/tauri-commands.md`](../api/tauri-commands.md) — Full Tauri command reference for chat + agent.
- [`docs/backend/pty.md`](../backend/pty.md) — PTY lifecycle, OSC 133, TUI detection, silence-based idle.
- [`ideas/ai-assisted-terminal.md`](../../ideas/ai-assisted-terminal.md) — Original 3-level plan (Level 1 = Chat, Level 2 = Agent, Level 3 = Knowledge).
