# pi — UI layout and detection

Agent: `pi` (`@earendil-works/pi-coding-agent`).
Version audited: **0.83.0** · Date: **2026-08-02** · Theme: `rose-pine-moon`.

All values below were captured live from a real PTY session (raw ANSI), not inferred.

## Identity & rendering

| Property | Value |
|----------|-------|
| Binary | `pi` (npm global; the executable on disk is the **node** interpreter) |
| Rendering engine | `@earendil-works/pi-tui` (own TUI lib — not Ink, not Bubble Tea) |
| Repaint style | Full-frame, wrapped in synchronized updates (`\033[?2026h` … `\033[?2026l`) |
| Screen clear | `\033[2J\033[H\033[3J` on startup repaint |
| Cursor positioning | Relative — `\033[3A` up / `\033[3B` down, then `\033[1G`, cursor hidden (`\033[?25l`) |
| Config dir | `~/.pi/agent/` |
| Sessions | `~/.pi/agent/sessions/<encoded-cwd>/<ISO-ts>_<uuid7>.jsonl` |

**Process identity gotcha.** `proc_pidpath()` (macOS) and `/proc/<pid>/comm` (Linux) both return
the **node** interpreter for a pi session, not `pi`. Foreground-process classification therefore
falls back to `argv[0]` for known interpreters — see `is_script_interpreter` in `pty.rs` and
`read_process_argv0` in `process_env.rs`. Without that fallback pi is invisible as an agent.

## Bottom zone

Four rows, in this order, present in **every** state:

```
────────────────────────────────────────────  separator, RGB(196,167,231)
<composer>                                    reverse-video cursor block + blanks
────────────────────────────────────────────  separator
~/Gits/personal/tuicommander (main)           cwd + branch, RGB(110,106,134)
↑1.3k ↓1.8k R15k W6.0k CH88.5% $0.104 3.4%/272k (auto)    (openai) gpt-5.6-sol • medium
```

- **No prompt glyph.** The composer is a bare reverse-video cell (`\033[7m \033[0m`) followed by
  blanks. `is_prompt_line` matches nothing here — readiness cannot be prompt-based.
- **Status row** is the reliable "this is a pi screen" marker: the context gauge `N%/Nk` plus the
  ` • ` model separator. See `is_pi_status_row` in `pty.rs`.

## Working state

The composer row is replaced in place by an animated status row:

```
 ⠏ Working...
```

- Spinner: braille `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, RGB(196,167,231); label RGB(144,140,170).
- Already matched by `chrome::is_spinner_row` (braille range U+2800–U+28FF).
- Separators, cwd row and status row stay on screen unchanged for the whole turn.

`detect_pi_screen_activity` therefore reads: spinner in the footer → `Working`; otherwise, status
row present → `Ready`; neither → `Unknown`.

## OSC sequences

| Sequence | Notes |
|----------|-------|
| `\033]8;;\007` | Emitted after nearly every row (hyperlink reset) |
| `\033]0;<title>\007` | **Only with the `terminal-status-title` extension installed** |

The extension (`~/.pi/agent/extensions/terminal-status-title.js`) prefixes the title with a state
glyph, repainted every 120ms while working:

| Glyph | State | Source event |
|-------|-------|--------------|
| `○` (U+25CB) | idle | `session_start` |
| `⠋…⠏` braille | working | `agent_start` |
| `✓` (U+2713) | done | `agent_end` |
| `✗` (U+2717) | error | — |

TUIC does **not** derive activity from this title: the screen adapter already owns the
busy→idle transition, and a second path for the same transition is a race, not a safety net.
The title only feeds the tab name, and `cleanOscTitle` strips the glyph **and** the `|` separator
it sits on so every spinner frame collapses to one stable name (`π | tuicommander`).

## Input

| Property | Value |
|----------|-------|
| Submit | `Enter` (verified live: text + `\r` submits) |
| Newline | `shift+enter` / `ctrl+j` |
| Clear to line start | `ctrl+u` (`tui.editor.deleteToLineStart`) |
| Interrupt | `ctrl+c` (`app.clear`) |

`sendCommand`'s agent path (Ctrl-U prefix, 50ms gap, separate `\r`) is correct for pi as-is —
`ctrl+u` is a real binding, so the prefix is consumed rather than echoed.

## Not yet observed

Permission/approval prompts, interactive menus (`pi config`), and the session picker (`--resume`)
were not triggered during this audit. They are unaudited, not "absent" — trigger them before
relying on any assumption about their chrome.
