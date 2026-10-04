# Codex desktop app — UI reference for FastAF (dark mode)

Captured 2026-10-03 from OpenAI's Codex desktop app (`Codex.dmg` → installs
`ChatGPT.app`, bundle `com.openai.codex`, v26.930.31730) running in an isolated
Tart VM (`codex-sandbox`, macOS 26.6.2, 1920×1200 logical → 3840×2400 px).
Every `NN-*.png` is a full-screen 2× capture; `NNb-*-crop.png` is a 1:1 crop of
the control that matters. Dark mode only, as requested.

The images live in `.tmp/codex-ui-reference/` at the repo root (gitignored, 55 MB). To retake
any state: start the VM (`~/.local/bin/tart run codex-sandbox`) and use the helpers in
`~/.local/tart/codex-sandbox-tools/` (`vmshot`, `vmclick`, `vmkey`; see its README).

## Catalog

| # | File | What it shows |
|---|------|---------------|
| 01 | `01-chat-dark-no-repo.png` | Codex mode, no project, a plain chat answered |
| 02 | `02-mode-switcher-dark.png` | "Codex ▾" dropdown: ChatGPT / Codex / Code Review |
| 03 | `03-codex-home-no-project-dark.png` | Empty Codex home ("What should we build?"), composer only |
| 04 | `04-code-review-setup-dark.png` | Code Review mode first-run (GitHub connect) |
| 05 | `05-composer-plus-menu-dark.png` | Composer **+** menu (Files and folders, Attach Safari, Goal, Plan mode, Record a skill, Sketch, Plugins…) |
| 06 | `06-sources-plus-menu-dark.png` | Right panel "Sources +" menu |
| 07 | `07-create-project-dialog-dark.png` | Create project dialog (name + source folder) |
| 08 | `08-create-project-filled-dark.png` | Same, filled with `express` |
| 09 | `09-trust-folder-dialog-dark.png` | "Trust this folder?" modal |
| 10 | `10-sidebar-with-project-dark.png` | Sidebar with Projects › express |
| 11 | `11-working-state-dark.png` | Thread while the agent works: "Thinking…", muted text |
| 12 | `12-approval-request-dark.png` + `12b` | Inline approval card: "Allow once / Deny" with the command shown |
| 13 | `13-delegation-activity-feed-dark.png` | Live activity rows while a delegated task runs |
| 14 | `14-project-thread-result-dark.png` | Finished answer: file links with `(line N)`, inline code chips, table |
| 15 | `15-project-thread-top-dark.png` | Top of the thread: user turn card, "Worked for 21s ›" |
| 16 | `16-voice-mode-dark.png` + `16b` | **Voice chat starting**: composer swaps to a waveform + stop + send |
| 17 | `17-work-timeline-expanded-dark.png` + `17b` | "Worked for 21s ▾" expanded: plan sentence + "Ran commands" row |
| 18 | `18-sidebar-collapsed-dark.png` | Sidebar collapsed → only the icon rail remains |
| 19 | `19-both-panels-collapsed-dark.png` | Sidebar + right panel collapsed → thread alone |
| 20 | `20-account-menu-dark.png` + `20b` | Account popover: usage %, Show Mini ⌥Space, Settings ⌘, |
| 21 | `21-model-picker-dark.png` + `21b` | Model picker: name + a **reasoning-effort slider** |
| 22 | `22-approval-mode-picker-dark.png` + `22b` | Approval modes: Ask / Approve for me / Full access (red) |
| 23 | `23-ran-commands-expanded-dark.png` + `23b` | "Ran commands" expanded: one row per command, truncated |
| 24 | `24-at-mention-add-menu-dark.png` + `24b` | Typing `@` → Add menu (files, Safari, Goal, Plan, plugins) |
| 25 | `25-at-mention-file-picker-dark.png` + `25b` | `@rout` → fuzzy **file picker**: name + dimmed parent dir, folder/file glyphs |
| 26 | `26-voice-chat-starting-dark.png` | Voice chat: blue orb above the composer, "Start voice chat" tooltip |
| 27 | `27-voice-chat-active-dark.png` + `27b` | Voice chat active: orb + composer with speaker / mic / ✕ |
| 28 | `28-voice-chat-mic-muted-dark.png` + `28b` | Voice chat, mic muted (red mic button) |
| 29 | `29-settings-general-dark.png` | Settings › General (permissions toggles, projectless folder…) |
| 30 | `30-mini-mode-widget-dark.png` + `30b` | **Mini** (⌥Space): floating pet + 3-button pill (compose / voice / expand) |
| 31 | `31-mini-widget-with-toast-dark.png` + `31b` | Mini widget with a task-done toast above it |
| 32 | `32-home-with-project-dark.png` + `32b` | Home with a project: composer grows a header row (project chip · This computer · **Worktree** toggle) |
| 33 | `33-settings-voice-dark.png` | Settings › Voice: mic, voice, screen context, dictation shortcut, recent recordings, dictionary |
| 34 | `34-settings-mini-and-pets-dark.png` | Settings › Mini & Pets |
| 35 | `35-project-home-worktree-toggle-dark.png` + `35b` | Project selected: threads nest under the project in the sidebar |
| 36 | `36-dictation-recording-dark.png` + `36b` | **Dictation**: composer bottom row becomes ✕ · dotted live waveform · ■ · send |
| 37 | `37-changes-diff-viewer-dark.png` + `37b` | **Changes tab**: branch chip `master → origin/master`, per-file header with `+N −N` · eye · code · open · ···, collapsible "N unmodified lines", green added rows |
| 38 | `38-new-tab-tools-page-dark.png` | **New tab** page: URL bar + Tools grid — Terminal ⌃\`, Files ⌘P, Side chat ⌥⌘S, New page |
| 39 | `39-files-tab-workspace-tree-dark.png` | **Files tab**: right-side tree (Filter files…, chevron folders, file-type glyphs), empty "Open file" state |
| 40 | `40-file-viewer-dark.png` | **File viewer**: breadcrumb `express › index.js`, line numbers, syntax colours, `Open ▾` (external editor) |
| 41 | `41-file-tree-expanded-dark.png` | Tree with `lib/` expanded, selected folder outlined in accent |
| 42 | `42-file-editor-manual-edit-dark.png` + `42b/42c` | **It is an editor**: typed text on line 12, ⌘S wrote it to disk; undo/redo pill bottom-right |
| 43 | `43-two-projects-two-threads-dark.png` + `43b/43c` | **Two repos, two chats**: `ky` and `express` each with their thread nested; Recents merged, spinner on the running one; live `Working for 5s` + `Running pwd && rg …` row |
| 44 | `44-terminal-tab-dark.png` | **Terminal tab**: a plain shell (`admin@… express %`) in the content pane — no agent state, no splits |
| 45 | `45-project-context-menu-dark.png` + `45b` | Project row right-click: Pin · Edit · Section › · Reveal in Finder · Archive chats · Remove project |
| 46 | `46-customize-plugins-page-dark.png` | Rail › Customize: Plugins / Skills, a two-column catalog with `+` per row |
| 47 | `47-scheduled-tasks-page-dark.png` | Rail › Scheduled: "Schedule a task" empty state with suggestion cards |
| 48 | `48-agent-question-card-dark.png` + `48b` | **Question card** — the agent asks and waits: docked *above the composer*, numbered options, "Or write your own response" field with mic, Skip / Send |

## Multiple repos, multiple chats (43)

One sidebar entry per project (= repo folder), each with its threads nested one level under
it; the project row stays a plain folder glyph + name, no status of its own. **Recents** is a
flat list across all projects, newest first, with a spinner while a task runs and a 6px blue dot
for an unseen result. Switching projects is a click on the project row; the composer's header
row (shot 32b) then shows which project / machine / worktree the next message goes to. There is
no concept of several live sessions *in one repo* side by side, no per-repo tab strip, and no
grid view — one thread fills the centre at a time.

Earlier, pre-dark-mode captures live in the session scratchpad only.

## Layout and chrome (what makes it read "Codex")

- **Three columns, one black.** 44px icon rail (home, code review, history, tasks, ···, git) ·
  240px sidebar · centered thread (max ≈ 620px text column) · 250px right panel. Everything
  sits on one `#0d0d0d`-ish surface; the only dividers are 1px hairlines. No cards in the
  chrome. This is already FastAF's "quiet instrument" rule — the match is close.
- **Sidebar = Projects + Recents.** Sentence-case 13px section labels (`Projects`, `Recents`),
  28px rows, selected row is a 6px-radius grey wash, no accent bar. A hover reveals `+` / `…` /
  pencil on the section header and row. Threads nest one level under their project when the
  project is selected (35b). Status is a 6px dot at the row's right edge (blue = unseen result),
  a spinner while running.
- **Thread** is flat markdown on the surface: user turn is a right-aligned grey card
  (`--wash-1` equivalent, 12px radius); assistant text sits directly on black. File refs are
  blue links with a file glyph and `(line N)`; identifiers are inline code chips (grey pill,
  mono). "Worked for 21s ›" is a collapsible divider with a hairline; expanded it shows the
  plan sentence and "Ran commands" rows (one per command, truncated with …) — 23b.
- **Composer** is the one raised object: 16px-radius dark grey field, "Do anything"
  placeholder, bottom row of chips: `+` · ⛉ Ask for approval · (spacer) · `GPT-6.1 Sol Medium ▾`
  · mic · waveform. With a project selected it grows a **header row** above the text:
  project chip · "This computer" chip · "Worktree ◯" toggle on the right (32b). The send
  button is a 28px white circle with a black ↑ (only when there is text).
- **Approval card** (12b) is inline at the end of the thread: title, the command in mono,
  "Allow once" (grey filled) / "Deny" (ghost). Approval **mode** (22b) is a popover with
  three rows, each title + 12px explanation; "Full access" is red text.
- **Model picker** (21b): name row then a 6-stop slider for reasoning effort.
- **Collapsing** (18/19): the sidebar toggle in the title bar hides the sidebar entirely, the
  rail stays; the right panel toggle hides the panel; the thread re-centers.

## Voice (what you asked to see)

Two distinct features, two distinct buttons at the composer's right edge:

1. **Dictation** (mic icon, 36b): the composer's *bottom row* is replaced by
   `✕ · · · · ·▁▂▃▂▁· · · · ■ ↑` — a dotted baseline that becomes bars where there is level, a
   stop square, and the send circle. Text lands in the field. Settings › Voice has a hold /
   double-tap shortcut, last-20 recordings, and a dictation dictionary (33).
2. **Voice chat** (waveform icon, 26–28): a ~40px blurred **blue orb** appears above the
   composer (it animates: brighter/larger while speaking), the bottom row becomes
   `speaker · mic · ✕`; muting turns the mic button red (28b). The composer stays usable
   for typing. Pressing ✕ returns to the normal row.

FastAF already has the VoiceOrb and dictation (see STYLE_GUIDE "AI Chat panel"), so the
delta is placement and the dotted dictation waveform *in the composer row* rather than a
separate stage.

## File lookup (what you asked to check)

- `@` in the composer opens the **Add** menu (24b); continuing to type (`@rout`) switches it
  to a fuzzy file/folder picker (25b): rows are `glyph · name · dimmed parent path`, folders
  listed with files, ranked by match. Enter inserts a mention chip. The sidebar has no file
  tree, but the content pane does (see below): file access is `@`-mention, `+ → Files and
  folders`, the links the answer produces, and the Files tab.

## Content pane: Changes · files · editor · terminal (37–42)

Clicking **Changes +N −N** (or the `+` beside the thread title) opens a second column with
its own tab strip (shot 37): the thread shrinks to the left, the right column holds tabs.
- **Changes** (37, 37b): a branch chip (`Branch ▾ +5 −0 · master → origin/master`), then one
  block per file — `JS index.js … +1 −0 · eye · </> · ↗ · ···` — with "8 unmodified lines ⌃"
  collapsers and green added rows. Unified only; no split view seen.
- **New tab** (38): a browser URL bar plus a Tools grid — **Terminal** (⌃\`), **Files** (⌘P),
  **Side chat** (⌥⌘S), **New page**. The Terminal is a plain shell in a tab
  (`admin@… express %`), nothing more: no agent state, no splits, no per-repo tabs.
- **Files** (39, 41): a tree docked on the *right* of the content column — `Filter files…`
  box, chevron folders, file-type glyphs (JS / M↓ / `{ }`), selected folder outlined in accent.
- **File viewer = editor** (40, 42): breadcrumb `express › index.js`, line numbers, syntax
  colours, `Open ▾` to hand off to an external app. Typing works and ⌘S writes to disk
  (verified: the typed text appeared in the file over SSH); an undo/redo pill sits bottom-right.
- The right panel's **Changes +N −N** row (visible in 14–23) opens the diff; **Sources +**
  (06) attaches extra folders.

## Mini (30/31)

⌥Space shows a floating pet + a 3-button glass pill (compose, voice, expand) over whatever
app is in front; task-done toasts stack above it. This is a separate always-on-top window.

## Measured palette (sampled from the 2× captures, dark mode)

Codex is **tonal**: columns are separated by a step in grey plus a single *device* pixel of a
lighter grey — half a CSS pixel at 2× (`#313131` under the title bar, `#303030` between rail and
sidebar, `#363636` between sidebar and thread; corrected 2026-10-03 from a pixel scan — an
earlier note here said there was no divider pixel). Note the
surfaces get *lighter* toward the edges of the window, the opposite of FastAF's single
`#050505` — this is the main reason Codex reads softer.

| Role | Codex | FastAF token today |
|------|-------|--------------------|
| Title bar / icon rail | `#242424` | `--bg-secondary` `#050505` |
| Sidebar | `#1d1d1d` | `--bg-secondary` `#050505` |
| Thread + right panel | `#181818` | `--bg-primary` `#050505` |
| Selected sidebar row / user-turn card | `#2f2f2f` | `--wash-1` (white 7 %) |
| Right-panel card, popovers | `#2d2d2d` | `--bg-tertiary` `#161616` |
| Composer field | `#363636` | glass composer |
| Picker row selected | `#3d3d3d` | `--surface-hover` |
| Grey button ("Allow once") | `#474747` | `--bg-highlight` `#222222` |
| Primary text | `#ffffff` | `--fg-primary` `#f0f0f0` |
| Sidebar row text | `#dddddd` | — |
| Section label ("Projects") | `#afafaf` | `--fg-secondary` `#a6a6a6` |
| Chip / meta text | `#9a9a9a` / `#8b8b8b` | `--fg-muted` `#808080` |
| Link / file-ref blue | `#5685d1` | `--accent` `#5aa0f8` |
| Unseen-result dot | `#3a83f7` | `--unseen` `#c084fc` (purple) |
| Changes +N / −N | `#40c977` / `#fa423e` | `--success` `#4ade80` / `--error` `#f87171` |
| "Full access" warning text | `#ff8549` | `--attention` `#fb923c` |
| Voice orb core / rim | `#5482ef` / `#dae3fc` | VoiceOrb canvas |

Type is the system font at 13px for rows/chips, 12px meta, no uppercase anywhere; code
chips are mono on a grey pill. Radii: rows 6px, cards/popovers 12px, composer 16px, send
button a 28px circle.

## FastAF mapping and recommendations

See `COMPARISON.md` next to this file (written from a read of the FastAF source).
