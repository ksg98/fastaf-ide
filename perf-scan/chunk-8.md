# Chunk 8 — cold-start cost (process launch → first useful interaction)

Scope: everything between `main()` and the moment Boss can type into a terminal.
Rust side: the `setup` closure in `src-tauri/src/lib.rs`, initialisation order,
blocking vs async threads, eager vs lazy work. Frontend side:
`src/hooks/useAppInit.ts`, `src/hooks/useAppBootstrap.ts`, `src/index.tsx`,
session/tab restore, plugin loading, and the persistence layer's startup reads
and writes. Same methodology, severity scale and verification ladder as
`performance_scan.md`. Finding ids F80-F89.

Read-only pass. **The app was not launched and Boss's instance was not
restarted.** Timings labelled *measured* come from three sources, each named at
the point of use: (a) persisted rotated log files in the config dir, which
contain real cold boots with `ThreadId` and millisecond timestamps; (b) static
inventory of `~/Library/Application Support/com.tuic.commander/` (file counts,
sizes, JSON contents); (c) subprocesses re-run standalone in this shell
(`/usr/bin/which`, `tuic --version`, `git worktree list`) to price a fork that
the boot path performs. Everything else is code inspection, and every estimate
says so and shows its derivation.

Two existing findings are **used, not re-derived**: **F6** (`knowledge::load_all`
deserialises the whole ai-sessions store at every launch — 1918 entries on this
machine, confirmed by `ls | wc -l`) and **F45** (`content_indices` never freed).
Per-session PTY startup work is **F28**'s and is not repeated here; this chunk
stops at the boundary and says where.

---

## Files evaluated

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src-tauri/src/lib.rs:1050-1200` (pre-builder boot: `raise_fd_limit`, config load, HTTP server thread, `ensure_mcp_configs`, relay gate) | 8 | 2026-08-16 | F83 |
| `src-tauri/src/lib.rs:1299-1462` (`setup` closure) | 8 | 2026-08-16 | F82, F84 |
| `src-tauri/src/lib.rs:1389-1403` (repo watcher loop) | 8 | 2026-08-16 | F84 (measured: 38 watchers, 9 of them parked) |
| `src-tauri/src/lib.rs:1414-1462` (content-index pre-warm) | 8 | 2026-08-16 | second full `load_app_config()` at :1420 — contributes to F87; warm itself is deferred 2 s and semaphore-capped (clean) |
| `src-tauri/src/lib.rs:1931-1958` (`spawn_background_tasks`) | 8 | 2026-08-16 | clean at boot (all tokio tasks, off the UI path); F6 lives inside `knowledge::spawn_persist_task` |
| `src-tauri/src/tailscale.rs:77-99` (`detect`) | 8 | 2026-08-16 | F83 (no timeout on `tailscale status --json`) |
| `src-tauri/src/tuic_cli.rs:119-147, 221-245` (`auto_update_cli`, `check_version_match`, `cli_version`) | 8 | 2026-08-16 | F82 |
| `src-tauri/src/agent.rs:696-716` (`detect_all_agent_binaries`), `:719-796` (`detect_binary_path_only`) | 8 | 2026-08-16 | F81 |
| `src-tauri/src/agent_mcp.rs:336-358, 448-492, 875-892` (`ensure_mcp_configs`) | 8 | 2026-08-16 | **clean** — idempotent, `json_entry_is_current` returns early with no write (ruled out) |
| `src-tauri/src/config.rs:2070-2117` (`load_app_config`), `:146-169` (`load_json_config`), `:2411` (`load_repositories`), `:2246` (`load_repo_local_config`) | 8 | 2026-08-16 | F87 (uncached, cross-process-locked, read repeatedly) |
| `src-tauri/src/app_logger.rs:338, 351-410` (`cleanup_old_logs`) | 8 | 2026-08-16 | F89 (measured: retention never fires) |
| `src-tauri/src/repo_watcher.rs:252-261, 497-530, 577-882, 889` | 8 | 2026-08-16 | F84 |
| `src-tauri/src/worktree.rs:1245-1254` (`detect_orphan_worktrees`) | 8 | 2026-08-16 | F85 (sync command, forks git) |
| `src-tauri/src/credentials.rs:173-233, 242-266` | 8 | 2026-08-16 | keychain hit is lazy on first `get`, not at boot (ruled out for cold start) |
| `src-tauri/src/themes.rs` (`seed_builtin_themes`, `start_theme_watcher`) | 8 | 2026-08-16 | **clean** — seeding no-ops when files exist (ruled out) |
| `src/index.tsx`, `src/hooks/useAppInit.ts:260-800` | 8 | 2026-08-16 | F86, F87 |
| `src/hooks/useAppBootstrap.ts:48-69` (`stores.hydrate`) | 8 | 2026-08-16 | F80 |
| `src/hooks/useAgentDetection.ts:22-53` | 8 | 2026-08-16 | F81 |
| `src/hooks/git/createRepositoryRefreshCoordinator.ts:380-470` | 8 | 2026-08-16 | F85, F86 |
| `src/plugins/index.ts:21-40`, `src/plugins/pluginLoader.ts:209-266, 356-402`, `src/plugins/pluginRegistry.ts:733` | 8 | 2026-08-16 | F88 |
| `tauri-macros-2.6.3/src/command/wrapper.rs:50, 264-266` (vendored), `tauri-2.11.5/src/ipc/protocol.rs:75, 314` | 8 | 2026-08-16 | F80 (execution-model evidence) |

---

## Findings

### F80 — `Promise.allSettled` over 13 store hydrations is not parallel: sync Tauri commands run inline on the IPC handler (P2)

`src/hooks/useAppBootstrap.ts:48-69` fans out thirteen hydrations at once and
`useAppInit.ts:275` awaits the whole batch **before the splash is removed**
(`useAppInit.ts:300`):

```ts
const results = await Promise.allSettled([
    repositoriesStore.hydrate(), uiStore.hydrate(), settingsStore.hydrate(),
    notificationsStore.hydrate(), repoSettingsStore.hydrate(), repoDefaultsStore.hydrate(),
    promptLibraryStore.hydrate(), notesStore.hydrate(), activityStore.hydrate(),
    keybindingsStore.hydrate(), agentConfigsStore.hydrate(), providerRegistryStore.hydrate(),
    detectAgents(),
]);
```

The shape says "13 in parallel". The execution model says otherwise.
`tauri-macros-2.6.3/src/command/wrapper.rs:50` sets the default:

```rust
let mut execution_context = ExecutionContext::Blocking;
```

so a `#[tauri::command]` whose body is **not** `async fn` and which does not
carry `(async)` is emitted with kind `"sync"` (`wrapper.rs:264-266`) and its
body is invoked directly by the IPC handler
(`tauri-2.11.5/src/ipc/protocol.rs:75, 314`) rather than being handed to the
tokio runtime. Consequence: the thirteen invokes queue behind one another. The
gain over a plain `for` loop is one IPC round trip's worth of overhead, not
concurrency.

That matters because the batch gates the splash removal, and because at least
one member of it is genuinely expensive (`detectAgents` → F81, 13 subprocesses).

**Label — the "runs on the macOS UI thread" part is an inference**, from the
macro default plus Tauri's documented model, not from a measurement on this
machine. What *is* certain from source is that sync commands do not reach the
async runtime, so the batch is serialised. Whether the serialisation also blocks
the platform UI thread (as opposed to a webview IPC thread) is the open question
at the bottom of this file, and the fix is the same either way.

**Fix.** Mark the hydration commands `#[tauri::command(async)]` (or make them
`async fn`), which is a one-token change per command and makes the
`allSettled` genuinely concurrent; or, better for cold start, collapse the
thirteen into one aggregate `hydrate_all` command that reads every config file
under a single lock acquisition and returns one payload — this also fixes half
of F87.

---

### F81 — agent detection spawns 13 threads and 13 `which` subprocesses inside the splash-gating batch, one of them for the empty string (P3)

`useAgentDetection.ts:22-53` sends all `AGENT_BINARIES` in one batched invoke —
good — but the Rust side (`src-tauri/src/agent.rs:696-716`) does:

```rust
let handles: Vec<_> = binaries.into_iter().map(|binary| {
        std::thread::spawn(move || { let detection = detect_binary_path_only(&binary); (binary, detection) })
    }).collect();
for handle in handles { if let Ok((binary, detection)) = handle.join() { ... } }
```

13 OS threads created and joined **inside the command body**, and by F80 that
body runs inline in the IPC handler, so the caller is blocked for the duration
of the slowest probe. Each thread (`agent.rs:719-796`) runs a `which <binary>`
subprocess and then up to 7 candidate-path `exists()` stats.

**Measured** on this machine, 2026-08-16: `/usr/bin/which claude` costs **4 ms**
warm; 13 sequential invocations cost **38 ms**. The threads run concurrently so
the wall cost is nearer one probe than thirteen — but thread creation, join, and
13 concurrent `fork`/`exec` pairs are not free on a cold page cache, and this
sits on the critical path to the splash.

One entry deserves its own line: `AGENT_BINARIES` contains `api: ""`
(`useAgentDetection.ts:22-53`), so the backend spawns a thread that runs
`which ""` and then stats candidate paths that reduce to `~/.local/bin/` — an
**existing directory**, which the `exists()` check accepts. That probe is pure
waste and its result is meaningless.

**Fix.** Make the command `async` and use `tokio::process` or `spawn_blocking`
with a join set instead of raw threads; skip empty binary names; and move the
whole detection off the splash path — nothing on the first screen needs it.

---

### F82 — the CLI auto-updater forks two `--version` subprocesses inside `setup()` on every launch, before the window renders (P3)

`lib.rs:1406-1407`:

```rust
#[cfg(feature = "desktop")]
tuic_cli::auto_update_cli();
```

is a plain synchronous call in the `setup` closure. It resolves the install
path, and if the CLI exists calls `check_version_match`
(`tuic_cli.rs:119-127`), which invokes `cli_version()`
(`tuic_cli.rs:221-245`) — a `std::process::Command::new(path).arg("--version").output()` —
**twice**, once per compared side. On a version mismatch it then performs a
synchronous `std::fs::copy` of the whole binary (`tuic_cli.rs:133`),
also inline in `setup`.

**Measured** on this machine, 2026-08-16, running the same command standalone:
`/usr/local/bin/tuic --version` costs **18 ms cold** (first run after boot,
binary not in page cache) and **3 ms warm**. Two invocations ⇒ ~36 ms cold /
~6 ms warm added to `setup` before the window is shown, every launch, to
discover "nothing to do" in the overwhelming majority of launches.

Severity is P3 for the version check and would be **P2 for the copy path**: a
release-sized binary copy inside `setup` is tens to hundreds of ms of blocking
I/O, and it happens exactly on the launch after an app update — the launch the
user is already watching most closely.

**Fix.** `std::thread::spawn` the whole `auto_update_cli()` call. Nothing in
`setup` depends on its result, and the CLI is not needed until the user opens a
terminal. Cheaper still: compare mtime/size before forking `--version` at all.

---

### F83 — the Unix socket and HTTP server bind only *after* Tailscale detection, which has no timeout (P2)

`lib.rs:1116-1182` moves the whole server bring-up onto its own thread with its
own tokio runtime — correct — but the order inside that runtime is:

```rust
spawn_background_tasks(&server_state);
let tls_config = if remote_enabled {
    let ts_state = tokio::task::spawn_blocking(tailscale::detect).await
        .unwrap_or(tailscale::TailscaleState::NotInstalled);
    ...provision_tls_config...
```

and `keep_server_owner_runtime_alive(mcp_http::start_server(...))` is reached
only at `:1173-1178`. So **`tailscale::detect` gates the listener**, including
the Unix socket that every `tuic-bridge` process and the MCP surface depend on.
`tailscale.rs:77-99` runs `tailscale status --json` through
`std::process::Command` with **no timeout**: if the daemon is slow, wedged, or
waiting on a network round trip, the socket is simply not there yet, and each
failure path only returns `NotRunning` *after* the process returns.

**Measured** from the persisted log file
`~/Library/Application Support/com.tuic.commander/logs/tuic.log.2026-08-13`
(read-only; no app was launched), taking the delta between the last pre-detect
line and the `Tailscale detection result` line — a **lower bound** on the
detect call, since it also contains the runtime creation:

| Boot | Start | Detect logged | Δ (lower bound) |
|---|---|---|---|
| cold | 07:47:05.810 | 07:47:07.935 | **≥ 2.12 s** |
| cold | 08:30:10.238 | 08:30:12.463 | **≥ 2.22 s** |
| warm | — | — | ~0.15–0.30 s |

Two seconds of no MCP socket on a cold boot is not hypothetical: it is what the
logs recorded, twice, on the same day.

**Fix.** Bind the Unix socket (and plain HTTP) first, then detect Tailscale and
hot-swap in the TLS listener when the answer arrives. If the ordering must stay,
put a `Duration::from_secs(2)` timeout around `detect` — the fallback value
`NotInstalled` already exists and is the right answer when the probe is slow.

---

### F84 — every persisted repo gets an FS watcher at boot, parked ones included; parking survives only until the next restart (P2)

`lib.rs:1389-1403` iterates `repositories.json` and calls
`repo_watcher::start_watching` for **every key** in `repos`:

```rust
let repos_json = config::load_repositories();
for repo_path in repos.keys() {
    known_repo_paths.push(repo_path.clone());
    if let Err(e) = repo_watcher::start_watching(repo_path, app_state) { ... }
```

There is **no parked filter**. At runtime the frontend does the opposite:
`src/stores/repositories.ts:633-643` (`setPark`) explicitly calls
`stop_watching` when the user parks a repo (`repo_watcher.rs:889`). So parking
is honoured for exactly one session and silently undone by the next launch.

Per watcher the cost is `build_gitignore` (`repo_watcher.rs:252-261`, reads and
compiles the repo's ignore files), a `notify::recommended_watcher`
(`:497-530`), `watch_working_tree_root` and `sync_worktree_watches`
(`:577-882`) — plus, for the whole app lifetime, an FSEvents subscription that
keeps waking the process for a repo the user declared uninteresting.

**Measured** from `tuic.log.2026-08-13`: **38** `Starting watcher` lines, all on
`ThreadId(01)`, spanning `06.324 → 06.374` ≈ **50 ms** inside `setup`.
**Measured** from `repositories.json` (static read): **38 repos, 9 parked, 29
active**. So 9 of the 38 watchers — 24% — are for repos the user parked.

The 50 ms is the cheap half. The expensive half is invisible here: 9 permanent
FSEvents subscriptions feeding `repo-changed` events for the rest of the
session. On Linux the boot cost is also much worse — the comment at
`lib.rs:1385-1388` notes inotify emulates recursion with a per-directory walk
(issue #82).

**Fix.** Read the parked flag in the same loop and skip `start_watching` for
parked repos. One condition; the frontend already proves parked repos need no
watcher.

---

### F85 — `detect_orphan_worktrees` is a sync command that forks `git worktree list` once per repo, and boot runs it for all 29 active repos (P2)

`src-tauri/src/worktree.rs:1245-1254` is a **non-async** `#[tauri::command]`
that shells out to `git worktree list --porcelain`. By F80 the body runs inline
in the IPC handler, so each call blocks the IPC path for a full `fork`/`exec` of
git plus its repo-dir walk.

The boot path calls it once per repo: `refreshRepoOnce`
(`createRepositoryRefreshCoordinator.ts:~400-460`) runs
`handleOrphanCleanup` between its two git phases, and orphan cleanup is enabled
by default — **measured** from `repo-defaults.json` (static read):
`"orphan_cleanup": "ask"`, with no per-repo override in `repo-settings.json`
(15 repos listed, none setting it). So all 29 active repos take this path.

**Measured** on this machine, 2026-08-16, by timing `git worktree list
--porcelain` standalone across the 29 active repo paths (28 ran, 1 directory
missing): **208 ms total, mean 7.4 ms**, warm page cache. That is 208 ms of
serialised subprocess work on the IPC path during the first seconds after the
splash disappears — while the user is trying to click something.

**Fix.** Make the command `async` (one token) so it leaves the IPC thread. Then
skip it at boot entirely: orphan detection is a maintenance action, not a
first-paint dependency — run it on the active repo only, or on an idle
callback.

---

### F86 — `refreshAllBranchStats()` fans out over all 29 active repos with an uncapped `Promise.all`, right after the splash (P2)

`useAppInit.ts:745` fires it un-awaited:

```ts
// Refresh git stats for persisted repos
deps.refreshAllBranchStats();
```

and `createRepositoryRefreshCoordinator.ts:463-468` fans out with no limit:

```ts
const paths = scopeRepoPath ? activePaths.filter((p) => p === scopeRepoPath) : activePaths;
await Promise.all(paths.map(refreshRepo));
```

Each `refreshRepoOnce` performs at least: Phase 1 `getRepoStructure`,
`handleAutoArchiveMerged`, `handleOrphanCleanup` (→ F85), Phase 2
`getRepoDiffStats`. **Measured** repo count: **29 active** (from
`repositories.json`). So ≥ 3 commands × 29 repos ≈ **87+ concurrent invokes**,
each spawning git subprocesses, launched in the first moment the UI is
interactive.

That this is a known pressure point is written into the code itself:
`lib.rs:1058-1064` calls `raise_fd_limit()` precisely because the app opens
many descriptors at once. Raising the ceiling makes the burst survivable; it
does not make it cheap. The structure/diff-stat commands are `async` (verified),
so they do not sit on the IPC thread — that is why this is P2 and not P1 — but
they still contend for CPU and disk against the very first frames.

**Fix.** Cap the fan-out (a small concurrency pool, 4–6), and order it so the
**active** repo refreshes first and the other 28 trail behind. The user looks at
one repo; the other 28 can arrive a second later and nobody notices.

---

### F87 — the pre-splash path is a serial await chain over uncached, individually file-locked config reads (P3)

`useAppInit.ts:275-300`, in order, all before `document.getElementById("splash")?.remove()`:

1. `await deps.stores.hydrate()` — 13 serialised invokes (F80)
2. `await loadThemes()`
3. a fire-and-forget loop issuing `repoSettingsStore.loadLocalConfig(repoPath)`
   for **every** repo — **measured 38** (`useAppInit.ts:288-290` iterates
   `getPaths()`, not the active set), each an invoke competing for the same IPC
   thread as steps 2–4
4. `appLogger.hydrateFromRust()` (un-awaited)
5. `await paneLayoutStore.loadFromDisk()`

Steps 1, 2 and 5 are strictly sequential and none depends on the previous one's
result. The 38 invokes in step 3 are un-awaited but not free: by F80 they land
on the same serialised IPC queue and delay steps 4–5.

Underneath, nothing is cached. `config::load_app_config`
(`config.rs:2070-2117`) takes the in-process `CONFIG_WRITE_LOCK` **and** an
advisory cross-process file lock, holds both across the read and a conditional
migration write, and re-reads from disk on every call. `setup` alone calls it
**twice** — `lib.rs:1069` and again at `lib.rs:1420` purely to read
`index_strategy` — and every frontend hydration that needs config calls it
again. `load_json_config` (`config.rs:146-169`), `load_repositories`
(`config.rs:2411`) and `load_repo_local_config` (`config.rs:2246`) are likewise
plain re-reads. This is the boot-time face of F43's lock-in-sequence concern.

**Fix.** Three independent wins, cheapest first: (a) reuse the already-loaded
`config` value at `lib.rs:1420` instead of re-reading; (b) restrict step 3 to
the active repo and lazy-load the rest on switch; (c) fold steps 1, 2 and 5 into
one aggregate command (see F80's fix) so the splash is gated on one round trip
and one lock acquisition instead of ~50.

---

### F88 — user plugins load strictly serially and the disabled list is fetched twice (P3)

`pluginLoader.ts:382-401`:

```ts
for (const manifest of manifests) {
    ...
    await loadPlugin(manifest);
}
```

Each iteration awaits a dynamic `import("plugin://<id>/main.js?t=…")` (module
fetch through the custom protocol + evaluation), then
`await pluginRegistry.register(...)` which itself awaits
`invoke("register_loaded_plugin", ...)` (`pluginRegistry.ts:733`). Plugin *n+1*
does not start fetching until plugin *n* has finished registering — so the
protocol round trips serialise on top of the IPC round trips.

**Measured**: **7** plugins installed on this machine (count of directories
under the plugins dir in the config dir). At 7 plugins the absolute cost is
modest; the shape is what scales badly, and plugin count is user-controlled.

Separately, `syncDisabledList()` — which invokes `load_config` — runs **twice**
per boot: once at `src/plugins/index.ts:23` and again at
`pluginLoader.ts:363`, because `initPlugins` calls it and then calls
`loadUserPlugins` which calls it again. Two full locked config reads (F87) for
one unchanging list. Disabled plugins do correctly short-circuit before
`loadPlugin` (`pluginLoader.ts:389-399`), so they cost only a store entry —
that part is clean.

**Fix.** Hoist `syncDisabledList()` to `initPlugins` only and pass the result
down. Load the manifests concurrently: validate all, filter disabled, then
`await Promise.all(enabled.map(loadPlugin))` — plugin registration is
independent per plugin, and `initPlugins` already runs concurrently with
`initApp` so nothing downstream assumes an order.

---

### F89 — log retention never deletes anything: the filter matches an extension that rotated files do not have (P2)

`app_logger.rs:338` declares the policy and `:391-410` implements it:

```rust
const LOG_RETENTION_DAYS: u64 = 5;
...
for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("log") { continue; }
```

`tracing_appender::rolling::daily` names its files `tuic.log.<date>` — the
**date is the extension**, so `path.extension()` yields `"2026-08-16"`, never
`"log"`, and the `continue` fires for every single file. The cleanup is a
no-op that has never once removed a file.

**Measured** on `~/Library/Application Support/com.tuic.commander/logs/`,
2026-08-16, by `ls`/`du` only:

- **112** files, **150 MB** total
- oldest: `tuic.log.2026-04-26` — **112 days** retained against a 5-day policy
- **0** files matching `*.log`, i.e. zero candidates for the filter, confirming
  the branch is dead rather than merely rare

The startup cost is small but is pure waste: a `read_dir` plus **112**
`metadata()` + `modified()` syscalls on every launch, guaranteed to conclude
nothing. The real damage is the 150 MB, growing ~1.3 MB/day unbounded, in the
user's Application Support directory.

**Fix.** Match on the file **stem** or a `starts_with("tuic.log")` prefix
instead of the extension, and keep parsing the trailing date only as a
secondary check. Then either let the next launch collect the 112 stale files, or
ship a one-shot sweep.

---

## Not covered

- **Per-session PTY startup work.** How many sessions are recreated, with what
  concurrency, and what threads/tickers each one starts — that is **F28**'s
  territory (the 16 ms polling thread per session). Static inventory recorded
  here for whoever picks it up: **62 `savedTerminals`** and **56 branches**
  across 38 repos, read from `repositories.json`. The restore path
  (`useAppInit.ts:672` `listActiveSessions` → re-adoption loop) was read to
  confirm it is awaited after the splash, not before, and then left alone.
- **F6 and F45 internals.** Referenced as given. Supporting static measurement
  only: the ai-sessions store holds **1918** entries today (`ls | wc -l`),
  consistent with F6's 1904/6.93 MB.
- **`auto_connect_saved_upstreams`** (`lib.rs:1155-1170`) — spawned inside the
  server runtime; the upstream connection path is chunk 7's (F61, F63).
- **Relay client boot** (`lib.rs:1189-1200`) — chunk 7 verified the disabled
  gate is clean; the enabled path was not re-read here.
- **Native installs in `setup`**: `dictation::fn_key_monitor::install`,
  `native_keys::install`, `press_and_hold::disable`, `global_hotkey::init` +
  `restore_from_config`, `menu::build_menu`. They sit inside the unattributed
  443 ms gap below; none was individually priced.
- **Windows and Linux boot paths.** All measurements are macOS. The Linux
  inotify cost noted in F84 comes from the code comment at `lib.rs:1385-1388`,
  not from measurement.
- **The updater plugin's network check** (`setup`, `:1299+`) — not traced.
- **No profiler was run. The app was never launched and Boss's instance was
  never restarted.** Live state was read only through `GET :9876/logs`, which
  on this machine holds no startup lines (the instance has been up for days) —
  hence the persisted rotated log files as the timing source.

---

## Open questions

- **What is in the 443 ms gap?** In `tuic.log.2026-08-13` the last `agent_mcp`
  line lands at 07:47:05.875 and `Fn key monitor installed` at 07:47:06.318 —
  **443 ms unaccounted for**, on the boot thread, before any watcher starts. It
  is either Tauri builder/window creation (unavoidable) or `menu::build_menu` /
  `global_hotkey::init` (fixable). One `tracing::info!` on each side of the
  builder call would settle it, and it is the largest single unexplained block
  in the whole cold start — larger than F84, F85 and F82 combined.
- **Does F80's serialisation also block the platform UI thread?** The macro
  evidence proves sync commands bypass the async runtime; it does not prove
  which thread the IPC handler runs on for the macOS WKWebView backend. A
  direct measurement (log `thread::current().id()` from inside a sync command
  and compare against the main thread) would either upgrade F80 to P1 or leave
  it where it is. The fix does not depend on the answer.
- **Are the 134 stale `no-session-inject.*` flag files ever scanned?**
  **Measured**: 134 such files in the config dir. I did not find a startup
  `read_dir` over them, but I did not exhaustively trace every consumer. If
  something globs that directory the count matters; if nothing does, they are
  merely litter.
- **How often does F82's copy path actually fire?** The version check costs
  ~6 ms warm, which alone would not justify P3. The blocking `fs::copy` is what
  makes it worth fixing, and its frequency (once per app update, or more if the
  version comparison is fuzzy) was not established.
- **Is `index_strategy` ever `all_sequential` in practice?** The pre-warm at
  `lib.rs:1414-1462` is deferred 2 s and semaphore-capped at 1, which is why it
  is not a finding — but under `all_sequential` with 29 active repos it becomes
  a long tail of index builds that F45 then never frees. This machine's value
  was not read out of `config.json`.
