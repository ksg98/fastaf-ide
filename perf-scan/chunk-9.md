# Chunk 9 — filesystem, content search, file browser

Reserved finding ids: **F120–F129**. Format mirrors `performance_scan.md`.

Read-only pass, 2026-08-16. No session was created or closed, no repo of Boss's
was mutated. Cardinality measurements were taken on this machine against the
real config dir and the real registered repo set; every command used is quoted
inline. No profiler was run — every cost is either **measured** (with the
command shown) or an **estimate** whose derivation is stated.

**Not re-derived here** (owned by other chunks): **F5** (`content-search-batch`
has no correlation id, three listeners), **F44** (full non-incremental BM25
re-index once a minute), **F45** (`content_indices` never reaped). Findings
below that touch the same code say explicitly what they add on top.

---

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src-tauri/src/fs.rs` (full, 1–1400 + walk/search paths) | 2026-08-16 | F121, F122, F124, F125, F126 |
| `src-tauri/src/fs.rs` (`list_directory_impl` 330–453) | 2026-08-16 | F121 |
| `src-tauri/src/fs.rs` (`search_files_impl` 835–922) | 2026-08-16 | F121 |
| `src-tauri/src/fs.rs` (`search_content_impl` 927–1106) | 2026-08-16 | F124, F125 |
| `src-tauri/src/fs.rs` (`search_via_index` 748–833, `search_content_all_impl` 552–610) | 2026-08-16 | F122, F126 |
| `src-tauri/src/fs.rs` (`emit_content_batches` 483–526) | 2026-08-16 | contributes to F127; F5 owns the correlation-id side |
| `src-tauri/src/fs.rs` (sync mutation commands 1136–1422) | 2026-08-16 | F120 |
| `src-tauri/src/fs.rs` (`ALWAYS_EXCLUDED_DIRS` 136–168) | 2026-08-16 | clean (chunk 5 already read it); contributes to F129 |
| `src-tauri/src/content_index.rs` (full, query side 246–275; `build` 139–236; `IndexerThrottle` 37–76) | 2026-08-16 | F122, F123, F125 |
| `src-tauri/src/lib.rs` (`read_editor_file` 662–700, size caps 592–625) | 2026-08-16 | F120 |
| `src-tauri/src/mcp_http/fs_routes.rs` (1–115) | 2026-08-16 | F121, F126 |
| `src-tauri/src/plugin_fs.rs` (`walk_artifacts` 1291–1319, `measure_sizes` 1214–1249, `ArtifactScanCache` 1024–1170, `scan_build_artifacts*` 1368–1422) | 2026-08-16 | F129 |
| `src-tauri/src/dir_watcher.rs` (payload shape 19–92) | 2026-08-16 | clean here; contributes to F128 |
| `src/hooks/useFileBrowser.ts` (full) | 2026-08-16 | clean (thin invoke wrapper) |
| `src/utils/contentSearch.ts` (full) | 2026-08-16 | clean (transport shim) |
| `src/components/FileBrowserPanel/FileBrowserPanel.tsx` (full) | 2026-08-16 | F127, F128; contributes to F121 |
| `src/components/FileBrowserPanel/TreeNode.tsx` (full) | 2026-08-16 | contributes to F128 |
| `src/stores/commandPalette.ts` (full) | 2026-08-16 | clean streaming path (prefix identities preserved); contributes to F121 |
| `src/components/CommandPalette/CommandPalette.tsx` (result rendering 260–420) | 2026-08-16 | clean (`For` over stable refs); contributes to F121 |
| `plugins/build-cleaner/main.js` (scan/poll lifecycle 460–700) | 2026-08-16 | F129 |
| `tauri-macros-2.6.3/src/command/wrapper.rs`, `tauri-2.11.5/src/ipc/mod.rs`, `wry-0.55.1/.../wry_web_view_delegate.rs` | 2026-08-16 | evidence for F120/F121 |
| `bm25-2.3.2/src/search.rs`, `src/embedder.rs` | 2026-08-16 | evidence for F122/F123 |

---

## Findings

### F120 — every filesystem *mutation* command, and the 250 MB editor read, run on the macOS main thread (P1)

A `#[tauri::command]` written as a plain `fn` (no `async`) gets
`ExecutionContext::Blocking` (`tauri-macros-2.6.3/src/command/wrapper.rs:157-159, 264-266`,
kind `"sync"`), which means its body runs inline inside `Webview::on_message`
(`tauri-2.11.5/src/webview/mod.rs:1742, 1909`) — no `async_runtime::spawn`, no
`spawn_blocking`. On macOS that call arrives on the `WKScriptMessageHandler`
delegate, which wry constructs with a `MainThreadMarker`
(`wry-0.55.1/src/wkwebview/class/wry_web_view_delegate.rs:14, 34, 81-83`), i.e.
`userContentController:didReceiveScriptMessage:` on the **main thread**. So the
whole command body blocks the UI thread and the webview.

Every fs mutation command is written this way and is registered in the invoke
handler (`lib.rs:1782-1797`):

| Command | Site | Worst-case body |
|---|---|---|
| `delete_path` | `fs.rs:1226` | `std::fs::remove_dir_all` — whole subtree |
| `fs_transfer_paths` | `fs.rs:1387` | `copy_dir_recursive` (`fs.rs:1359`) — whole dropped tree, byte-for-byte |
| `move_path_abs` | `fs.rs:1306` | `rename`, then on EXDEV `copy` + `remove_file` |
| `copy_path` / `copy_path_abs` | `fs.rs:1252, 1285` | `std::fs::copy` of one file |
| `write_file` | `fs.rs:1182` | `atomic_write` = write temp + `set_permissions` + `rename` |
| `create_directory` | `fs.rs:1195` | `create_dir_all` + an ancestor `canonicalize` loop |
| `fs_read_file` | `fs.rs:1137` | read up to `MAX_EDITOR_FILE_SIZE` = 10 MB (`lib.rs:592`) |
| `read_editor_file` / `read_editor_file_external` | `lib.rs:665, 697` | read up to `MAX_EDITOR_LARGE_FILE_SIZE` = **250 MB** (`lib.rs:603`) |

The two sharp ones are `fs_transfer_paths` and `read_editor_file`.

- **Drag a folder into the FileBrowser** → `copy_dir_recursive` copies the whole
  tree on the main thread. Freeze duration is proportional to the bytes copied;
  there is no cap, no progress, no yield point.
- **Open a large file in the code editor** → the 250 MB cap is enforced *before*
  reading (`lib.rs:609-620`), and the comment at `lib.rs:598-602` explains the
  cap as protecting the webview from "a huge payload … crossing IPC as one
  string". That reasoning covers the JS side only: the `std::fs::read_to_string`
  + UTF-8 validation of up to 250 MB happens on the main thread *before* the
  payload ever crosses. The measurement cited there ("sub-100 ms JS cost") is a
  JS-side number and does not bound this.

`delete_path`'s `remove_dir_all` is the same shape at smaller amplitude.

The fix is mechanical and already used elsewhere in the same file:
`#[tauri::command(async)]` on a sync fn yields kind `"sync_threadpool"`
(`wrapper.rs:264`), which is exactly what these need. Estimate flag: the freeze
*durations* are not measured — the thread binding is code-derived and the body
sizes are read from the code; what is proven is that the work is on the main
thread, not how long any specific tree takes.

### F121 — the same walk is `spawn_blocking`-ed over HTTP and run on the executor over IPC, and three "this is cheap" comments are wrong (P2)

Four sibling call sites, same underlying functions, three different threading
decisions:

| Entry point | Site | Offloads? |
|---|---|---|
| `search_files_http` | `mcp_http/fs_routes.rs:33-39` | **yes**, `spawn_blocking`, with the comment *"can block for hundreds of ms on large repos — move off the Tokio executor"* |
| `search_files` (IPC) | `fs.rs:460-468` | **no** — `pub async fn` calling `search_files_impl` inline |
| `list_directory` (IPC) | `fs.rs:326-328` | **no** |
| `list_directory_http` | `fs_routes.rs:14-22` | **no** |

An `async fn` command is `tokio::spawn`ed onto the multi-thread runtime
(`tauri-2.11.5/src/ipc/mod.rs:329, 375` → `async_runtime.rs:103-114`), so
blocking inside it occupies a runtime **worker** thread rather than the blocking
pool. The HTTP route states the reason not to do that; the IPC twin does it
anyway. This is an IPC/HTTP-parity inversion of the same kind as F30.

Three comments assert costs the code does not have:

1. `fs_routes.rs:9-13` — *"`fs::list_directory_impl` is a single `read_dir` +
   sort, which completes in microseconds … and does not walk recursively."*
   `list_directory_impl` also calls `parse_git_status` (`fs.rs:354`), which
   forks `git status --porcelain -z` (`fs.rs:183-189`) and blocks on it.
   **Measured** on this repo, warm cache, 3 runs of
   `/usr/bin/time -p git status --porcelain -z`: **0.06 s, 0.03 s, 0.03 s** —
   three orders of magnitude off "microseconds", and it is a subprocess
   fork/exec plus a git worktree scan, not a `read_dir`.
2. `fs_routes.rs:54-55` — *"Guard is held for the duration of the in-memory
   query (fast, stays on the executor)."* `search_via_index` is **not**
   in-memory: after the BM25 rank it opens and greps up to 50 files from disk
   (`fs.rs:781-822`, `searcher.search_path`).
3. `search_content_all_http` (`fs_routes.rs:99-100`) calls
   `search_content_all_impl` **directly on the axum executor** — that is the
   per-repo disk grep of (2), multiplied by the registered repo count (see
   F126), with no `spawn_blocking` anywhere.

Two smaller wastes on the same functions, folded in rather than given their own
ids:

- **`search_files_impl` computes fields the Command Palette never renders.**
  After the walk it runs a **full-repo** `parse_git_status(&repo_path, ".")`
  (`fs.rs:909-916`) and a `metadata()` stat per matched entry
  (`fs.rs:886-895`). The palette renders only `entry.name` and `entry.path`
  (`CommandPalette.tsx:282-293`) — `git_status`, `size`, `modified_at`,
  `is_ignored` are dropped. So every debounced palette keystroke
  (`commandPalette.ts:12` `SEARCH_DEBOUNCE_MS = 300`, `:105`) pays one extra
  30–60 ms `git status` subprocess for nothing. The FileBrowser's filename mode
  *does* use `git_status` and `size` (`FileBrowserPanel.tsx:1452-1457`), so the
  fields are not dead globally — the palette caller is the one paying.
- **Allocating sort keys.** `fs.rs:919` `results.sort_by_key(|a| a.path.to_lowercase())`
  allocates a `String` on *every key evaluation*, i.e. O(n log n) allocations,
  not O(n). `fs.rs:446-450` is worse: two `to_lowercase()` per *comparison*
  inside `sort_by`. For a 1000-entry directory that is ~20 000 transient
  `String`s per listing (estimate: `n log2 n × 2` at n = 1000). Also per call,
  `list_directory_impl` re-reads and re-compiles the repo's `.gitignore` into a
  fresh `GitignoreBuilder` (`fs.rs:357-364`).
- **Sequential subprocess chain on reveal.** `revealActiveFile`
  (`FileBrowserPanel.tsx:231-253`) awaits `fb.listDirectory` once per uncached
  ancestor, in a loop — each one a `list_directory` round trip carrying its own
  `git status`. The effect that drives it (`:255-261`) fires on **every** active
  editor/diff tab change. Revealing a file five levels deep costs five
  sequential 30–60 ms round trips before the tree scrolls (estimate = measured
  git-status cost × depth).

### F122 — the BM25 engine stores the full text of every indexed file, and clones ~1 MB of it per query, and nothing ever reads it (P2)

`bm25::SearchEngine` keeps `documents: HashMap<K, String>`
(`bm25-2.3.2/src/search.rs:58`) and `upsert` inserts the document's whole
contents into it (`search.rs:81-92`). `ContentIndex::build` feeds it
`format!("{}\n{}", rel_path, content)` for every text file
(`content_index.rs:220`), so the engine retains **a full second copy of the
repo's text**.

**Measured** for this repo, replicating `build`'s exact filter (walk =
`git ls-files --cached --others --exclude-standard`, minus `ALWAYS_EXCLUDED_DIRS`,
minus files > 1 MB, minus files with a NUL in the first 8 KB — the same rules as
`content_index.rs:158, 184, 206` and `fs.rs:136-156`):

```
walk-visible files:   1794
indexed text files:   1673
skipped >1 MB: 8   binary: 112
corpus bytes:  33 139 689  (33.1 MB)
```

That 33.1 MB is retained for the process lifetime per indexed repo — and, per
**F45**, `content_indices` is never reaped, so it is retained even for repos the
user has stopped using.

**Nothing reads it.** `ContentIndex::search` (`content_index.rs:246-263`) uses
only `r.document.id`, mapping it back to `entries[id].rel_path`, and
`search_via_index` (`fs.rs:781-822`) then re-opens the file from disk and greps
it. `r.document.contents` is dropped on the floor at every call site.

Worse, obtaining it costs a copy: `SearchEngine::search` calls `self.get(&id)`
per hit (`search.rs:128`), and `get` **clones the stored String**
(`search.rs:100-105`). `ContentIndex::search` is called with `limit = 50`
(`fs.rs:759`), so each query allocates and memcpys up to 50 whole documents and
frees them immediately. Estimate: 33 139 689 / 1673 = **19.8 KB average
document**, so ≈ **1 MB of allocate-copy-free per query** on this repo; on a
cross-repo search that is per repo (F126).

The id→path mapping the code actually needs is already in
`ContentIndex.entries` / `path_to_idx` (`content_index.rs:82-94`). Nothing in
TUIC's use of bm25 needs the crate's document store.

### F123 — every index build tokenizes the whole corpus twice, single-threaded (P2)

`SearchEngineBuilder::with_corpus(...).build()` (`content_index.rs:225`) walks
the corpus twice:

1. `with_tokenizer_and_corpus` → `with_tokenizer_and_documents` →
   `EmbedderBuilder::with_tokenizer_and_fit_to_corpus`
   (`bm25-2.3.2/src/search.rs:199-208, 176-193`), which tokenizes **every
   document only to sum token counts for `avgdl`** and then throws the tokens
   away (`embedder.rs:217-228`);
2. `build()` → `upsert` → `embedder.embed(contents)` (`search.rs:83`), which
   tokenizes every document again, for real.

The tokenizer is not cheap: `default_tokenizer` pulls `deunicode`,
`unicode-segmentation`, `stop-words` and `rust-stemmers` (Porter)
(`bm25-2.3.2/Cargo.toml:48-55`). The crate has a `parallelism` feature that
rayon-parallelises exactly the fitting pass (`Cargo.toml:60`,
`embedder.rs:220-223`) — TUIC declares `bm25 = "2.3"` with default features
(`src-tauri/Cargo.toml:214`) and `Cargo.lock:754-765` confirms **no rayon**, so
both passes are single-threaded.

Net for this repo: **66 MB of stemming/segmentation per rebuild**, of which half
produces nothing but one `f32`. Per **F44** that rebuild currently runs up to 60
times an hour for a repo whose only writes are git-invisible. Enabling
`parallelism`, or computing avgdl from the embedding pass, removes half the work
outright.

Estimate flag: the 66 MB figure is the measured corpus size × 2 passes read from
the crate source. No timing was taken.

### F124 — a cancelled search still runs to completion; the cancel token is only consulted after the work is done (P2)

`ContentSearchCancel` (`fs.rs:76`) is set at the top of `search_content`
(`fs.rs:667-674`) and `search_content_all` (`fs.rs:626-633`): the new search
flips the previous token to `true`. But neither `search_content_impl`
(`fs.rs:927-1106`) nor `search_via_index` (`fs.rs:748-833`) nor
`search_content_all_impl` (`fs.rs:552-610`) **takes the token as a parameter at
all**. The only checks are `fs.rs:701` (after the search returned) and
`fs.rs:493` (between emit batches).

So cancellation suppresses *delivery*, never *work*. Concrete scenario, with the
FileBrowser's own numbers: content mode debounces 500 ms
(`FileBrowserPanel.tsx:511`) and requires ≥ 3 chars (`:449`). A user typing
`handleOsc133` pauses past 500 ms three or four times mid-word; each pause fires
a `search_content`, each of those `spawn_blocking`s a **full 1794-file walk +
grep** (index-not-ready path, see F125), and all of them run to the end on
separate blocking-pool threads while only the last one's results are shown.

`grep_searcher` gives a free cancellation point — the `UTF8` sink closure
already returns `Ok(false)` to stop a file (`fs.rs:1029-1033`) — and the walker
loop has an obvious one at `'walk:`. The token is already an
`Arc<AtomicBool>`; it just is not threaded through.

### F125 — the fallback grep starves the index build whose absence is the only reason the fallback exists (P2)

`IndexerThrottle::checkpoint` (`content_index.rs:70-75`) is called every 50 files
during a build and spins `while search_active > 0 { sleep(100 ms) }`. A
`SearchGuard` is taken for the **entire** duration of a search, including the
non-indexed fallback: `search_content` acquires it at `fs.rs:686` and moves it
into the `spawn_blocking` closure (`fs.rs:690`) precisely so it outlives the
async prelude.

The ordering in `search_content` closes the loop:

1. `fs.rs:681` `ensure_index(&app_state, &repo_path)` — spawns the build for a
   repo with no index yet;
2. `fs.rs:686` `begin_search()` — `search_active` goes to 1;
3. `fs.rs:691-699` `search_content_indexed` sees `!index.is_ready()`
   (`fs.rs:731`) and falls through to `search_content_impl` — a full repo walk;
4. the build reaches its first `checkpoint()` after 50 files and blocks until
   the walk finishes.

With the FileBrowser's 500 ms debounce, a user typing a query holds
`search_active > 0` for most of the wall clock, so the build advances 50 files
per gap. The index that would make step 3 unnecessary cannot finish *because*
step 3 keeps running. Nothing here deadlocks — the guard always drops — but the
steady state while typing is "always fall back, never index".

Second cost carried by that same fallback path: `search_content_impl` re-ranks
its hits with a second BM25 pass over `line_text` (`fs.rs:1075-1097`), building
a `Vec<&str>` of every match, calling `text_rank::rank_lines`, then **cloning
every `ContentMatch` into a new `reordered` Vec** (`:1086, 1091`). At the
default limit of 1000 that is 1000 struct clones (two heap `String`s each) plus
a full BM25 over 1000 lines, per search — on the path that is already the slow
one.

### F126 — a cross-repo search fans `ensure_index` over all 38 registered repos and holds each index's read lock across its disk grep (P3)

`search_content_all_impl` (`fs.rs:552-610`) iterates `registered_repo_paths()`
∪ the already-indexed set and calls `ensure_index` for **every** entry
(`fs.rs:579`), which inserts a placeholder and spawns a build for each repo that
has none (`content_index.rs:331-374`).

**Measured** on this machine, `repositories.json` on 2026-08-16: **38 registered
repos**. `content_index.rs:23-24` gives a 60 s rebuild cooldown but no admission
control on first build, and `state.index_build_sem` has 1 permit
(`content_index.rs:303-305`), so one "Search all repos" tick in the palette
(`CommandPalette.tsx:300-307` → `commandPalette.ts:322-336`) can enqueue up to
38 full BM25 builds, run strictly one at a time, each throttled 10 ms per 50
files (`content_index.rs:27-33`) and each paying F122's retained text and F123's
double tokenization. For this repo alone that is 1673 files → ≥ 33 checkpoint
sleeps ≈ 0.33 s of pure throttle before any I/O; the total across 38 repos was
not measured.

On the lock side, `fs.rs:580` takes `index_arc.read()` (a
`parking_lot::RwLock`) and holds it across `search_via_index`, which opens and
greps up to 50 files from disk (`fs.rs:787-822`). `parking_lot` parks new
readers behind a waiting writer, so a rebuild's `*index.write() = built`
(`content_index.rs:422`) blocks for the duration of another repo's disk grep,
and vice versa. `search_content_http` has the same shape at
`fs_routes.rs:60-68`.

Also on this path: `registered_repo_paths()` (`fs.rs:532-538`) calls
`crate::config::load_repositories()` — a full JSON file read + parse — once per
cross-repo search, and `fs.rs:562-566` does a linear `iter().any()` per index
entry against the repo list, O(repos × indices).

P3 rather than P2 because it is user-initiated and opt-in (the "Search all
repos" checkbox is off by default, `commandPalette.ts:63`), not something that
happens on its own.

### F127 — the FileBrowser rebuilds its entire content-search result list on every streamed batch (P2)

`contentMatchGroups` (`FileBrowserPanel.tsx:522-537`) is a `createMemo` that
regroups **all matches accumulated so far** into freshly-allocated
`{ path, matches }` objects, and `<For each={contentMatchGroups()}>`
(`:1305`) renders from it. `setContentMatches((prev) => [...prev, ...batch.matches])`
(`:478`) fires the memo once per batch.

Because every group object is a new identity on every run, `For`'s
reference-keyed reconciliation disposes and recreates **every** group row and
every nested `<For each={group.matches}>` row (`:1321-1341`), including the
three `String.slice` allocations per match line (`:1333-1337`). This is the
F33 pattern, on a list that grows while the user watches it.

Amplitude, derived from the constants: `emit_content_batches` chunks at 50
(`fs.rs:488`) and the FileBrowser passes no `limit` (`useFileBrowser.ts:68`), so
Rust's default of 1000 applies (`fs.rs:757, 947`) → **20 batches**. Cumulative
work is the triangular sum 50 + 100 + … + 1000 = **10 500 group-map insertions
and ~10 500 row create/dispose cycles to end up with 1000 rows** — about 10× the
necessary DOM work, all on the main thread, spread across the seconds the search
is streaming.

The Command Palette's equivalent path is **clean** and shows the fix:
`commandPalette.ts:143-147` does `[...prev, ...batch.matches].slice(0, MAX)`,
which preserves the prefix element identities, and
`<For each={commandPaletteStore.state.contentResults}>`
(`CommandPalette.tsx:346`) therefore only appends. Grouping is what breaks it,
not streaming.

Folded in: `emit_content_batches` (`fs.rs:492-508`) does `chunk.to_vec()` per
batch, cloning 50 `ContentMatch` (two heap `String`s each) purely to build the
payload — 1000 extra String-pair clones per full search — and repeats the four
counter fields in all 20 payloads.

### F128 — the FileBrowser tree cache is invalidated with a key it never contains, and is never cleared on repo switch (P2)

`treeCache` is a `Map<string, DirEntry[]>` keyed by **repo-relative** paths:
writes come from `onChildrenLoaded(props.entry.path, …)` (`TreeNode.tsx:45`,
`DirEntry.path` is documented "relative to repo root", `fs.rs:12-13`) and from
`revealActiveFile`'s accumulator `acc` (`FileBrowserPanel.tsx:240`).

The only eviction is `next.delete(event.payload.dir_path)`
(`FileBrowserPanel.tsx:396`). `dir_path` is the **absolute** path the panel
passed to `start_dir_watcher` — `absPath = fsRoot + "/" + subdir` (`:383`),
echoed verbatim by the watcher (`dir_watcher.rs:19, 60-77`), and the handler
even guards on `event.payload.dir_path === absPath` (`:391`) to prove it.
An absolute key is never present in a relative-keyed map, so **the delete is a
no-op** and the surrounding `new Map(prev)` copy is pure allocation. (In tree
view the mismatch is doubled: the tree button forces `setCurrentSubdir(".")`
(`:1231`), so the only watched path is the repo root, whose cache key would be
`"."`.)

Two consequences, both from the same key:

- **Stale forever.** Once a directory's children are cached, no filesystem event
  can refresh them. The subtree keeps showing deleted files and misses new ones
  until the user collapses and re-expands.
- **Never cleared on repo switch, so it is wrong as well as unbounded.** The
  root-change branch (`:282-299`) clears `scrollCache` and resets the subdir,
  but touches neither `treeCache` nor `expandedDirs`. Both are component-scoped
  and the panel instance survives repo switches by design (`:158-166`). A
  relative key like `src` exists in most repos, so after switching from repo A
  to repo B the tree renders **repo A's children under repo B's `src` node**,
  and the map accumulates the union of every repo ever browsed.

Folded in — the per-mutation copies, cheap individually but on every expand:
`setTreeCache` copies the whole Map (`:217-221, 394-398`) and `setExpandedDirs`
copies the whole Set (`:205-213, :246`). Both are passed by value to every
mounted `TreeNode` (`:1367, 1372`), so each mutation re-evaluates `isExpanded()`
and `children()` (`TreeNode.tsx:33-34`) in every node in the tree. For a tree
with N mounted rows and D cached dirs that is O(D) entry copies + O(N) map/set
lookups + O(N) `For` diffs per expand. The `?? []` in `children()` also returns
a fresh empty array per call for uncached dirs. Estimate, from the code — no row
count was measured.

### F129 — the build-artifact scan stats 164 512 files across the registered repos, hourly, with no ignore filtering (P2)

`walk_artifacts` (`plugin_fs.rs:1291-1319`) recurses every directory under every
scan root to `MAX_SCAN_DEPTH = 8`, skipping only `.git` and symlinks — it does
**not** use `ignore::WalkBuilder`, does not read `.gitignore`, and does not use
`ALWAYS_EXCLUDED_DIRS` (`fs.rs:136-156`), unlike every other walk in the
codebase. On a name match it calls `measure` → `measure_sizes`
(`plugin_fs.rs:1214-1249`), which recurses to `MAX_SIZE_DEPTH = 64` and calls
`e.metadata()` — one `stat` — on **every regular file**.

**Measured** on this machine, 2026-08-16, over the 38 repos in
`repositories.json`, replicating the walk's own rules (depth ≤ 8, `.git`
skipped, stop-at-match so nested artifact dirs are counted once):

```
TOTAL files under rule-named artifact dirs across 38 repos: 164 512   (5.5 s, warm cache)
  61 764  …/personal/tuicommander
  41 998  …/personal/SpeechMaster
  21 153  …/personal/mdkb
  17 397  …/personal/etoro-porfolios-watcher-go
   9 816  …/personal/automa
```

Caveat on that number, stated rather than hidden: the probe matched on directory
name only, while `matching_rule` (`plugin_fs.rs:1312`) additionally requires a
marker file beside ambiguous names (`target`, `bin`, `build`, `out`, `obj`), so
the set that reaches `measure_sizes` is a **subset** of 164 512. But an
unmatched dir is not skipped — `walk_artifacts` descends into it
(`:1317`) — so the traversal cost does not disappear, it moves from
`measure_sizes` (`read_dir` + per-file `stat`) to `walk_artifacts` (`read_dir` +
`file_type()`). 164 512 is therefore an upper bound on the per-file `stat`s and
a reasonable lower bound on total directory-entry traversal.

Cadence: `plugins/build-cleaner/main.js:63` sets `pollIntervalMs = 60 × 60 × 1000`
and `onload` calls `poll()` immediately then `startPollTimer()` (`:694-696,
622-630`), so this runs **at launch and every hour thereafter**, unconditionally,
whether or not the dashboard was ever opened. Opening the dashboard adds one
more (`:522`); the "refresh" button forces one past the cache (`:536`).
`BUILD_ARTIFACT_SCAN_TTL` is 30 s (`plugin_fs.rs:1021`), far below the interval,
so the hourly poll always misses the cache.

Also on the scan path: `measure` calls `max_child_mtime_secs(dir)`
(`plugin_fs.rs:1280, 1254-1268`) immediately after `measure_sizes` has already
walked that same directory — a second `read_dir` plus a second `stat` of every
direct child, for a value the first walk had in hand.

The cache itself is well built (scan runs outside the mutex, `Running` state
coalesces concurrent callers, `Ready` bounded to 8, panic-safe) — the cost is the
walk, not the caching around it.

---

## Not covered by chunk 9

Declared so the next chunk does not re-derive the boundary:

- **`fs.rs:1400-3190`** — the `fs_transfer_paths` body past line 1400, the TCC
  guard, `resolve_terminal_path`, `add_to_gitignore`, `validate_external_write_path`
  and the whole test module were read only far enough to classify the commands
  for F120. No efficiency pass on their bodies.
- **`plugin_fs.rs` outside the scan** — `plugin_list_directory_impl`, the
  plugin-data read/write paths, the debounce loop (chunk 2 marked it clean), and
  the delete/trim paths (`:1425-1700+`) were not analysed. Only the scan cost
  was in scope.
- **`content_index.rs` build side** — owned by F44. This chunk read `build` only
  to establish what the *query* path retains (F122) and what a rebuild costs in
  tokenization (F123); the rebuild trigger, cooldown and incrementality are F44's.
- **`MarkdownPanel.tsx`'s `content-search-batch` consumer** — F5 owns it; its
  own list-growth behaviour was not opened.
- **`ai_agent/tools.rs:4548, 4580`** (agent-side content-index consumers) and
  `ai_terminal.rs`'s `ai_terminal_search_files` — inventoried from grep, not read.
- **`fs_routes.rs:105-300+`** — the read/write/editor HTTP routes past
  `search_content_all_http` were not analysed beyond confirming
  `fs_read_file_http` reuses the same impl.
- **The editor's disk-change poll** (`CodeEditorTab.tsx`, 5 s) — chunk 5 left it
  as an open question and it consumes `stat_path`; not re-opened here.
- **No profiling was run.** The measured quantities in this chunk are: the git
  status timing (F121), the corpus file count and byte total (F122/F123), the
  registered repo count (F126), and the artifact file count (F129). Everything
  else is an estimate whose derivation is stated inline.

---

## Open questions

- **F120's blast radius depends on how often a big tree is dropped or a big file
  opened.** The thread binding is proven; the freeze duration is not. Before
  fixing, it would be worth confirming with a real drop of a large folder that
  the UI is unresponsive for the whole copy — that also tells you whether
  `fs_transfer_paths` needs progress reporting or just
  `#[tauri::command(async)]`.
- **Does anything else depend on `bm25`'s document store?** F122 asserts nothing
  reads `SearchResult::document.contents` in TUIC. That is grep-verified across
  `src-tauri/src` for the two call sites (`content_index.rs:254-261`,
  `fs.rs:787`), but if a future ranking feature wants a snippet without a disk
  re-read, the retained text becomes useful rather than dead. Worth deciding
  which way that goes before removing it, since removal is a crate-usage change
  (`with_corpus` → building the scorer directly), not a one-liner.
- **How much of F129's 164 512 actually reaches `measure_sizes`?** The
  name-only probe cannot tell matched from descended-into. Instrumenting
  `walk_artifacts`/`measure` with a counter behind the existing diagnostics flag
  would split it exactly, and would also say whether a `.gitignore`-aware walker
  (which every other walk in the codebase already uses) would cut it materially
  or barely at all — `target/` and `node_modules/` are gitignored, but they are
  also exactly what the plugin is looking for, so the ignore rules cannot simply
  be turned on here.
- **F125's steady state was reasoned, not observed.** Reproducing it needs a
  repo with no index, content-search mode, and a slow-typed query, while
  watching for `content index built` (`content_index.rs:370`, `info` level) to
  see how long it takes to appear. That trace is at `info` so
  `GET :9876/logs` should show it — it was not fetched during this pass.
- **`ContentSearchCancel` is one global slot** shared by `search_content` and
  `search_content_all` (`fs.rs:628, 669`), which means the backend structurally
  supports exactly one search in flight — yet F124 shows cancelled searches keep
  running, so in practice several *are* in flight on the blocking pool. Whether
  the intended design is "one at a time, enforced" or "many, correlated" is a
  design decision that F5's `search_id` proposal also depends on. The two should
  be decided together.
