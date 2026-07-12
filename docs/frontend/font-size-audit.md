# Font Size Audit

**Date:** 2026-05-11
**Purpose:** Harmonize font sizes across all panels, modals, and overlays.

## Scale

| Variable | Size |
|---|---|
| `--font-2xs` | 10px |
| `--font-xs` | 11px |
| `--font-sm` | 12px |
| `--font-md` | 13px |
| `--font-base` | 14px |
| `--font-lg` | 15px |
| `--font-xl` | 16px |
| `--font-2xl` | 18px |
| `--font-3xl` | 24px |

## Current State

### Panels

| Component | Title | Label | Content | Hint/Detail | Button |
|---|---|---|---|---|---|
| FileBrowser | — | `sm` | `md` | `xs` | — |
| References | — | — | `sm` | `xs` | — |
| Outline | — | — | `sm` | `xs` | — |
| TaskQueue | `lg` | `sm` | `base` | `sm` | `sm` |
| Sidebar | — | `sm` | `md` | `xs` | `sm` |
| AIChatPanel | — | `sm` | `base` | `xs` | `sm` |

### Settings Panel

| Component | Title | Label | Content | Hint/Detail | Button |
|---|---|---|---|---|---|
| Settings shell | `xl` | **`base`** | **`base`** | `sm` | **`md`** |
| Settings nav | `xs` | **`lg`** | — | — | — |
| AgentsTab | — | **`base`** | `sm` | `2xs` | `sm` |
| GitHubTab | `lg` | `sm` | `sm` | `xs` | `sm` |
| PluginsTab | — | **`base`** | `sm` | `xs` | `sm` |
| SmartPromptsTab | — | **`base`** | `sm` | `2xs` | `sm` |
| DictationSettings | — | — | **`base`** | `sm` | **`md`** |

### Overlays / Dialogs

| Component | Title | Label | Content | Hint/Detail | Button |
|---|---|---|---|---|---|
| CommandPalette | — | `base` | `sm` | `xs` | — |
| BranchSwitcher | — | `base` | `base` | `sm` | — |
| PromptOverlay | — | — | `base` | `sm` | — |
| ContextMenu | — | — | `base` | `sm` | — |
| ConfirmDialog | `lg` | — | — | — | `md` |
| CreateWorktree | — | `sm` | `md` | `xs` | `sm` |

## Dominant Pattern

| Role | Panels | Settings (current) | Overlays/Dialogs |
|---|---|---|---|
| Title/heading | `lg` | `xl` (shell h2), `lg` (section h3) | `lg` |
| Label | `sm` | **`base`** (+2px) | `base` / `sm` |
| Content/input | `sm`–`md` | **`base`** (+1-2px) | `base` |
| Hint/detail | `xs` | `sm` (+1px) | `sm` / `xs` |
| Nav item | `sm` | **`lg`** (+3px) | — |
| Button (in-panel) | `sm` | **`md`** (+1px) | `md` (footer) |
| Toggle label | `sm` | **`base`** (+2px) | — |

## Target (harmonized)

Settings should match the panel/overlay scale. Proposed target:

| Role | Target | CSS Variable |
|---|---|---|
| Modal title (h2) | `lg` | `--font-lg` |
| Section heading (h3) | `md` | `--font-md` |
| Nav item | `md` | `--font-md` |
| Form label / toggle label | `sm` | `--font-sm` |
| Content / input / select | `sm` | `--font-sm` |
| Hint / secondary text | `xs` | `--font-xs` |
| In-panel button | `sm` | `--font-sm` |
| Footer / dialog button | `sm` | `--font-sm` |
| Slider value | `sm` | `--font-sm` |

## Hardcoded px values (off-scale)

| File | Value | Should be |
|---|---|---|
| McpPopup.module.css | `10px`, `11px`, `12px`, `13px` | `2xs`, `xs`, `sm`, `md` |
| KnowledgeHistoryOverlay.module.css | `10px` | `2xs` |
| shared/dialog.module.css | `11px` | `xs` |
| Sidebar.module.css (remoteBadge) | `9px` | below scale — keep or raise to `2xs` |
| OutlinePanel.module.css (kindBadge) | `10px` | `2xs` |
| AIChatPanel.module.css | `13px`, `10px` | `md`, `2xs` |

## Changes Required

### Settings.module.css

| Selector | Current | Target |
|---|---|---|
| `.header h2` | `xl` | `lg` |
| `.navItem` | `lg` | `md` |
| `.section h3` | `lg` | `md` |
| `.group label` | `base` | `sm` |
| `.group select/input` | `base` | `sm` |
| `.hint` | `sm` | `xs` |
| `.hintInline` | `sm` | `xs` |
| `.info` | `base` | `sm` |
| `.warning` | `base` | `sm` |
| `.toggle span` | `base` | `sm` |
| `.slider span` | `base` | `sm` |
| `.footerReset` | `md` | `sm` |
| `.footerDone` | `md` | `sm` |
| `.actions button` | `md` | `sm` |
| `.saveBtn` | `md` | `sm` |
| `.groupName` | `base` | `sm` |
| `.groupNameInput` | `base` | `sm` |
| `.input` | `base` | `sm` |
| `.urlRow label` | `base` | `sm` |
| `.urlFull` | `base` | `sm` |
| `.mcpStatusText` | `base` | `sm` |
| `.downloadBtn` | `base` | `sm` |
| `.schedulerUnitSelect` | `base` | `sm` |
| `.schedulerCronInput` | `base` | `sm` |
| `.schedulerGoalInput` | `base` | `sm` |

### Tab-specific CSS

| File | Selector | Current | Target |
|---|---|---|---|
| PluginsTab.module.css | `.pluginName` | `base` | `sm` |
| AgentsTab.module.css | `.agentName`, `.configName` | `base` | `sm` |
| SmartPromptsTab.module.css | `.promptName` | `base` | `sm` |
| DictationSettings.module.css | various | `base`/`md` | `sm` |
