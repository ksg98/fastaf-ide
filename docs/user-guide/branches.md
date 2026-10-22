# Branch Management

FastAF has a built-in Branches tab inside the Git Panel. It lets you view, create, delete, rename, merge, rebase, push, pull, and compare branches — all without leaving the app.

## Opening the Branch Panel

Three ways to open it:

- **`Cmd+G`** — Opens the Git Panel directly on the Branches tab
- **Click the "GIT" vertical label** in the sidebar — Opens the Git Panel on the Branches tab
- **`Cmd+Shift+D`**, then click the "Branches" tab header — Opens the Git Panel on the last active tab; click Branches to switch

## Branch List Overview

At the top, a strip names the branch you are on (or "Detached at <hash>" when HEAD is detached), its upstream and its ahead/behind counts, with a smart-prompt chip on the right — **Create PR** by default, or the last branch prompt you ran; its arrow lists the others.

Under it, the filter, **+** (New branch) and **⋯** (Branch options), then three collapsible sections:

- **Recent** — branches you checked out recently (from the git reflog), the current one left out since the strip shows it
- **Local** — all branches in your local repo
- **Remote** — tracking branches from all remotes

Each branch row displays:
- Branch name (a check marks the current branch)
- Ahead/behind counts relative to its upstream (e.g. `↑2 ↓1`), and `⇣N` when it is behind the default branch
- **Merged**, in purple — the branch is already merged into the default branch
- The age of the last commit (`25m`, `3h`, `2d`, `3w`, `4mo`, `1y`)
- Stale dimming — branches with no commit in the last 30 days appear dimmed

Hover a row for its last commit: date, author and message.

## Prefix Folding

When you have many branches following a naming convention (`feature/`, `bugfix/`, `chore/`), prefix folding groups them:

- Branches sharing a common `/`-delimited prefix collapse under a row with a chevron and a count (e.g. `feature/  5`); the branches inside show their name without the prefix (hover for the full name)
- Click the group row (or `Tab` to it and press `Enter`) to expand or collapse it
- **⋯ › Group by prefix** turns folding on and off (checked while it is on)

## Search / Filter

Type in **Filter branches** to narrow the list by name. The filter applies to Recent, Local and Remote at once — their counts read shown/total — and "No branches match" shows when nothing does. `↓` moves into the list, `Escape` clears the filter, and `/` jumps back to it from the list.

## Keyboard Operations

The Branches panel is mouse-first: branch actions live in the right-click context menu and the **+** (New branch) button. Only list navigation is on the keyboard:

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate branches |
| `/` | Focus the filter |
| `Escape` | Clear filter / deselect |

While the right-click menu is open, its shortcut hints work: `⏎` Checkout, `⇧M` Merge into current, `r` Rebase onto, `⇧P` Push, `p` Pull, `f` Fetch, `⇧R` Rename, `d` Delete.

Switching between Git Panel tabs:

| Key | Tab |
|-----|-----|
| `Ctrl/Cmd+1` | Changes |
| `Ctrl/Cmd+2` | Log |
| `Ctrl/Cmd+3` | Stashes |
| `Ctrl/Cmd+4` | Branches |

## Checkout

Right-click a branch → **Checkout** to check it out (a remote branch offers **Checkout (create local)**).

If your working tree has uncommitted changes, a dialog appears with three options:
- **Stash and switch** — stashes your changes, then checks out
- **Force switch** — discards changes and checks out
- **Cancel** — aborts the checkout

## Create Branch

Click **+** (New branch), next to the filter, to open the inline branch creation form:

1. Type the new branch name (it has the whole first line)
2. Optionally change the start point with the **from HEAD** chip
3. Leave **Check out** on to switch to the new branch, or turn it off
4. Press `Enter` (or **Create**) to confirm, or `Escape` (or **Cancel**) to cancel — **Create** stays disabled until there is a name

## Delete Branch

Right-click a branch → **Delete**.

- Uses safe delete (`git branch -d`) by default — refuses to delete unmerged branches
- A confirmation prompt lets you switch to force-delete (`git branch -D`) if needed
- Deleting the current branch or the default branch (`main`, `master`, `develop`) is blocked

### Delete merged branches (bulk)

**⋯ › Delete N merged branches…** deletes every local branch already merged into the default branch at once, after confirming a dialog that lists the targets; the item is disabled when no branch qualifies. Each deletion uses safe `git branch -d`, so a branch that isn't truly merged is kept rather than force-deleted.

## Rename Branch

Right-click a branch → **Rename** to edit the branch name inline. The current name is pre-filled. Press `Enter` to confirm or `Escape` to cancel.

## Merge

Right-click a branch → **Merge into current** to merge it into the current branch. The merge runs in the background, and the result is shown as a toast: a conflict error on failure, "Already up to date" when there was nothing to merge, or a success toast with a one-click **Delete branch** action to clean up the branch you just merged.

## Rebase

Right-click a branch → **Rebase onto** to rebase the current branch onto the selected branch. Runs in the background; conflicts are reported.

## Push

Right-click a branch → **Push**. If no upstream is set, FastAF automatically configures the tracking relationship (`--set-upstream origin <branch>`).

## Pull

Right-click a branch → **Pull** to pull the current branch from its upstream.

## Fetch

Right-click a branch → **Fetch** to fetch all remotes (`git fetch --all`).

## Context Menu

Right-click any branch for the full context menu:

| Action | Description |
|--------|-------------|
| Checkout | Switch to this branch |
| Merge into current | Merge this branch into the current one |
| Rebase onto | Rebase the current branch onto this one |
| Compare with current | Show `git diff --name-status` between this branch and current |
| Push | Push this branch |
| Pull | Pull this branch |
| Fetch | Fetch all remotes |
| Update from base (rebase) | Rebase this branch onto its base branch |
| Rename | Rename inline |
| Delete | Delete branch (safe by default) |
| Copy name | Copy the branch name |

The current branch offers Push, Pull, Fetch, Update from base, Rename and Copy name; a remote branch offers Checkout (create local), Fetch, Compare with current, Open on GitHub and Copy name.

## Stale and Merged Indicators

- **Stale** (dimmed): the branch has no commits in the last 30 days — a visual cue that it may be abandoned
- **Merged** (purple text): the branch has been merged into the default branch and is safe to delete
