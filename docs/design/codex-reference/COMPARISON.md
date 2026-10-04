# Codex look → FastAF: what to borrow, where it lands, what to keep

Companion to `README.md` (screenshot catalog + measured palette). Shot numbers refer to it; the
images themselves are in `.tmp/codex-ui-reference/` at the repo root (gitignored, 55 MB —
regenerate with `~/.local/tart/codex-sandbox-tools/` against the `codex-sandbox` VM).

**Path convention:** a bare component file or folder (`AIChatPanel.tsx`, `Terminal/Terminal.tsx`,
`RepoSection.tsx`, `StatusBar.tsx`, `TabViews.tsx`, `shared/panel.module.css`, …) is under
`src/components/`; `stores/`, `hooks/`, `utils/`, `mobile/`, plus `App.tsx`, `global.css`,
`styles.css`, `themes.ts`, `FloatingTerminal.tsx` are directly under `src/`; a bare `.rs` path or
one starting `ai_agent/`, `dictation/`, `voice/` is under `src-tauri/src/`. **Line numbers come
from a code read at `27c949b7` on 2026-10-03** — six of them were re-checked by hand, the rest
were not; grep before editing.
`FileBrowserPanel.tsx` lines will shift once the uncommitted multi-select work is committed.

## Thesis

FastAF is not becoming a chat app. Its core is many live terminals, each running a CLI agent,
plus the panels around them (Files, Git, Chat). Codex has one thread per task; its content pane
(shots 37–42) does carry a diff viewer, a file tree, a real editor and a plain shell tab, but
nothing orchestrates terminals — no agent state, no splits, no per-repo tab strips. That
orchestration is FastAF. So: borrow Codex's **surfaces, composer, sidebar structure, inline approval cards, `@` file
mentions and in-composer voice**, and keep terminals as the thing those controls drive. Two
facts from the code make this cheaper than it looks:

1. **`AIChatPanel` is already Codex-shaped** — Ask/Agent + model + effort chips, approval card,
   tool-call rows, thinking disclosure, VoiceOrb, dictation (`AIChatPanel.tsx:711-1270`). It is
   hidden behind two flags that default to `false`: `experimentalFeaturesEnabled` and
   `aiChatEnabled` (`stores/settings.ts:448-449`). Nobody sees it.
2. **The backend already does the hard parts** — the chat engine drives terminals through
   `read_screen / send_input / run_command / spawn_session / drive_agent`
   (`src-tauri/src/ai_agent/tools.rs:72-439`), and Rust already parses a CLI agent's permission
   dialog (`choice_prompt`). Only desktop rendering is missing.

## 1. Surfaces: tonal steps instead of one black

| | Codex (measured) | FastAF today |
|---|---|---|
| Rail / title bar | `#242424` | `#050505` |
| Sidebar | `#1d1d1d` | `#050505` |
| Content | `#181818` | `#050505` |
| Dividers | none — a grey step | 1px `--border-subtle` |

Codex reads softer because the window gets *darker toward the content*, and columns meet
without a line. FastAF's "one flat black + hairlines" (`global.css:204-205`, STYLE_GUIDE
"Design Philosophy") is the single biggest visual difference.

**Done as a theme (2026-10-03):** `src-tauri/src/themes/codex-dark.json` ("Codex Dark"),
registered in `BUILTIN_THEMES` (`themes.rs`) and copied into the installed themes dir. It maps
the measured palette onto the existing `appChrome` keys — well `#181818`, frame `#1d1d1d`,
raised `#2d2d2d`, highlight `#3d3d3d`, text `#fff / #afafaf / #8b8b8b`, accent `#5685d1`,
border `#262626` (nearly invisible against the frame, which is the point) — so it sits beside
Cursor Dark as "the Codex look" without touching tokens. What a theme *cannot* do, and what
the token work below still has to: a separate rail tone (`#242424`) and removing the hairlines
where two tones meet.

**Change** (`global.css:196-376`): `--bg-secondary` (frame) ≈ `#1d1d1d`, a new `--bg-rail`
≈ `#242424`, `--bg-primary` (well) `#181818`; terminals may stay darker (`#0d0d0d`-ish) so text
contrast holds. Raised: `--bg-tertiary` `#2d2d2d`, `--bg-highlight` `#3d3d3d`, grey button
`#474747`. Text: `--fg-primary #fff`, rows `#ddd`, `--fg-secondary #afafaf`, `--fg-muted #8b8b8b`.
Accent stays FastAF blue (`#5aa0f8` vs Codex `#5685d1` — close enough; don't chase it).
Then drop the column hairlines where two surfaces of different tone meet (`styles.css`,
`shared/panel.module.css`), keep them where tones are equal. The 16 JSON themes
(`src-tauri/src/themes`, applied by `themes.ts:322-351`) override these keys — update
`cursor-dark.json` (default, `stores/settings.ts:421`) to match. STYLE_GUIDE "Surfaces" and
"Anti-patterns › No boxes inside boxes" need a one-line amendment: *a tonal step is also a
valid divider*. Everything else in the guide already matches Codex (no uppercase, 13px rows,
pastel semantics as text/dots/tints).

## 2. Window structure: a rail, a Projects/Recents sidebar

Codex: 44px icon rail · 240px sidebar · content · 250px right panel (shots 10, 18, 19).
FastAF: Toolbar / [Sidebar | TabBar + TerminalArea + one right panel] / StatusBar, panel
toggles living on the **status bar's right side** (`StatusBar.tsx:430-496`), one panel open at
a time (`stores/ui.ts:168-197`).

**Change** — move the panel toggles into a left icon rail (`App.tsx:820-1145` for the
structure, `styles.css` for `sidebar-hidden` / `focus-mode`): Terminals (home), Files, Git
(with its change count badge, `StatusBar.tsx:430`), Chat, Ideas, Activity (⌘⇧A). The status
bar keeps what Codex has no equivalent for: zoom, cwd, agent usage/rate-limit badge
(`StatusBar.tsx:268-328`), PR/CI badges. The sidebar toggle in Codex hides the whole sidebar
and leaves the rail (shot 18) — FastAF's `uiStore.sidebarVisible` already does this; the rail
just needs to be the thing that stays.

**Sidebar** (`Sidebar/Sidebar.tsx:423`, `RepoSection.tsx`): the structure is already
Projects-like (groups → repos → branch rows with per-terminal dots at `RepoSection.tsx:174-200`
and `+N −N` badges at `141-160`). Restyle to Codex's rows (shots 10, 35b): 28px, 6px-radius grey
wash for selection, **no accent bar**, status as a 6px dot at the row's right edge, section
labels sentence-case 13px `#afafaf`, and `+` / `…` / pencil revealed on hover of the section
header and row. With several repos (shot 43) Codex nests one level — project → its threads —
and keeps **Recents** flat across projects with a spinner while running and a blue dot when a
result is unseen; FastAF's repo → branch → terminal nesting is one level deeper and should stay
(it is the multi-session model Codex lacks), so only the row styling and the dot grammar move
over. Add a **Recents** section under Projects: the last N sessions with the
terminal's `currentTask` / `lastPrompt` as the title and the state dot (data is already in
`terminalsStore` `stores/terminals.ts:43-100` and `ActivityDashboard.tsx:221-300`). Keep the
Pull/Push/Fetch/Stash row and the footer — Codex has nothing like them and they earn their place.

## 3. The composer is the one raised object

Codex (shots 16b, 32b, 36b): a 16px-radius grey field; a **header row** appears when a project
is selected (project chip · "This computer" · *Worktree* toggle); a **bottom row** of chips
(`+` · approval mode · spacer · model + effort · mic · voice · ↑ send as a 28px white circle).

FastAF has two composers: `ComposePanel` per terminal (Cmd+I, CodeMirror,
`ComposePanel/ComposePanel.tsx`, mounted at `Terminal/Terminal.tsx:1301`) with Send/Enqueue, and
the chat composer (`AIChatPanel.tsx:1093-1270`) with Ask/Agent, model, effort, Steps, Approvals
chips + voice, dictate, send.

**Change** — one composer component with the Codex shape, used by both:
- Header row: repo/branch chip · terminal chip (which PTY this goes to — FastAF's
  differentiator; Codex only has "This computer") · **Worktree** toggle (FastAF already creates
  per-branch worktrees; this surfaces it exactly where Codex does).
- Bottom row: `+` (attach files — reuse the FileBrowser's path insertion) · approval mode
  (see §5) · model/effort chips (chat only) · mic · voice · send. Enqueue stays as a
  secondary action with its queue badge; Codex has no queue and FastAF's is better.
- Send path unchanged: `utils/sendCommand.ts:80-104` for terminals, `conversationStore` for chat.

## 4. `@` file mentions (Codex's file lookup)

Codex's **sidebar has no file tree**; files are reached from the composer. `@` opens an Add
menu; `@rout` becomes a fuzzy picker of `glyph · name · dimmed parent path`, folders mixed with
files (shots 24b, 25b); Enter inserts a chip. Also `+ → Files and folders`, file links in
answers, and — inside the content pane — a **Files tab** with a right-docked tree and a real
editor (shots 39–42; ⌘S writes to disk, undo/redo pill, `Open ▾` for an external app) plus a
**Changes** diff tab (37b). FastAF already has all three as panels/tabs (FileBrowserPanel,
CodeEditorTab, DiffTab); the difference is Codex tucks them into one tab strip beside the thread.

FastAF has the search (`search_files` via `stores/commandPalette.ts:104`, the `!` prefix) and
the tree (`FileBrowserPanel`, Cmd+E, flat/tree + filename/content filter at `1594-1714`), but
**no `@` picker in any textarea** and **no clickable file links in chat answers**
(`MarkdownContent` at `AIChatPanel.tsx:41-45` never passes `onLinkClick`, though
`ContentRenderer.tsx:412-418` supports it).

**Change**:
- `@` popover in the shared composer, backed by `search_files`, rows styled as 25b. On accept:
  terminal composer inserts the shell-quoted path exactly like a drop does
  (`hooks/useFileDrop.ts:52-60`); chat composer inserts a mention chip.
- Pass `onLinkClick` from `AIChatPanel` into `ContentRenderer` and route `path:line` to the
  editor-tab opener the terminal links already use (`canvasTerminalLinks.ts` → `App.tsx:524`).
- **Keep the FileBrowserPanel.** It is a feature Codex lacks; restyle its rows to the same 28px /
  6px-wash selection as the sidebar (the in-flight multi-select work already moved selection to a
  25 % accent wash — align the two).

## 5. Approval cards for CLI agents — the biggest functional gap

Codex (shot 12b): inline card at the end of the thread — title, the command in mono,
**Allow once** (grey `#474747`) / **Deny** (ghost); mode picker (22b) Ask / Approve for me /
Full access (red).

FastAF: the chat has the card (`AIChatPanel.tsx:952-990`, Approve / Deny / Always allow →
`approve_conversation_action`), but for **CLI agents in terminals** desktop only logs the parsed
`choice_prompt` and plays a sound (`Terminal.tsx:540-550`); the mobile UI renders it as tappable
buttons (`mobile/components/ChoicePromptOverlay.tsx:10-29`); `PromptOverlay` is dead on desktop.

Codex's **Question card** (shot 48b) is the exact shape to copy: when the agent stops to ask, a
card docks *above the composer* — header "Question" + ✕, the question, numbered options
(`1` / `2` keycap chips + text), then an "Or write your own response" field with its own mic,
and Skip / Send. It is the same UI whether the question came from a plan, an approval or a
choice — one component.

**Change** — render the parsed `choice_prompt` as that card pinned to the bottom of the
terminal pane (above the composer), options as buttons that send the keypress through
`sendCommand`, cleared by the existing `choice-cleared` / `resolve_choice_prompt_input` path. The
parser is already a documented full-screen exception (AGENTS.md "parse_choice_prompt"), so no
new scraping. Approval *mode* maps onto the agent's own permission flags at launch (run configs,
`hooks/useTerminalContextMenus.ts:56-129`) — show it as the composer chip, don't invent a FastAF
permission layer on top of the agent's.

## 6. Thread chrome: timeline, commands, state

Codex: `Worked for 21s ›` collapsible divider → plan sentence + `Ran commands` rows, one per
command, truncated (shots 17b, 23b); user turns as right-aligned grey cards; muted "Thinking…"
while working (shot 11).

FastAF chat already has the pieces: ToolCallCard rows (`AIChatPanel.tsx:239-319`), the Thinking
disclosure (`836-845`), step row with pause/resume/stop (`871-926`). **Change**: group the
tool-call rows under one `Worked for Ns ▾` divider per turn; user turns as `--wash-1` cards
(already the STYLE_GUIDE rule).

For terminals, don't build a second timeline — the data is already there. Shell integration
(OSC 133) records command blocks per terminal (`stores/terminals.ts:95-98`, `commandBlocks` /
`foldedBlocks`), and Cmd+Shift+. folds the block under the viewport
(`Terminal/CanvasTerminal.tsx:2410-2428`; on by default via `blockFoldingEnabled`,
`stores/settings.ts:457`); failed commands already get a red gutter mark (`CanvasTerminal.tsx:690-720`).
It is keyboard-only with no visible affordance. **Change**: paint a Codex-style `Ran N commands ▾`
header on the fold boundary (clickable, same `toggleBlockFold`) so the terminal gets the
collapsed/expanded reading of shot 23b without any new parsing. Tab/sidebar state dots (`TabViews.tsx:126-138`, `RepoSection.tsx:62-138`) already carry
awaiting / busy / unseen; just adopt Codex's placement (right edge, 6px) and its blue unseen dot
instead of purple if you want the match.

## 7. Voice, in the composer row

Codex: **dictation** replaces the composer's bottom row with `✕ · dotted live waveform · ■ · ↑`
(36b); **voice chat** shows a blurred blue orb above the composer and swaps the row to
`speaker · mic · ✕`, muted mic red (26–28b).

FastAF: dictation is a toast (`DictationToast.tsx:11-49`) with a bar `MicMeter` driven by one
RMS level; voice mode lives inside the chat panel with `VoiceOrb` (`AIChatPanel.tsx:1037-1085`,
16px twin in the status bar); all on-device (whisper.cpp + Silero + Kokoro,
`src-tauri/src/voice/mod.rs`). Both are off by default (`dictation/commands.rs:998`, the chat flags).

**Change**: move the dictation UI from the toast into the composer's bottom row (dotted
baseline that grows bars with level — the `MicMeter` level feed is enough; keep the live partial
text in the field). Put the orb above the composer during voice mode and give the row
speaker/mic/✕. This is placement, not new audio work.

## 8. Mini (optional)

Codex's ⌥Space Mini (30b): floating pet + 3-button glass pill (compose / voice / expand) with
task-done toasts above. FastAF's floating window (`#/floating`, `FloatingTerminal.tsx`) is the
host; a compose/voice/expand pill is a small addition. Skip the pets.

## Do not copy

- Pets, "Your dot", light mode (dark only for now), the plugins marketplace rows in the `+` menu.
- Hiding the tree, editor and diff inside a tab strip beside the thread — FastAF's Files, Git and
  editor stay first-class panels; terminals, not a thread, own the centre.
- Codex's single-thread model — multiple terminals, splits (`stores/paneLayout.ts`), Multiview
  and worktrees are the product.

## Order of work

1. Tokens + tonal surfaces (§1) — one file, instantly changes the feel. Screenshot after.
2. Rail + sidebar rows + Recents (§2).
3. Shared composer with header/bottom rows (§3); flip the chat flags on by default or surface them.
4. `@` picker + clickable file links (§4).
5. Approval cards for terminal agents (§5).
6. Timeline grouping, dictation-in-composer, orb placement (§6–7).
7. Mini pill (§8), then **retake the README hero** — every repo screenshot predates the
   September redesign (`assets/tui-screenshot.png`, `website/public/**`, all 2026-07-12).
