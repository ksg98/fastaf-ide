# FastAF — Visual Style Guide

Reference for all UI/CSS/layout work. Every visual change MUST follow this guide.

## Design Philosophy

**Quiet instrument, Codex-shaped.** The app is a frame around live terminals,
laid out the way OpenAI's Codex lays out its window (reference shots in
`docs/design/codex-reference/`): one title bar holding the tabs and the panel
toggles, a sidebar of action rows and projects, the content, side panels — and
no status strip. Regions are divided by a step in tone and a half-pixel light
line (tonal themes) or a 1px hairline (flat one-black themes), never by nesting
one box inside another. Type carries hierarchy (weight and size, never
uppercase tracking) and stays light (400, 500 for names and titles). Every icon
comes from one stroke set (`components/icons`); a coloured dot says *what
state*. Colour is spent only on things that need a glance.

## Application Layout

```
┌────────────────────┬─────────────────────────────────────────────────────────────┐
│ ● ● ●  [▯]         │ (● tab ×)(tab) [+][▦]     usage · PR   [⚡][🔔][IDE▾] [toggles]│  #toolbar = title bar
│ (sidebar column)   │ #tab-bar (pills)          #status-bar (inline cluster)       │  38px, --bg-chrome
├────────────────────┼──────────────────────────────────────────┬──────────────────┤  divider below
│ #sidebar           │ #terminal-container                      │ side panel       │
│  ✎ New terminal    │  #terminal-column                        │  40px header     │
│  ⌕ Search projects │   #terminal-panes (--bg-primary)         │  frame tone      │
│  Projects    [⏷][+]│                                          │                  │
│  📂 repo           │                                          │                  │
│     branch  (30px) │   #compose-dock (Speak · Type · target)  │                  │
│ ───────────────── │                                          │                  │
│ [↓][↑][⟳][▤]  [⚙]  │                                          │                  │
└────────────────────┴──────────────────────────────────────────┴──────────────────┘
```

**Key structural rules:**
- `#app` is `flex-direction: column`, fills 100vh × 100vw. `body` paints the frame (`--bg-app`).
- `#app-body` is `flex-direction: row`, `flex: 1`, `min-height: 0`.
- The title bar (`#toolbar`) is the only band above the content: its left zone is exactly `--sidebar-width` (traffic lights, then the sidebar toggle), its centre holds `#tab-bar`, its right end holds the notifications, the IDE launcher and the status cluster (`StatusBar placement="toolbar"`). There is no tab strip under it and no status bar under the content.
- The sidebar is fixed-width (resizable 200–500px) with one divider on its right.
- `#terminal-container` is flush: no margin, no radius, no ring, no top line (the title bar's divider is the edge). `#terminal-column` stacks the panes and the compose dock, so the dock never runs under a side panel. `--well-gap` / `--well-radius` are 0 and only exist so a theme can inset it again.
- Side panels (Files, Git, Ideas, AI Chat) are frame-coloured with one divider on their left and a 40px header.
- Dividers between regions use `var(--hairline-w) solid var(--hairline)`: 1px `--border-subtle` in flat themes, 0.5px white 9 % in tonal ones (Codex draws #313131–#363636 single device pixels).
- All sections have `overflow: hidden` — scrolling is on inner content areas only.

## Color Palette

Values shown are the **cursor-dark** defaults (defined in `:root` of `global.css`
and mirrored in `src-tauri/src/themes/cursor-dark.json`). Every theme overrides
the core keys at runtime via `applyAppTheme()` in `themes.ts`, which also emits
the derived tokens (`--border-subtle`, `--surface-hover`, `--wash-*`, `--scrim`,
scrollbar colours) with the right polarity for light themes. Always use
variables, never hardcode core palette values.

### Surfaces

| Variable | Default | Usage |
|----------|---------|-------|
| `--bg-primary` | `#050505` | The well: terminals, editors, diffs, recessed inputs |
| `--bg-secondary` | `#050505` | The frame: toolbar, sidebar, status bar, side panels — the same black as the well |
| `--bg-tertiary` | `#161616` | Raised: chips, menus, popovers, active tab pill |
| `--bg-highlight` | `#222222` | Strong hover / pressed fill |
| `--surface-hover` | white 7 % | Hover wash over any surface |
| `--wash-0/1/2` | white 4 / 7 / 12 % | Barely-there fills, neutral chips, pressed chips |
| `--border-subtle` | white 8 % | The only hairline you normally need |
| `--border-strong` | white 16 % | Hovered/focused hairline |
| `--highlight-inset` | white 9 % top rim | The 1px rim light on anything raised or floating |
| `--inset-well` | black 50 % inner + white 3.5 % below | Recessed inputs |
| `--scrim` | black 60 % | Modal backdrop |

**Tonal themes.** When a theme's frame and well differ in tone (`--bg-secondary` ≠
`--bg-primary`, as in Codex Dark: `#1d1d1d` frame, `#181818` well, `#2d2d2d` raised),
`applyAppTheme` adds `html.tonal`: `--border-subtle` drops to white 3.5 % and `--border-strong`
to 10 %, the frame goes opaque (no glass), and `--sheen` is `none`. A tonal step is a valid
divider — do not add a hairline where two tones already meet. Flat one-black themes (Cursor
Dark) keep the 8 % hairlines, which are all the structure they have.

### Glass

| Variable | Value | Usage |
|----------|-------|-------|
| `--app-gloss` | `none` | Reserved for themes that want a key light; the default frame is flat black with no top glow |
| `--sheen` | white 5 % → 0 top-down gradient | First layer of every glass surface token |
| `--sheen-strong` | white 11 % → 3.5 % | Raised controls: `.btn`, active tab, chips |
| `--surface-glass` | frame at 60 %, no sheen | Sidebar and side panels (`backdrop-filter: var(--blur-glass)`) — flat, so the top of the window is as black as the terminal |
| `--surface-overlay` | `--sheen`, raised at 82 % | Menus, palettes, dialogs, toasts, tooltips (`backdrop-filter: var(--blur-overlay)`) |
| `--blur-overlay` | `blur(22px) saturate(1.4)` | Always on — overlays frost the content beneath |
| `--blur-glass` | none / `blur(28px)` under vibrancy | Frame blur only matters once the desktop shows through |

The surface tokens are full `background` values (a gradient layer plus a tint):
use them with `background:`, never `background-color:`.

### Text

| Variable | Default | Usage |
|----------|---------|-------|
| `--fg-primary` | `#f0f0f0` | Names, values, body |
| `--fg-secondary` | `#a6a6a6` | Labels, secondary text |
| `--fg-muted` | `#808080` | Meta, placeholders, resting icons (5:1 on the frame) |

### Accent and semantic

| Variable | Default | Usage |
|----------|---------|-------|
| `--accent` / `--accent-hover` | `#5aa0f8` / `#79b3fa` | Selection wash (13 %), active toggles, primary buttons, links |
| `--text-on-accent` | `#0b1220` | Dark text on the accent (accessible on a light-blue accent) |
| `--activity` | `#5aa0f8` | Busy pulse — fixed, not themed |
| `--success` | `#4ade80` | Done, additions, open PRs |
| `--warning` | `#fbbf24` | Caution, usage ≥ 70 % |
| `--attention` | `#fb923c` | Agent needs input |
| `--error` | `#f87171` | Errors, deletions, failed CI |
| `--changes` | `#e3b341` | Changes requested / review required |
| `--merged` / `--unseen` | `#a78bfa` / `#c084fc` | Merged PRs / completed while unseen |

Semantic colours are one pastel family (Tailwind 400 hues). They are used as
**text, dots and 12–16 % tints** (`color-mix(in srgb, var(--success) 16%, transparent)`),
never as solid fills behind black text. Terminal ANSI colours use the same family.

## Typography

| Variable | Stack | Usage |
|----------|-------|-------|
| `--font-ui` | -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, … | Everything in the chrome |
| `--font-mono` | JetBrains Mono, Fira Code, … | Terminals, code, diffs, hashes, paths inside code |

- Chrome reads at **13px** (`--font-md`): rows, inputs, buttons, tab labels.
- **12px** (`--font-sm`) for secondary/meta text, the status bar, section labels.
- **11px** (`--font-xs`) only for badges, counts and keyboard hints.
- Weights: 400 body, 500 emphasis/buttons, 600 titles and repo names. Never 700 in chrome.
- **No uppercase tracking.** Section labels are sentence case, 12px/600, `--fg-secondary`.
- Numbers that line up (diff stats, sizes, counts) use `font-variant-numeric: tabular-nums`.

## Spacing and rhythm

| Variable | Value |
|----------|-------|
| `--row-h` | 28px — sidebar rows, list rows, menu items |
| `--well-gap` / `--well-radius` | 0 / 0 (content sits flush; kept for themes) |
| `--toolbar-height` | 36px |
| `--tab-bar-height` | 34px (tabs fill it; side-panel headers match it) |
| `--status-height` | 26px |
| `--space-1 … --space-10` | 4px grid |

Use `gap` on flex containers, not margins between children. Rows are inset 6px
from the panel edge so hover/selection washes read as rounded pills.

## Border radius

| Variable | Value | Usage |
|----------|-------|-------|
| `--radius-sm` | 4px | Tiny chips, kbd |
| `--radius-md` | 6px | Rows, controls, chips (tabs are square) |
| `--radius-lg` | 8px | Menus, popovers, cards |
| `--radius-xl` | 10px | Toasts, composer bubbles |
| `--radius-panel` | 12px | Dialogs, settings, floating panels |
| `--radius-pill` | 999px | Status badges, count bubbles |

## Elevation

Only things that float cast shadows: menus, popovers, dialogs, toasts.
`--shadow-dropdown` for menus/popovers, `--shadow-2xl` for dialogs and
detached panels, `--shadow-bottom-anchor` for bottom-anchored balloons.
Panels, cards and rows at rest have no shadow.

## Controls (`shared/controls.module.css`)

Compose from these; never hand-roll a button.

- `.btn` — 28px, `--bg-tertiary`, hairline, 13px/500. Hover: `--bg-highlight` + stronger hairline.
- `.btnPrimary` — accent fill, `--text-on-accent`, 600 weight.
- `.btnDanger` — transparent, error-tinted text and border; hover 14 % error wash.
- `.btnGhost` — transparent; hover `--surface-hover`.
- `.iconBtn` — 28×28, radius 8, `--fg-secondary` → `--fg-primary` on hover over a `--row-selected` wash. Every chrome icon button (title bar, panel headers, sidebar footer) uses this size.
- `.input` / `.textarea` / `.select` — 28px, **recessed** (`--bg-primary`), hairline, focus = accent border + 3px 22 % ring.
- Focus for keyboard users: `box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.25)`.

## Component reference

### Sidebar
- Every row is 30px, inset 8px from both edges, radius 8, padding-left 8, gap 10, text 13.5px. Hover = `--wash-0`; selection = `--row-selected` (white 8 %, Codex #2f2f2f) with `--fg-primary` text. Never the accent.
- Top: action rows — **New terminal** (compose icon; opens a terminal in the active branch) and **Search projects** (an input dressed as a row; focus = `--row-selected`).
- Section label "Projects": 13px/400 `--fg-secondary`; its actions (active-only filter, add repository) appear on hover, and the filter stays visible while engaged.
- Repo row: leading 16px folder icon — open while expanded, closed while collapsed — name 13.5px/500. Hover reveals `⋯` and `+` in place.
- Branch row: a 16px slot under the folder icon holds the **state dot** (6px), so branch text lines up with the repo name. Name 13.5px/400 at 74 % `--fg-primary`. Diff counts (11.5px, muted, tabular) only on hover and on the selected row.
- The dot is the only state signal: none = no terminal, grey = a terminal is open, busy = `--activity` pulse, question = `--attention` pulse, error = `--error`, unseen = `--unseen`. Kind (main / worktree / shell) is the tooltip.
- Footer: one 44px row — git sync icons (pull, push, fetch, stash) left, workspace / help / settings right, all 28px ghost buttons.

### Tab bar
- Lives in the title bar's centre. Tabs are 28px pills, radius 8, 2px apart, padding 0 6 0 10; 13px/400 label in every state (so switching never reflows the strip). Active = `--row-selected` (Codex #353535 on #242424) with `--fg-primary` text; resting tabs are transparent with a `--wash-0` hover. A leading 6px dot carries state (grey idle, `--activity` busy, `--attention` / `--warning` awaiting, `--unseen`) or the tab kind's colour. Close appears on hover and at 70 % on the active tab. `+` and Multiview follow the last tab as 28px icon buttons; empty strip space drags the window.
- Multiview tiles: square, `outline: 1px` into a 1px grid gap so neighbours share one hairline; the active tile's outline is 60 % accent. 24px flat header (12px muted label, 11px status word).

### Status cluster (title bar)
- There is no bottom status bar: `StatusBar` renders with `placement="toolbar"` as a `display: contents` cluster inside the title bar's right end. Transient status text (anything but "Ready"), agent usage and PR/CI badges flow before the notifications; the panel toggles (Ideas, Files, Markdown, Git, Chat) end the row as 28px ghost buttons — an **open panel lights its toggle** with `--row-selected`. Zoom shows only when it is not 100 %. The cwd and the hold-to-talk mic stay out (the compose dock's Speak replaces the mic). `placement="bar"` keeps the old strip for any surface that still wants it.

### Side panels (`shared/panel.module.css`)
- 40px header, 13px/500 title, 28px icon buttons on the right, one divider below; one divider on the panel's left edge (the resize handle draws no second line — it lights accent only while hovered or dragged).
- Rows 26–28px, inset 6px, radius 6.

### Menus, popovers, dialogs
- Menus/popovers: `--surface-overlay`, hairline, radius 8, `--shadow-dropdown`, 4px inset, 28px items.
- Dialogs: radius 12 (`--radius-panel`), `--shadow-2xl`, header 14px/600, actions bar with a hairline above. Scrim = `--scrim`.

## Interactive states

- Hover: `--surface-hover` wash; text `--fg-secondary` → `--fg-primary`.
- Selected: 13 % accent wash. Active toggle: 16 % accent wash + accent glyph.
- Focus: accent ring (see Controls). Disabled: `opacity: 0.45`, `cursor: not-allowed`.
- Hidden-until-hover actions (repo/branch/tab close) animate `max-width`/`opacity`, never layout-shifting margins.

## Vibrancy

The glass recipe is always on. `html.vibrancy` (macOS, transparency not
reduced) only lowers the alphas of `--bg-app` and `--surface-glass` and turns on
`--blur-glass`, so the desktop shows through the frame as well. The OS
`prefers-reduced-transparency` preference collapses every pane to opaque.
Components use the tokens unconditionally.

## Scrollbars

10px gutter, 4px rounded thumb (`--scrollbar-thumb`), transparent track.
The thumb is **invisible until the pointer is over the scrolling element**
(`:hover::-webkit-scrollbar-thumb`) — a permanently visible thumb reads as a
stray grey bar down the side of a panel. Central pane content keeps a 14px
gutter to match the terminal's own scrollbar. Sidebar list: 8px gutter, same
hover rule.

## AI Chat panel

A conversation, not a control panel (`components/AIChatPanel`):

- **Header** carries only what the chat is attached to (session dot + terminal chip), history, clear, window controls.
- **Composer** is one glass field: textarea on top, a chip row beneath. Left chips shape the turn (Ask/Agent, model, effort; Steps and Approvals appear in Agent mode). Right: voice, dictate, and the single accent send button. Chips are native `<select>`s dressed as pills so macOS pops the system menu.
- **Thread** is flat: assistant text sits on the panel, user turns are `--wash-1` blocks on the right, tool calls are 26px expandable rows, and agent progress, results, errors and approvals are rows at the *end* of the thread (`.statusRow`, `.errorBanner`, `.approvalCard`), never banners above it.
- **Empty state** teaches by doing: three starter prompts that send on click plus a hand-off to Agent mode.
- **Voice stage** (`.voiceStage`) shows the `VoiceOrb` (`components/ui/VoiceOrb.tsx`): a canvas sphere fed by the mic level and the speaker level from `voice_status`. Idle breathes, listening grows a halo, speaking brightens the core, thinking orbits a glint, muted drains to grey. A 16px twin sits in the status bar while a session runs.

## Composer (`components/ComposeDock`)

Speaking and typing are the first thing the window offers, the way Codex's composer is
(reference: `docs/design/codex-reference/`, shots 32b/36b). Two shapes, one component:

- **The bar** (dock at rest, 40px, flush under the terminal column, on `--bg-primary`): a
  **Speak** pill — the one bright object on the row, `--fg-primary` fill with `--bg-primary`
  text, 30px — then a ghost **Type** button, then at the right the target chip (state dot ·
  agent name · branch in `--fg-muted`) and a `--wash-1` "N queued" count when there is one. No
  text box: the agent in the terminal already draws its own prompt, so a second one only appears
  when there is text to look at.
- **The card** (Speak, Type, a saved draft, or the hero): a flat raised object — `--bg-tertiary`
  on the well, **no border, no sheen**, 18px radius, padding 14/12/12/16. Field on top, 15px
  `--font-lg`, grows to 200px then scrolls, placeholder in `--fg-muted` ("Speak or type a
  prompt"). Beneath it one row of 28px controls: ghost chips at the left (target chip, hero's
  agent picker, queue count), then mic (ghost) and the round action at the right — `--fg-primary`
  fill with the ↑ when there is text, a `--wash-2` circle otherwise.
- **Listening**: the live transcript shows as the field's placeholder, and the row becomes
  `DotWave` (3px dots at 9px pitch, newest sample at the right, brightness and scale follow the
  level) · stop (`--wash-2` circle, ■) · ↑. Dictation started from the keyboard goes straight to
  the terminal; the bar still shows the wave and the words.
- **Hero** (empty well, 760px): a 28px/500 sentence-case question with the repo underlined, then
  Codex's context strip — repo · branch on a 14px-top-radius strip in a mix of `--bg-tertiary`
  and `--bg-primary`, tucked behind the card — and the card with the agent picker (native
  `<select>` dressed as a ghost chip).
- Never two text boxes stacked: the field folds back into the bar after Enter sends, on Esc, or
  when an empty card loses focus. ⌥Enter queues and keeps the card open for the next prompt.

## Onboarding

Three ideas the chrome cannot explain are taught once, in place (`components/Onboarding`, state in `stores/onboarding.ts`, persisted in localStorage):

- **WelcomeWell** replaces the empty well's placeholder on a fresh install: a terminal per branch, split the well, Multiview — with the user's real shortcuts. Dismissed by "Got it".
- **CoachMark** is a glass callout pinned above a `data-coach="…"` anchor (status-bar chat toggle, dictation mic, sidebar gear). `CoachMarks` shows at most one, 1.5 s after the first terminal is open, chat first then dictation, and each steps aside as soon as the user does the thing.
- **Help › Getting started** ticks the three milestones (`multi`, `chat`, `dictation`) and offers "Show the hints again".

## Icons (`components/icons`)

One stroke set for all chrome, adapted from Lucide (ISC, notice in the file):
24-unit grid, round caps and joins, 1.75 stroke in `currentColor`, rendered at
16px in toolbars, rows and panel headers (14px in dense chips). Icons are
monochrome inline SVGs — the colour comes from the text colour around them,
never from the icon. Do not hand-draw a new glyph inline; add it to
`components/icons/index.tsx` on the same grid. Content glyphs (file-type icons,
agent logos, the IDE app icon) are exempt.

## Anti-patterns (DO NOT)

- **No uppercase tracking** for labels or section headers.
- **No solid semantic fills** behind black text — tint (12–16 %) + coloured text.
- **No boxes inside boxes** — regions are divided by one 1px hairline, never by a rounded, bordered or shadowed container of their own. One line between two neighbours, not one each.
- **No pills or raised surfaces in the chrome** — tabs, tiles and panels are flat; raised/glass surfaces are for chips, menus and things that float.
- **No new shadows** and **no `transition: all`**.
- **No hardcoded core colours** — tokens only; washes use `--wash-*`, `--surface-hover`.
- **No icon libraries** — monochrome inline SVGs, `fill="currentColor"`, 14–16px.
- **No `!important`** except terminal scrollbar overrides.
