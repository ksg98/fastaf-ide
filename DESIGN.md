---
name: FastAF
description: AI-native IDE for multi-agent development
colors:
  accent-blue: "#5aa0f8"
  accent-blue-hover: "#79b3fa"
  well: "#050505"
  frame: "#050505"
  raised: "#161616"
  highlight: "#222222"
  text-primary: "#f0f0f0"
  text-secondary: "#a6a6a6"
  text-muted: "#808080"
  hairline: "rgba(255,255,255,0.08)"
  rim-light: "rgba(255,255,255,0.09)"
  success-green: "#4ade80"
  warning-amber: "#fbbf24"
  attention-orange: "#fb923c"
  error-red: "#f87171"
  merged-violet: "#a78bfa"
  unseen-purple: "#c084fc"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', 'Liberation Sans', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', 'Liberation Sans', sans-serif"
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "'JetBrains Mono', 'Fira Code', 'Hack', 'Cascadia Code', 'Source Code Pro', 'DejaVu Sans Mono', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  panel: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
---

# Design System: FastAF

## 1. Overview

**Creative North Star: "The Quiet Instrument, cut in black glass"**

FastAF is a frame around live terminals. The whole window is one flat black
surface — toolbar, sidebar, tab strip, content, side panels, status bar —
divided the way an editor divides its panes: by 1px hairlines, never by
nesting one box inside another. Nothing in the chrome is a card, a well or a
pill. Anything that floats (menus, palettes, dialogs) is a tinted pane that
frosts what is beneath it. Type carries hierarchy and stays light; colour is
spent only on things that need a glance. Density is welcome, decoration is
not.

**Platform:** Desktop only (Tauri v2 webview). `src/mobile/` is a separate
Capacitor companion app outside this system's scope.

**Key characteristics:**
- **One surface, hairline divisions.** Sidebar, tabs, content, side panels and status bar sit edge to edge on the same black; a single 1px line separates neighbours. No panel cards, no rounded well, no tab pills or underlines.
- **Glass only where it floats.** Buttons and chips carry a top sheen and a 1px rim light; menus, palettes and dialogs are tinted panes that blur the content beneath them. The chrome itself is flat.
- **Type does the work.** 13px system UI, weights 400/500 (600 only for dialog titles and primary buttons), sentence case everywhere. Mono only for terminal content, code and hashes.
- **Icon = kind, dot = state.** Monochrome 14–16px inline SVGs; a coloured 7px dot (or pulsing icon) says busy, waiting, failed, unseen.
- **Tints, not fills.** Semantic colours appear as text, dots and 12–16 % washes — never as solid blocks behind black text.
- **Floating things cast shadows; resting things don't.**

## 2. Colors

Near-black neutrals with no blue tint, one calm accent, and a single pastel
family for semantics. Dark by default. Values live in `src/global.css`
(`:root`) and `src-tauri/src/themes/cursor-dark.json`; themes override them at
runtime.

### Surfaces
- **Content** (#050505): terminals, editors, diffs, recessed inputs.
- **Frame** (#050505): toolbar, sidebar, status bar, side panels. The same black as the content; no key light, no gradient. Regions are told apart by one hairline, not by tone.
- **Raised** (#161616): chips, menus, popovers — always with `--sheen-strong` on top. The active tab is not raised: it is a flat `--wash-1` block.
- **Highlight** (#222222): pressed / strong hover.
- **Hairline**: white at 8 % (16 % when hovered or focused). Rim light: white at 9 % along the top edge of anything raised. Washes: white at 4 / 7 / 7 / 12 %.

### Glass
- **Overlays** (`--surface-overlay`): raised tint at 82 % + `--sheen`, `backdrop-filter: blur(22px) saturate(1.4)`. Menus, palettes, dialogs, toasts, tooltips frost whatever is behind them, on every platform.
- **Frame panes** (`--surface-glass`): frame tint at 60 % + `--sheen`. Sidebar and side panels let the key light through.
- **Vibrancy** (`html.vibrancy`, macOS with transparency not reduced) only lowers those alphas so the desktop shows through the frame too.

### Text
- **Primary** (#f0f0f0), **Secondary** (#a6a6a6), **Muted** (#808080, 5:1 on the frame).

### Accent
- **Accent blue** (#5aa0f8): selection wash at 13 %, active toggles at 16 %, primary buttons, links. Text on the accent is dark (#0b1220).

### Semantic (Tailwind 400 family)
- **Success** #4ade80 · **Warning** #fbbf24 · **Attention** #fb923c (agent needs input) · **Error** #f87171 · **Changes requested** #e3b341 · **Merged** #a78bfa · **Unseen** #c084fc.

### Named rules
**The Tint Rule.** A semantic colour is used as text, a dot, or a
`color-mix(... 12–16%)` wash. Never a solid fill with black text.

**The One Line Rule.** Two neighbouring regions share exactly one 1px
hairline between them — never a border each, never a gap, never a box with
its own edge inside another. Sidebar | content | side panel; toolbar / tab
strip / content / status bar; tile | tile.

## 3. Typography

**UI:** system stack (SF Pro on macOS, Segoe UI, Roboto). **Mono:** JetBrains Mono.

- **Row / control** (400–500, 13px): rows, inputs, buttons, tab labels — the default.
- **Title** (600, 13–15px): repo names, panel and dialog titles.
- **Meta** (400–500, 12px): status bar, section labels, secondary text.
- **Badge** (600, 11px): counts, PR state, keyboard hints.
- **Mono** (400, 13px): terminal, code, diffs, hashes.

**No uppercase tracking.** Section labels are sentence case at 12px/600 in the
secondary colour. Numbers that align use tabular figures.

## 4. Elevation

- **Dropdown** (`0 8px 24px rgba(0,0,0,.45)` + 1px dark ring): menus, popovers, toasts.
- **2XL** (`0 28px 70px rgba(0,0,0,.6)` + ring): dialogs, settings, floating panels.
- **Bottom anchor** (`0 -8px 28px rgba(0,0,0,.45)`): balloons rising from the status bar.

**Flat by default.** Rows, cards and panels at rest have no shadow; raised
controls get the rim light (`--highlight-inset`) and a 1–2px drop. Modals sit
on a 60 % black scrim. Vibrancy (macOS) is opt-in through `html.vibrancy` tokens.

## 5. Components

### Buttons
- 28px tall, 6px radius, 13px/500. **Default**: raised surface + hairline; hover → highlight. **Primary**: accent fill, dark text, 600 weight. **Danger**: transparent with error-tinted text/border. **Ghost**: transparent, hover wash. **Icon**: 26×26 transparent, muted → primary on hover.
- Focus: 3px accent ring at 25 %.

### Inputs
- 28px, recessed (well colour), hairline, 6px radius. Hover strengthens the hairline; focus = accent border + 3px ring at 22 %.

### Tabs
- Flat text tabs filling a 34px strip, square, 12px side padding, 13px/400 in every state. Active = `--wash-1` block with primary text; resting = transparent with a hover wash. State via a 7px dot; kind via icon colour. No pill, no underline, no top bar.
- Multiview tiles: square, one shared hairline between neighbours (1px grid gap, tiles outline into it), 24px flat header.

### Lists (sidebar, files, git changes)
- 28px rows inset 6px with 6px radius. Hover = wash; selected = 13 % accent wash. Actions reveal in place on hover.
- Repo rows: leading chevron, 13px/500. Branch rows: indented 24px, monochrome kind icon, quiet tabular stats on the right, tinted PR pill.

### Side panels
- Frame surface, one hairline on the left edge, header the height of the tab strip (13px/500 title, icon buttons), one hairline under the header.

### Menus, popovers, dialogs
- Raised surface, hairline, 8px radius (12px for dialogs), dropdown/2XL shadow, 4px inset, 28px items.

### Status indicators
- 7px dots: grey idle, accent pulsing busy, green done, purple unseen, orange waiting, red error.
- Badges: 18px tinted pills, 11px/600, tabular numbers. Count bubbles: accent pill with a 2px frame-coloured ring.

### AI Chat
- A conversation, not a control panel. Header: session dot, "AI Chat", terminal chip, history, clear. Composer: one glass field with the turn's knobs as pills beneath the text (Ask/Agent, model, effort; Steps and Approvals in Agent mode) and one accent send button.
- Thread is flat: assistant text on the panel, user turns as quiet washes on the right, tool calls as 26px rows, agent progress / results / errors / approvals as rows at the end of the thread. No banners.
- Empty state teaches by doing: three starter prompts plus a hand-off to the agent.
- Voice: the orb (`VoiceOrb`) is the agent you can watch — halo for the microphone, bright core for its own speech, glint while thinking, grey with a slash when muted. A 16px twin lives in the status bar while a session runs.

### Onboarding
- Three ideas are taught once, in place, then remembered: the empty well's first-run cards (a terminal per branch, split, Multiview), a coach mark on the chat toggle, a coach mark on dictation. At most one callout at a time, never before a terminal is open, and each steps aside as soon as the user does the thing.
- Help › Getting started ticks the three milestones and can bring the hints back.

## 6. Do's and Don'ts

### Do
- **Do** divide regions with one shared hairline; never wrap a region in its own bordered, rounded or shadowed box.
- **Do** keep every control on the 28px / 26px rhythm and the 6px radius.
- **Do** express state with dots and pulses, kind with monochrome icons.
- **Do** tint semantic colour (12–16 %) and keep the accent for selection and primary actions.
- **Do** write labels in sentence case, 12–13px, with weight for hierarchy.

### Don't
- **Don't** use uppercase tracking, side-stripe borders, or accent underlines.
- **Don't** paint solid semantic fills behind black text.
- **Don't** add per-panel borders, gradients, or decorative shadows.
- **Don't** put mono type in chrome (branch names, labels, buttons).
- **Don't** invent new radii, shadows or spacing values — the tokens are the vocabulary.
