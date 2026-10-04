# File Browser & Code Editor

## File Browser Panel

Toggle with `Cmd+E` or the Files icon at the right of the title bar. The file browser shows the directory tree of the active repository (or linked worktree when on a worktree branch).

The file browser, Markdown viewer, and Diff panels are mutually exclusive — opening one closes any other that is open.

### Navigation

- **Arrow keys** (`Up` / `Down`) — Move selection
- **Enter** — Open a file or enter a directory
- **Backspace** — Go up to the parent directory
- **`..` row** — Click to go up one level (appears when inside a subdirectory)
- **Breadcrumb bar** — Click any path segment to jump directly to that directory; click the root `/` to return to the repo root

Directories are listed first, then files. The entry count is shown as a badge in the panel header.

### Sorting

Click the funnel icon in the toolbar to switch sort order:

| Mode | Order |
|------|-------|
| **Name** (default) | Directories first, then alphabetical |
| **Date** | Directories first, then newest modified first |

### Live Refresh

The panel watches the current directory for filesystem changes. When a file is created, deleted, or renamed outside the app, the listing refreshes automatically without a visible loading spinner.

### Git Status Indicators

The panel header shows a legend for git status colors:

| Color | Label | Meaning |
|-------|-------|---------|
| Orange | mod | Modified (unstaged changes) |
| Green | staged | Staged for commit |
| Blue | new | Untracked (new file) |

File and directory names inherit these colors based on their git status. Gitignored entries are shown in a dimmed style.

### View Modes

The file browser supports two view modes, toggled via toolbar buttons:

| Mode | Description |
|------|-------------|
| **List** (default) | Flat directory listing with breadcrumb navigation and `..` parent entry |
| **Tree** | Collapsible hierarchy with lazy-loaded subdirectories. Expand folders by clicking the chevron |

Switching to tree mode resets to the repository root regardless of the current flat-mode subdirectory. When a search query is active, the view always shows flat results.

### Filename Search

Type in the search box to search recursively across the entire repository by filename. Supports `*` and `**` glob wildcards (e.g., `*.ts`, `src/**/*.test.ts`). Results appear with their full path. Clear the query with the `×` button or by emptying the input.

The search icon button to the left of the input toggles between **filename mode** (file icon) and **content mode** (magnifier icon).

### Content Search

Switch to content mode (magnifier icon) to search inside file contents across the repository. Results are grouped by file, showing the matching line number and a highlighted excerpt. Highlights remain aligned on lines containing accented text, symbols, or emoji. Click any result to open the file in the editor, jumping to that line.

Content search options (shown when in content mode):

| Toggle | Meaning |
|--------|---------|
| **Aa** (case icon) | Match case |
| **`.*`** (regex icon) | Use regular expression |
| **`\|ab\|`** (word icon) | Match whole word |

A status bar below the search box shows match counts, files searched, files skipped (binary/large), and a "results limited" notice when the result set is truncated. Search begins after a short debounce and requires at least 3 characters.

### File Operations (Context Menu)

Right-click any entry to open the context menu:

| Action | Shortcut | Notes |
|--------|----------|-------|
| Copy Path | — | Copies the full absolute path to the clipboard |
| Copy | `Cmd+C` | Files only; stores the file (or every selected file) in the internal clipboard |
| Cut | `Cmd+X` | Files only; cut entries are shown dimmed |
| Paste | `Cmd+V` | Pastes into the right-clicked folder, or beside the right-clicked file; disabled when clipboard is empty |
| Rename… | — | Opens a rename dialog; enter the new name and confirm |
| Delete | — | Requires confirmation; directories are deleted recursively |
| Add to .gitignore | — | Appends the entry's path to `.gitignore`; disabled if already ignored |

The keyboard shortcuts (`Cmd+C`, `Cmd+X`, `Cmd+V`) also work when the file browser has focus, without opening the context menu.

Cut + Paste performs a move. Copy + Paste copies the file. A paste never overwrites anything: a copy whose name is already taken lands beside it as `name copy.ext` (then `name copy 2.ext`, and so on), so pasting a file into its own folder duplicates it. A move whose name is taken is skipped, and a toast names the file. Pasted files come up selected.

### Selecting Several Files

Works in both the flat list and the tree view:

| Gesture | Effect |
|---------|--------|
| `Cmd+Click` (`Ctrl+Click` on Windows/Linux) | Adds the row to the selection, or takes it out |
| `Shift+Click` | Selects every row from the last-clicked one to this one — in tree view, including the rows of expanded folders |
| `Cmd+A` | Selects every row on screen |
| `Escape`, or a click on empty space | Clears the selection |

A selection click never opens a file or expands a folder. Selected rows are tinted more strongly than the row of the file open in the editor.

With several rows selected, `Cmd+C` / `Cmd+X` put every selected file on the clipboard, and right-clicking a selected row offers **Copy N Files**, **Cut N Files** and **Paste** for the whole selection. Right-clicking a row outside the selection selects just that row. Folders are left out of a copy — only files can be copied — and a toast says so. Rename, Delete and the other single-item actions work on one row: click it first.

`Cmd+V` pastes into the folder on screen in the flat list. The tree view has no current folder of its own, so it pastes where you last clicked: into that folder, or beside that file (the repo root when nothing is selected).

### Opening Files

- **Click a file** — Opens it in the code editor (see below), or in the Markdown viewer if the extension is `.md` or `.mdx`
- **Click a content search result** — Opens the file and jumps to the matching line number

### Panel Resize

Drag the left edge of the panel to resize it. Range: 200–800 px.

---

## Code Editor

Clicking a non-Markdown file opens it in an in-app code editor tab in the main tab area, alongside terminal tabs.

### Features

- **Syntax highlighting** — Auto-detected from file extension; disabled for files larger than 500 KB
- **Line numbers**, bracket matching, active line highlight, indentation support
- **Save** — `Cmd+S` saves the file when the editor tab is focused

### Read-Only Mode

Click the padlock icon in the editor tab header to toggle read-only mode. When locked, the file cannot be edited.

### Unsaved Changes

An unsaved-changes dot appears in both the tab bar and the editor header when the file has been modified but not saved.

### Disk Conflict Detection

If the file changes on disk while you have unsaved edits, a conflict banner appears with two options:

- **Reload** — Discard local edits and load the disk version
- **Keep mine** — Dismiss the banner; the next save overwrites the disk version

When the editor has no unsaved changes, files reload silently when they change on disk.

---

## Markdown Viewer

`.md` and `.mdx` files open in the Markdown viewer panel instead of the code editor. The viewer renders Markdown with syntax-highlighted code blocks.

See [ai-agents.md](ai-agents.md) for how AI-generated plan files are detected and surfaced as a one-click shortcut to open in the viewer.
