# FastAF — Visual Style Guide

Reference for all UI/CSS/layout work. Every visual change MUST follow this guide.

## Design Philosophy

**Quiet instrument.** The app is a frame around live terminals. The frame
(toolbar, sidebar, status bar, side panels) is one continuous surface; the
content (terminals, editors, diffs) sits in a recessed, darker **well** with a
soft rounded edge. Tone separates regions, so hairlines are rare. Type carries
hierarchy (weight and size, never uppercase tracking). Icons are monochrome and
say *what kind*; a coloured dot says *what state*. Colour is spent only on
things that need a glance.

## Application Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│ #toolbar (32px, transparent over the frame, drag region, no hairline)    │
│ [AF] [filter][sidebar]   repo / branch chip          [⚡][bell][search] │
├──────────────────────────────────────────────────────────────────────────┤
│ #app-body (flex row)                                                     │
│ ┌───────────┬───────────────────────────────────────┬──────────────────┐ │
│ │ #sidebar  │ #main                                  │ side panel       │ │
│ │ frame     │  #tab-bar (36px, pill tabs, no line)   │ frame surface    │ │
│ │ surface   │  ┌─ #terminal-container ────────────┐  │ 36px header      │ │
│ │           │  │  the WELL: --bg-primary,          │  │ 28px rows        │ │
│ │ repo rows │  │  radius 10px, 8px gap on the      │  │                  │ │
│ │ branch    │  │  right/bottom/left, 1px soft edge │  │                  │ │
│ │ rows      │  │                                    │  │                  │ │
│ │           │  └────────────────────────────────────┘  │                  │ │
│ │ git row   │                                        │                  │ │
│ │ footer    │                                        │                  │ │
│ └───────────┴───────────────────────────────────────┴──────────────────┘ │
├──────────────────────────────────────────────────────────────────────────┤
│ #status-bar (28px, transparent, 12px type, ghost icon toggles)           │
└──────────────────────────────────────────────────────────────────────────┘
```

**Key structural rules:**
- `#app` is `flex-direction: column`, fills 100vh × 100vw. `body` paints the frame (`--bg-app`).
- `#app-body` is `flex-direction: row`, `flex: 1`, `min-height: 0`.
- The sidebar is fixed-width (resizable 200–500px) and has **no right border**; the well's edge does the separating.
- `#terminal-container` is the well: `margin: 0 var(--well-gap) var(--well-gap)`, `border-radius: var(--well-radius)`, `box-shadow: 0 0 0 1px var(--border-subtle)`. In focus mode it also gets a top gap.
- Side panels (Files, Git, Ideas, AI Chat) are frame-coloured, no left border, 36px header.
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
| `--well-gap` / `--well-radius` | 8px / 10px |
| `--toolbar-height` | 32px |
| `--tab-bar-height` | 36px (26px pill tabs inside) |
| `--status-height` | 28px |
| `--space-1 … --space-10` | 4px grid |

Use `gap` on flex containers, not margins between children. Rows are inset 6px
from the panel edge so hover/selection washes read as rounded pills.

## Border radius

| Variable | Value | Usage |
|----------|-------|-------|
| `--radius-sm` | 4px | Tiny chips, kbd |
| `--radius-md` | 6px | Rows, controls, tabs, chips |
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
- `.iconBtn` — 26×26, `--fg-muted` → `--fg-primary` on hover, `--surface-hover` wash.
- `.input` / `.textarea` / `.select` — 28px, **recessed** (`--bg-primary`), hairline, focus = accent border + 3px 22 % ring.
- Focus for keyboard users: `box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0.25)`.

## Component reference

### Sidebar
- Repo row: 28px, leading `›` chevron (rotates 90° when open), name 13px/600 `--fg-primary`, hover reveals `⋯` and `+` in place (no overlap).
- Branch row: 28px, indented 24px, 16px monochrome icon (shape = kind), name 13px/400 `--fg-primary`, diff stats as quiet tabular figures on the right (hidden under 240px unless hovered/active), PR state as a tinted pill.
- Selection: `rgba(var(--accent-rgb), 0.13)` wash. Hover: `--surface-hover`. No stripes, no solid fills.
- Icon colour is reserved for states: busy = accent pulse, question = `--attention` pulse, error = `--error` pulse, unseen = `--unseen`. Main/worktree/idle are grey.
- Terminal rows under a branch: 24px, 7px status dot.
- Git row: icon-only under 260px (labels return when wider). Footer: 36px, ghost buttons.

### Tab bar
- Tabs are 26px pills with a 7px dot (state) or a type-coloured icon. Active = `--bg-tertiary` pill with a 1px soft edge; inactive = transparent, hover wash. No accent underline/top bar. Close button appears on hover.

### Status bar
- 28px, 12px text. Left: zoom chip, status, cwd. Right: 26px ghost icon toggles; an **open panel lights its toggle** (`.toggleActive` = 16 % accent wash + accent icon). Count bubbles are accent pills with a 2px frame-coloured ring.

### Side panels (`shared/panel.module.css`)
- 36px header, 13px/600 title, icon buttons on the right, one hairline below.
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
The well keeps a 14px gutter to match the terminal's own scrollbar. Sidebar
list: 8px gutter.

## AI Chat panel

A conversation, not a control panel (`components/AIChatPanel`):

- **Header** carries only what the chat is attached to (session dot + terminal chip), history, clear, window controls.
- **Composer** is one glass field: textarea on top, a chip row beneath. Left chips shape the turn (Ask/Agent, model, effort; Steps and Approvals appear in Agent mode). Right: voice, dictate, and the single accent send button. Chips are native `<select>`s dressed as pills so macOS pops the system menu.
- **Thread** is flat: assistant text sits on the panel, user turns are `--wash-1` blocks on the right, tool calls are 26px expandable rows, and agent progress, results, errors and approvals are rows at the *end* of the thread (`.statusRow`, `.errorBanner`, `.approvalCard`), never banners above it.
- **Empty state** teaches by doing: three starter prompts that send on click plus a hand-off to Agent mode.
- **Voice stage** (`.voiceStage`) shows the `VoiceOrb` (`components/ui/VoiceOrb.tsx`): a canvas sphere fed by the mic level and the speaker level from `voice_status`. Idle breathes, listening grows a halo, speaking brightens the core, thinking orbits a glint, muted drains to grey. A 16px twin sits in the status bar while a session runs.

## Onboarding

Three ideas the chrome cannot explain are taught once, in place (`components/Onboarding`, state in `stores/onboarding.ts`, persisted in localStorage):

- **WelcomeWell** replaces the empty well's placeholder on a fresh install: a terminal per branch, split the well, Multiview — with the user's real shortcuts. Dismissed by "Got it".
- **CoachMark** is a glass callout pinned above a `data-coach="…"` anchor (status-bar chat toggle, dictation mic, sidebar gear). `CoachMarks` shows at most one, 1.5 s after the first terminal is open, chat first then dictation, and each steps aside as soon as the user does the thing.
- **Help › Getting started** ticks the three milestones (`multi`, `chat`, `dictation`) and offers "Show the hints again".

## Anti-patterns (DO NOT)

- **No uppercase tracking** for labels or section headers.
- **No solid semantic fills** behind black text — tint (12–16 %) + coloured text.
- **No hairline per edge** — let the well/frame tone do the separating.
- **No new shadows** and **no `transition: all`**.
- **No hardcoded core colours** — tokens only; washes use `--wash-*`, `--surface-hover`.
- **No icon libraries** — monochrome inline SVGs, `fill="currentColor"`, 14–16px.
- **No `!important`** except terminal scrollbar overrides.
