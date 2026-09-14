# Chunk 5 — repo watcher, git-panel refresh, batching

Reserved finding ids: **F40–F49**. Format mirrors `performance_scan.md`.

Read-only pass. Every measurement was taken against the **live orchestrator
instance** (`:9876`) and its config dir on 2026-08-16 between 12:05 and 12:20
CEST; no session was created or closed, no repo was mutated.

---

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src-tauri/src/repo_watcher.rs` (full, 1–920 + tests) | 2026-08-16 | F40, F41, F42 |
| `src-tauri/src/state.rs` (`GitCacheState` 2743–2843, `invalidate_repo_caches` 2866) | 2026-08-16 | F49, contributes to F48 |
| `src-tauri/src/content_index.rs` (`rebuild_index` 380–428, updater 431–455, `build` 139–200) | 2026-08-16 | F43, F44, F45 |
| `src-tauri/src/git.rs` (`get_repo_info_impl` 275, `get_repo_structure_impl` 1587, `get_repo_diff_stats_impl` 1627, `get_working_tree_status` 2523, `enrich_with_numstat` 2504) | 2026-08-16 | F47, F49 |
| `src-tauri/src/git_reads.rs` (port + `worktree_paths` adapters, gix handle cache 99–120) | 2026-08-16 | contributes to F49 |
| `src-tauri/src/config.rs` (`load_app_config` 2070–2095) | 2026-08-16 | F43 |
| `src-tauri/src/fs.rs` (`ALWAYS_EXCLUDED_DIRS` 136–168) | 2026-08-16 | F42 |
| `src-tauri/src/lib.rs` (`clear_repo_caches` 284) | 2026-08-16 | F48 |
| `src/hooks/useAppInit.ts` (`head-changed` 330–350, `repo-changed` 353–409) | 2026-08-16 | F48, contributes to F40 |
| `src/hooks/revisionCoalescer.ts` | 2026-08-16 | clean (per-frame, lossless) |
| `src/hooks/git/createRepositoryRefreshCoordinator.ts` (full) | 2026-08-16 | contributes to F40/F49 |
| `src/stores/repositories.ts` (`getHotRepoPaths` 12–22, `bumpRevision`/`getRevision` 747–755) | 2026-08-16 | contributes to F40 |
| `src/stores/repoSettings.ts` (`loadLocalConfig` 235–243) | 2026-08-16 | contributes to F48 |
| `src/components/GitPanel/GitPanel.tsx` (tab switch 104–160) | 2026-08-16 | clean (`Switch`/`Match`, one tab mounted) |
| `src/components/GitPanel/{Log,Branches,Stashes,History,Changes}Tab.tsx` (revision effects) | 2026-08-16 | F46, F47 |
| `src/components/StatusBar/StatusBar.tsx` (180–207) | 2026-08-16 | F47 |
| `src/components/CodeEditorPanel/CodeEditorTab.tsx` (357–475) | 2026-08-16 | F46; see Open questions (5s poll) |
| `src/components/{DiffTab,AiTriagePanel,WorktreeManager}` revision effects | 2026-08-16 | F46; AiTriage clean (debounce + single-flight) |
| `src/stores/aiTriageStore.ts` (`runTriage` 180–225) | 2026-08-16 | clean (debounced, single-flight) |

---

## Findings

### F40 — the working-tree `repo-changed` trigger has no dedupe, and it fires ~760 times/hour for one repo (P2)

**Measured, live logs, `GET :9876/logs?source=repo_watcher`.** The log store
coalesces consecutive identical entries (`app_logger.rs:144`), so `repeat_count`
is an exact emit count for the run.

| Window (CEST, 2026-08-16) | Emits | Repo | Rate |
|---|---|---|---|
| 00:54:30 → 01:54:29 (3599 s) | 759 | `…/CC_Playground/brainstorming` | 1 / 4.74 s |
| 02:04:51 → 03:04:49 (3599 s) | 751 | same | 1 / 4.79 s |
| 11:45:12 → 12:11:53 (1601 s) | 178 | same | 1 / 9.0 s |

Both hour-long windows are overnight, so these are not user edits.

`repo_watcher.rs:787-812` is the only emit path with **no** semantic guard. The
git-state path at `:757-784` computes `repo_git_fingerprint` and returns early
when nothing meaningful moved; the HEAD path at `:707-746` compares the resolved
HEAD target (and counts suppressions in `repo_head_emits_suppressed`). The
working-tree path emits unconditionally after its debounce.

**Answer to the chunk-2 open question: the repeats are real, distinct filesystem
writes — not FSEvents chatter — but they are writes to files git itself ignores.**
Verified by a 70 s mtime poll of that tree (2 s sampling, `.git` excluded), which
found exactly these changes:

```
3 ./piscina/.claude/hud-budget.json      ← ignored by piscina/.gitignore: **/hud-budget.json
2 ./piscina/domotica/.env                ← ignored by piscina/.gitignore: .env
1 ./piscina/.mdkb/{index,code}.sqlite    ← ignored by the ROOT .gitignore → correctly Noise
1 ./.gitignore
```

The surviving triggers are all files a nested `.gitignore` excludes — see **F41**
for why the watcher cannot see those rules. The measured rate (1 emit / 4.7–9 s)
is above what a 2 s mtime poll can resolve (atomic write-then-rename leaves no
trace), so the true event count is ≥ the count above.

Aggravating detail: `brainstorming` is registered as a **hot** repo
(`getHotRepoPaths`, `repositories.ts:12-16` — any branch with ≥1 terminal), so it
takes `WORKING_TREE_DEBOUNCE` = 1500 ms, not the 15 s cold delay
(`repo_watcher.rs:793-797`).

Downstream cost per emit — the frontend handler at `useAppInit.ts:374-409` does,
unconditionally:
1. `invoke("clear_repo_caches")` (redundant, **F48**),
2. `invoke("load_repo_local_config")` — `.tuic.json` re-read,
3. `revisionCoalescer.bump()` → the 25 `getRevision` subscribers (**F46**),
4. after 500 ms, `refreshAllBranchStats(repo)` → `get_repo_structure` +
   `get_repo_diff_stats` + `detect_orphan_worktrees` (**F49**),

plus, on the Rust side, an `AppEvent::RepoChanged` on the global bus →
`load_app_config()` (**F43**) → a full BM25 re-index (**F44**).

**Why the obvious fix is wrong.** Reusing `repo_git_fingerprint` on this path
would suppress two things the emit legitimately carries:
- edits inside a **linked worktree** — the fingerprint is computed from the *main*
  checkout's index + porcelain, which is exactly the case the doc comment at
  `repo_watcher.rs:129-139` says the fingerprint cannot cover;
- file changes in a **non-git registered directory** (`brainstorming` is one —
  `git status` there returns "not a git repository"), where the porcelain is
  permanently empty but `FileBrowserPanel.tsx:303` and the editor disk-check
  legitimately want the revision bump.

The correct fix is **F46** (discriminate the event) plus **F41** (stop
classifying git-invisible files as changes), not a blanket fingerprint guard.

**Coverage of the `head_emits_suppressed` guard (issue #82):** it is wired into
the **HEAD** path only (`repo_watcher.rs:721-723`). Neither the git-state nor the
working-tree path increments it, so this storm is invisible in the diagnostics
snapshot.

### F41 — the watcher's gitignore matcher reads only the root `.gitignore`; nested, global and `info/exclude` rules are invisible (P2)

`build_gitignore` (`repo_watcher.rs:252-261`) builds the matcher from
`repo_root/.gitignore` and nothing else. `classify_in_working_tree`
(`:120-126`) is the only ignore test on the event path. Consequences:

- **nested `.gitignore` files are not applied.** `piscina/.gitignore` ignores
  `**/hud-budget.json`, `.env`, `.mdkb/`, `domotica/P42-build/`; every write under
  those still classifies as `WorkingTree`. This is the direct cause of F40's
  measured storm.
- **`.git/info/exclude` and the global gitignore are not applied** either
  (`GitignoreBuilder::add` on one file only).

The same file already knows better: `collect_working_tree_dirs`
(`repo_watcher.rs:378-390`) uses `ignore::WalkBuilder` with `git_ignore(true)`,
which honours nested `.gitignore` files, and `ContentIndex::build`
(`content_index.rs:153-159`) uses `git_ignore(true).git_global(true).git_exclude(true)`.
So **the indexer excludes the very file whose write scheduled the rebuild** — the
work is triggered by an event the work then discards.

Second cost on the same path: the `.gitignore`-changed check at
`repo_watcher.rs:642-647` matches **any** file named `.gitignore` anywhere in the
event batch — including nested ones and ones inside ignored trees — and rebuilds
the root matcher (a `GitignoreBuilder::build()`, i.e. a globset compile) on
notify's event-callback thread. A tool that writes many nested `.gitignore` files
recompiles the root globset once per event batch, for a matcher that did not
change.

### F42 — a nested git repo's whole `.git/` reaches the emitter as working-tree changes (P2)

`classify_in_working_tree` (`repo_watcher.rs:110-118`) tests **only the first
path component** against `crate::fs::ALWAYS_EXCLUDED_DIRS` (`fs.rs:136-156`,
which does contain `.git`, `.mdkb`, `node_modules`, `target`, …). For
`piscina/.git/objects/ab/cdef` the first component is `piscina`, so the exclusion
never applies; the root `.gitignore` does not list `.git` (git's own implicit
`.git` exclusion is not part of an `ignore::Gitignore` built from a file); the
path therefore classifies as `WorkingTree`.

`classify_path` strips only the **outer** repo's `git_dir` (`:41`), so the
`.git`-internal categories (Head/GitState/Noise) apply to exactly one `.git` per
watcher. Every other `.git` in the tree is working-tree content.

Concrete exposure in the observed tree: `/…/brainstorming` (registered, non-git)
contains at least `piscina/` as a nested git repo — `piscina/.git/hooks/post-commit`
had mtime 11:31:10 during the sample. Any `git status`/`fetch`/`gc` an agent runs
inside a nested repo writes `index.lock`, `objects/**`, `logs/**` — all of which
reach `CategoryEmitter` as `WorkingTree`. `.git/objects` churn is precisely the
inotify flood that issue #82 fixed for the *outer* `.git` on Linux; nested repos
bypass that fix on every platform.

Verified by code inspection. Not isolated at runtime — I could not separate
nested-`.git` events from F41's events without adding instrumentation, which is
out of scope for a read-only pass.

### F43 — every `RepoChanged` bus event does a cross-process-locked config file read (P2)

`spawn_content_index_updater` (`content_index.rs:437-439`):

```rust
Ok(AppEvent::RepoChanged { repo_path }) => {
    if crate::config::load_app_config().index_strategy != "disabled" {
        rebuild_index(&state, &repo_path);
    }
}
```

`load_app_config` (`config.rs:2070-2095`) takes the process-wide
`config_write_lock()`, then **acquires the cross-process advisory file lock**
(`file.acquire_file_lock()`), then reads and JSON-parses `config.json` from disk,
with a conditional migration **write** on the same path.

This runs before the `REBUILD_COOLDOWN` guard, so it happens on *every* event —
at F40's measured rate that is ~760 lock-acquire + read + parse cycles per hour
for one repo, to read one string field that is already reachable without I/O.
`config.json` is 2152 bytes here (measured), so the parse is trivial; the cost is
the file-lock round trip, and the contention it creates with any concurrent
config save — including a second debug instance, which AGENTS.md documents as
sharing the same config dir and the same lock.

### F44 — a git-invisible file write schedules a full, non-incremental BM25 re-index of the whole repo, once a minute, forever (P2)

`rebuild_index` (`content_index.rs:380-428`) calls
`ContentIndex::build(repo_root, …)` — a **full** walk of the repo that reads
every text file up to `MAX_FILE_SIZE` = 1 MB and rebuilds the BM25 corpus from
scratch (`content_index.rs:139-200`). `FileEntry.mtime` and `path_to_idx` exist
and are documented as "for future incremental rebuilds"
(`content_index.rs:87-92`); nothing uses them. The only carry-over between builds
is `known_binaries`, itself a full `HashMap` clone per rebuild
(`content_index.rs:400`).

Guards that do hold: `REBUILD_COOLDOWN` = 60 s (`content_index.rs:24, 393`),
`index_in_flight` (`:397`), the `index_build_sem` permit, and the cooperative
`IndexerThrottle` (10 ms sleep every 50 files, plus a full stop while a search is
in flight).

Net effect for the repo in F40: the cooldown clamps 760 emits/h down to **60 full
re-index passes per hour**, sustained indefinitely, driven by a HUD status file
that `ContentIndex::build`'s own `git_ignore(true).git_global(true).git_exclude(true)`
walker then excludes (F41). The 10 ms/50-files throttle bounds the CPU rate but
not the total work: it converts the cost into wall-clock occupancy of an
`index_build_sem` permit — a 5000-file repo pays ≥1 s of pure throttle sleep per
pass before counting I/O and tokenisation.

Estimate flag: the 60/h figure is derived (measured emit rate ÷ the 60 s cooldown
constant), not observed — the rebuild trace lines are at `trace`/`debug` level and
were not present in the fetched log window.

### F45 — `content_indices` is never reaped (P2)

`AppState.content_indices` (`state.rs:1371`) is a
`DashMap<String, Arc<RwLock<ContentIndex>>>`. Grepping every reference in
`src-tauri/src` shows `entry`/`get`/`insert`/`iter`/`contains_key` and **no
`.remove(` or `.retain(` anywhere** (`content_index.rs:331, 385`, `fs.rs:562`,
`ai_agent/tools.rs:4548, 4580`, plus test-only inserts).

`stop_watching` (`repo_watcher.rs:889-895`) retires `repo_head_targets` and
`repo_git_fingerprints` but not this; `handleRemoveRepo`
(`useGitOperations.ts:189-219`) calls `stop_repo_watcher` and drops the repo from
both stores, and nothing on either side frees the index.

The retained value is not a POD: a `bm25::SearchEngine<u32>` over every text file
in the repo, plus `entries: Vec<FileEntry>`, `path_to_idx: HashMap<String, usize>`
and `known_binaries: HashMap<String, u64>` — tens of MB for a large repo, held for
the process lifetime after the user removes the repo from the sidebar. This is
the same class as F6/F8 but with the largest per-entry value found so far.

Not measured: I did not size a live index (there is no command that reports it).
The magnitude claim is derived from the struct definition and `MAX_FILE_SIZE`.

### F46 — `repo-changed` carries no change kind, so commit-history panels re-run `git log` on working-tree edits (P3)

`RepoChangedPayload` (`repo_watcher.rs:238-241`) is `{ repo_path }`. Both the
git-state trigger and the working-tree trigger emit the identical payload, and
the frontend collapses both into one scalar (`bumpRevision`,
`repositories.ts:747-749`). There are **25 `getRevision` subscribers** across the
frontend (grep, excluding tests). These four cannot possibly be affected by a
working-tree-only change, yet re-fetch on every one:

| Subscriber | Site | Re-runs |
|---|---|---|
| `LogTab` | `LogTab.tsx:207-224` | `git log` (+ commit-graph rebuild) |
| `BranchesTab` | `BranchesTab.tsx:230-244` | branches detail |
| `StashesTab` | `StashesTab.tsx:57-69` | `git stash list` |
| `HistoryTab` | `HistoryTab.tsx:88-113` | `git log -- <file>` |

`CodeEditorTab` adds two more of the same shape: the gutter diff
(`CodeEditorTab.tsx:426-451`, `get_gutter_changes` scope `head`) and inline blame
(`:463-475`) both key on the revision, and neither can change unless HEAD or the
index moved.

Mitigations already in place and working: `GitPanel` mounts exactly one tab at a
time (`Switch`/`Match`, `GitPanel.tsx:104-121`) and passes `null` when the panel
is hidden, so the fan-out is bounded by the visible tab — this is why the storm
in F40 is not user-visible today. The structural waste stands: a single `kind:
"git-state" | "working-tree"` field on the payload would let this half of the
subscribers ignore the working-tree stream entirely, while `FileBrowserPanel`,
`ChangesTab`, `StatusBar` and the editor disk-check keep it.

### F47 — `get_working_tree_status` is uncached, costs 3 git subprocesses, and two panels call it per bump (P2)

`get_working_tree_status` (`git.rs:2523-2545`) has no `cached_get` wrapper — it
is not backed by any `GitCacheState` field — and per call runs:

1. `git status --porcelain=v2 --branch --show-stash --untracked-files=all`,
2. `git diff --numstat --cached` (`enrich_with_numstat`, `git.rs:2504-2519`),
3. `git diff --numstat`.

Two independent subscribers invoke it for the *same* repo on the *same* revision
bump: `ChangesTab.tsx:196` and `StatusBar.tsx:196` (the latter only to compute
`staged + unstaged + untracked` — a count Rust already has). That is 6 git
subprocesses per bump for the active repo, and `--untracked-files=all` is the
expensive status mode.

Both call sites correctly short-circuit on non-git directories
(`repositoriesStore.isGitRepo(...)` guards at `ChangesTab.tsx:188` and
`StatusBar.tsx:188`), so the F40 repo does not pay this.

**Measured (weak attribution):** sampling `ps` every 40 ms for 75 s during an idle
window observed 84 distinct short-lived `git` processes machine-wide, of which 6
were parented directly to the TUIC process (pid 41298) — one of them
`git --no-optional-locks status --porcelain`, i.e. the `repo_git_fingerprint`
guard at `repo_watcher.rs:336-340`. The remaining 78 could not be attributed:
PTY-hosted agents run git too, and by sampling time most were zombies with an
unreadable command line. Quoted as an order of magnitude, not as TUIC's rate.

### F48 — `clear_repo_caches` is invoked from the frontend on an event Rust already invalidated for (P3)

Both watcher emit paths call `st.invalidate_repo_caches(&repo_path)` immediately
before sending the event (`repo_watcher.rs:773` and `:800`). The frontend handler
then calls `invoke("clear_repo_caches", { path })` on receipt
(`useAppInit.ts:376-379`), and `clear_repo_caches` (`lib.rs:284-286`) is literally
`state.invalidate_repo_caches(&path)` — the same call.

One IPC round trip + a `moka::invalidate` across 6 caches per event, ~760/h for
one repo at F40's rate. The only window it covers is a cache repopulated between
the Rust invalidate and the event landing in the WebView, which requires a git
read already in flight at that instant.

Note the asymmetry, which is why this cannot be deleted blindly: the
**`head-changed`** handler (`useAppInit.ts:345-347`) makes the same call, and the
HEAD emit path (`repo_watcher.rs:707-746`) does **not** invalidate. That one is
load-bearing.

Same handler, same event: `repoSettingsStore.loadLocalConfig(repo_path)`
(`useAppInit.ts:381`) re-reads `.tuic.json` over IPC on every emit. The store
write is a Solid shallow merge, so an unchanged config fires no downstream signal
— the waste is the IPC + file read, not the reactivity.

### F49 — two `GitCacheState` fields are dead, and `worktree_paths` is recomputed twice per refresh (P3)

`GitCacheState` (`state.rs:2782-2798`) declares seven caches. Counting uses
outside `state.rs`:

| Field | Read sites outside `state.rs` |
|---|---|
| `repo_info` | 1 |
| `merged_branches` | 4 |
| `branches_detail` | 1 |
| `git_panel_context` | 2 |
| `github_status` | (poller) |
| **`git_status`** | **0** |
| **`worktree_paths`** | **0** |

`git_status` and `worktree_paths` are constructed (`:2809-2810`), invalidated in
both `clear_all` (`:2826, 2828`) and `invalidate_repo` (`:2839, 2841`), and never
written or read. Each is a `moka::sync::Cache` with a 256-entry bound and an
eviction listener wired to the `ttl_fallbacks` counter — so they contribute
nothing but a slot in the watchdog metric they feed.

The `worktree_paths` one is not merely dead, it is a missed hit on the hot path:
a single `refreshAllBranchStats` run computes worktree paths **twice** through the
uncached port — `get_repo_structure_impl` (`git.rs:1594-1596`) and then
`get_repo_diff_stats_impl` (`git.rs:1635-1640`), both calling
`git_reads().worktree_paths(...)` directly. Phase 2 additionally fans out one
`spawn_blocking` per worktree for `diff_stats` plus one for
`get_last_commit_timestamps`, so a repo with N worktrees costs 2 worktree-listings
+ N diff-stats + 1 log per `repo-changed`-driven refresh.

(`GixGitReads.handles`, `git_reads.rs:106`, is properly bounded at 64 — not part
of this finding.)

---

## Not covered by chunk 5

- **`dir_watcher.rs` / `plugin_fs.rs` debounce loops** — marked clean in chunk 2;
  the `rt.spawn`-per-event debounce is already logged as a chunk-2 open question
  and I added nothing to it.
- **`github_poller.rs`** and the `githubStore.pollRepo` leg of the `head-changed`
  handler — chunk 2 marked the poller clean (change-detected); I did not re-read
  the polling cadence or the GitHub cache TTL.
- **`worktree.rs`** beyond its `AppEvent::RepoChanged` producer at `:706`. The
  worktree create/remove/archive flows call `invalidate_repo_caches` at 10 sites;
  I did not audit them.
- **Solid render cost downstream of the 25 `getRevision` subscribers.** F46 stops
  at "the effect re-runs and issues an invoke"; the re-render / DOM cost is
  chunk 4's area. `timeBatch("git.refreshBatch:…")` exists at
  `createRepositoryRefreshCoordinator.ts:323` but produced **no** `SLOW
  git.refreshBatch` lines in the fetched log window — nothing to report.
- **Browser/PWA parity path**: `sse_routes.rs:88, 124` re-serialises `repo-changed`
  once per connected SSE client, and `remoteEventBridge.ts:41` bumps the revision
  from it. Same shape as F9's SSE note; not separately quantified.
- **`BlameTab`, `BranchDiffScrollView`, `GithubOpsDashboard`, `MarkdownTab`,
  `MarkdownPanel`, `HtmlPreviewTab`, `DiffTab`** — confirmed as `getRevision`
  subscribers and counted in F46, but their individual fetch costs were not
  measured.
- **No profiling run.** Every number is either quoted from the live log store,
  from a filesystem/`ps` sample described inline, or explicitly labelled an
  estimate with its derivation.

---

## Open questions

- **Does `ignore::WalkBuilder`'s `git_ignore(true)` apply inside a *non-git*
  registered directory?** `require_git` semantics decide whether
  `ContentIndex::build` actually skips `piscina/.claude/hud-budget.json` in the
  F40 tree (the nested `.gitignore` lives in a nested repo, the walk root does
  not). F41's "the indexer excludes what the watcher admits" claim is
  unambiguous for a normal git repo (`tuicommander` itself); for the non-git
  registered-directory case it is unverified.
- **How much of F40's residual rate is F42 (nested `.git`) vs F41 (nested
  gitignore)?** The 2 s mtime poll cannot see create-then-delete lock files, and
  `.git` was excluded from the poll by construction. Separating them needs a
  temporary `tracing::debug!` of the classified path in the watcher callback —
  worth adding before implementing any fix, so the fix is aimed at the dominant
  source.
- **Is `AiTriagePanel`'s drop-on-inflight intentional?** `executeTriage`
  (`aiTriageStore.ts:192`) returns immediately when a run is in flight and does
  **not** queue a rerun, so a change arriving mid-run is lost until the next
  revision bump. `refreshRepo` in the refresh coordinator
  (`createRepositoryRefreshCoordinator.ts:433-457`) deliberately solved the same
  problem the other way (single-flight + one trailing rerun), with a comment
  explaining that pure cancellation was starvation-prone. Efficiency-motivated,
  possible correctness cost — flagged, not filed.
- **`CodeEditorTab`'s 5 s `setInterval` disk poll** (`CodeEditorTab.tsx:365-372`)
  runs alongside the revision-driven `checkDiskContent` at `:357-363`, i.e.
  polling where a watcher already exists (methodology C.12). It is guarded by
  `document.visibilityState` and `editorTabsStore.state.activeId === props.id`,
  so at most one timer does work at a time. Left as a question because F41/F42
  may be the actual reason the watcher path was not trusted enough to drop it.
- **Should the `head_emits_suppressed` counter be generalised?** It currently
  covers only the HEAD path, so neither the git-state fingerprint skips nor the
  (absent) working-tree skips are observable. Extending it — or adding a sibling
  counter per category — would have made F40 visible in the watchdog snapshot
  instead of requiring a log archaeology pass.
