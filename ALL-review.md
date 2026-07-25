---
date: "2026-07-07"
author: "full-codebase review (branch main)"
reviewers: "Multi-Agent swarm — 65 reviewers across 9 sections (security, performance, architecture, simplicity, silent-failure, test-quality, rust, typescript, data-safety)"
branch: "main"
target_ref: "d2d1f3c4d0d7e61f5f11b37929c0d7a5310b282c"
scope: "entire repository (not a diff) — segmented into 9 functional blocks"
status: "open"
---

# FastAF — Full-Codebase Review (ALL-review)

**What this is.** A segmented review of the whole repository at `main` (HEAD `d2d1f3c4`), not a diff. The app was split into 9 functional blocks (S1–S9) and each was reviewed by 6–8 specialist agents (security, performance, architecture, simplicity, silent-failure, test-quality, plus the relevant language reviewer, and data-safety for the persistence-heavy core). Per-section raw reports live in the review directory under one file per reviewer; this document consolidates them.

**Reviewer scope note.** All reviewers were briefed on the project's *Accepted Security Decisions* (local single-user tool, user is the trust boundary — wide CSP, loopback-without-auth, `opener` scope, agents keystroking TUIs are all intentional and NOT flagged). Findings below respect that scope. The exceptions where the trust boundary genuinely extends outward — third-party **plugins** (non-user code), **remote surfaces** (tunnels/relay/PWA), and **untrusted remote content** (GitHub PR/CI text, LLM output) — are where the real security findings concentrate.

> **Progress tracking.** Every finding below carries a `- [ ]` checkbox.
> Tick it (`- [x]`) **only** once the fix is implemented AND verified.
> Findings: 9 P1 (headings) + 40 P2/P3 (list items). Started all-open.

## Segmentation

| Block | Area | Key files |
|-------|------|-----------|
| S1 | PTY & Terminal Core | `pty.rs`, `terminal_grid.rs`, `output_parser.rs`, `input_line_buffer.rs`, `chrome.rs`, alacritty fork |
| S2 | Git & Worktree | `git.rs`, `git_cli.rs`, `git_reads.rs`, `worktree.rs`, `repo_watcher.rs`, `diff_triage.rs` |
| S3 | GitHub Integration | `github.rs`, `github_account.rs`, `github_auth.rs`, `github_poller.rs` |
| S4 | AI & Agents | `agent*.rs`, `ai_agent/*`, `ai_chat*.rs`, `provider_registry.rs`, `claude_usage.rs`, `dictation/*` |
| S5 | MCP / HTTP / Remote | `mcp_http/*`, `mcp_oauth/*`, `mcp_proxy/*`, `relay_client.rs`, `tunnels/*`, `tailscale.rs` |
| S6 | Core Infra | `lib.rs`, `state.rs`, `config.rs`, `fs.rs`, `credentials.rs`, `content_index.rs`, `updater.rs` |
| **S7** | **Plugin System** | `plugins.rs`, `plugin_*.rs`, `mcp_http/plugin_*.rs`, `src/plugins/*`, `PluginPanel/` |
| S8 | Frontend State & Transport | `transport.ts`, `src/stores/*`, `src/hooks/*`, `src/utils/*` |
| S9 | Frontend UI (SolidJS) | `App.tsx`, `src/components/**`, `src/mobile/*`, `panelAdapters/*` |

---

## Executive Summary

Overall this is a **mature, unusually well-defended codebase** for its size. The hottest paths (PTY intake, terminal grid, GitHub poller, content index, credential vault, OAuth/PKCE) show clear evidence of prior perf/security passes: bounded ring buffers, `spawn_blocking` for blocking work, circuit breakers, atomic config writes, documented incident-driven guards. The findings are concentrated where the code is largest and where the trust boundary actually extends outward.

**Headline risks (fix first):**

1. **Plugin capability model is bypassable** — the single most serious cluster. `plugin_id` is a self-asserted string with no caller-identity binding, and plugins run in the app's own JS realm; combined with two capability checks that trust caller-supplied data instead of the on-disk manifest, a plugin can impersonate another plugin's grants, perform SSRF, and read the app's own secrets vault (S7 SEC-1/2/3).
2. **Argument injection into git** — untrusted GitHub PR branch names flow into `git fetch`/`rebase`/`worktree add` without a `--` end-of-options guard (S2 SEC-1/2/3); the codebase already knows the fix (it's applied correctly in `git_stage_files`), just not everywhere.
3. **GitHub token leak via legacy URL parser** — `github::parse_remote_url` doesn't strip `user:token@` userinfo, corrupting the owner to contain the raw token and leaking it into app logs and GraphQL queries (S3 SEC-1).
4. **Two data-loss defects in the persistence layer** — credential-vault migration deletes the source before persisting the merged vault (S6 DATA-1), and `write_file`/config writes for `.tuic.json` are non-atomic (S6 DATA-3/4).
5. **A reachable panic** — `repo_name_to_prefix` indexes/slices by byte on directory basenames, crashing on unicode or separator-only names (S6 BUG-1).
6. **Prompt-injection into autonomous agents** — untrusted CI logs are injected verbatim into a live agent terminal by auto-heal (S8 SEC-1), and the case-insensitive safety-checker bypass lets `RM -rf`/`Sudo` skip the approval gate on macOS (S4 SEC-1).

**Cross-cutting themes** (recur in ≥3 sections): god-files/god-objects; blocking-in-async without `spawn_blocking`; IPC/HTTP parity drift; silent failures on user-facing actions (log-only, no toast); and doc/reference drift.

### Counts (confidence ≥ 70, deduplicated)

| Severity | Count | Meaning |
|----------|-------|---------|
| **P1 — Critical** | 9 | Data loss, reachable panic, or real security issue within scope. Fix before further release. |
| **P2 — Important** | ~40 | Perf problems, races, missing error handling, architecture violations, resilience gaps. |
| **P3 — Nice-to-have** | ~70 | Style, dead code, minor optimizations, doc drift, test gaps. |

(Test-coverage gaps and file-size/decomposition notes are numerous and largely P3; they are summarized rather than enumerated.)

---

## P1 — Critical (fix before merge/release)

### [SEC-1] Plugin capability model is bypassable — cross-plugin impersonation
- [ ] **resolved & verified**
**File:** `src-tauri/src/plugins.rs:31-73`, `src-tauri/tauri.conf.json:13` **· Reviewer:** security (S7) **· Confidence:** 90
`check_plugin_capability` trusts a `plugin_id` string passed by the JS caller. All plugins load as ES modules into the **same window/document** (no per-plugin iframe isolation), and `withGlobalTauri: true` with no isolation `pattern` means `window.__TAURI__.core.invoke` is reachable from any plugin. A plugin declaring zero capabilities can call `invoke("plugin_exec_cli", {..., pluginId: "some-trusted-plugin"})` and inherit that plugin's `exec:cli`/`net:http`/`credentials:read` grants. **Fix:** bind capability checks to the actual message origin (per-plugin sandboxed iframe + capability-scoped postMessage RPC), as already done for `ui:panel` HTML. Requires design discussion — flag to Boss.

### [SEC-2] `plugin_http_fetch` trusts caller-supplied `allowedUrls`, not the manifest — SSRF/scope bypass
- [ ] **resolved & verified**
**File:** `src-tauri/src/plugin_http.rs:145-155` **· Reviewer:** security (S7) **· Confidence:** 92
The fetch handler receives `allowed_urls` as a request parameter and uses it for both the allowlist and the localhost/RFC1918 SSRF guard — it never reads `manifest.allowedUrls`. A plugin restricted to `api.telegram.org` can call the command directly with `allowedUrls: ["http://*"]` and hit internal hosts / `169.254.169.254`. The sibling `plugin_exec_cli_impl` does this correctly (re-reads `manifest.binaries`). **Fix:** derive `allowed_urls` from `read_single_manifest(&plugin_id)?.allowed_urls`; drop the parameter from the command and HTTP route.

### [SEC-3] `credentials:read` can read FastAF's own secrets vault
- [ ] **resolved & verified**
**File:** `src-tauri/src/plugin_credentials.rs:54-65,106-127` **· Reviewer:** security (S7) **· Confidence:** 85
`plugin_read_credential` only validates the service-name *format*; it has no denylist. A plugin with `credentials:read` (meant for reading *other* tools' credentials) can call `host.readCredential("tuicommander")` and receive the app's entire keychain vault (GitHub tokens, LLM API keys, MCP upstream tokens) in one call. **Fix:** reject `service_name == credentials::KEYRING_SERVICE` and the `LEGACY_ENTRIES` names before the OS lookup.

### [SEC-4] Argument injection: untrusted git ref/branch names without `--` guard
- [ ] **resolved & verified**
**File:** `conflict_assist.rs:96,102,115` → `worktree.rs:216-240`; also `git.rs:389,624`, `worktree.rs:1484` **· Reviewer:** security (S2) **· Confidence:** 80–85
GitHub PR `head_ref`/`base_ref` (attacker-chosen branch names, valid to begin with `-`) flow unguarded into `git fetch origin <ref>`, `git worktree add … <branch>`, `git rebase <ref>`, and `git branch -m <old>`. A branch like `--upload-pack=…` is parsed as a git *option*, not a ref. One-click "resolve conflicts on PR #N" fires this automatically. Fork PRs are gated out, so exploitation needs same-repo branch-create rights. The fix idiom already exists in this file (`git_stage_files` uses `["add", "--", …]`). **Fix:** insert `--` before every ref/branch/pathspec argument, and/or run names through the existing `validate_branch_name`.

### [SEC-5] GitHub token leak via legacy `parse_remote_url`
- [ ] **resolved & verified**
**File:** `src-tauri/src/github.rs:180` (consumed at 2057, 2401, 3069, 1254) **· Reviewer:** security (S3) **· Confidence:** 92
The old github.com-only parser doesn't strip `user:token@` userinfo. For a remote `https://<TOKEN>@github.com/owner/repo.git`, it returns owner = `"<TOKEN>@github.com"` — the raw token — which then flows into `tracing::warn!` (readable at `:9876/logs`, no debug gate) and into GraphQL query text sent to GitHub. The host-aware `github_account::parse_remote_url` strips userinfo correctly; four call sites were never migrated to it. **Fix:** route the four call sites through the host-aware parser and delete the legacy one; add a regression test for `token@`/`user:token@` URLs.

### [DATA-1] Credential-vault migration deletes source before persisting → permanent credential loss
- [ ] **resolved & verified**
**File:** `src-tauri/src/credentials.rs:191-213` **· Reviewer:** data-safety (S6) **· Confidence:** 90
In the legacy-sweep migration, each legacy keyring entry is `delete_keyring_entry(...)`'d *before* the merged vault is persisted (single `persist(&vault)?` after the loop). A crash or a `persist()` failure (locked keychain, circuit-breaker open) between the delete and the persist loses the secret from both locations, silently. The lazy per-key path in `get()` does it in the correct order (persist then delete). **Fix:** collect the delete list, `persist(&vault)?` first, then delete.

### [DATA-2] Non-atomic file writes → data loss on crash
- [ ] **resolved & verified**
**File:** `fs.rs:1109-1118` (`write_file`), `lib.rs:713-719` (`write_external_file`), `config.rs:1496-1515` (`.tuic.json`) **· Reviewer:** data-safety (S6) **· Confidence:** 80–85
The code-editor / markdown save flows and the repo-shared `.tuic.json` write use plain `std::fs::write` (truncate-then-write); a crash mid-write destroys the user's file. The config subsystem already has `persist_atomic` (temp + rename) for exactly this. Separately, `persist_atomic`'s temp filename is per-process-not-per-call, so two concurrent writers to the same config file can corrupt it (DATA-3). **Fix:** route user-file writes through a temp+rename helper (preserving existing perms, not forcing 0600); make the temp name unique per call.

### [BUG-1] Reachable panic in session-alias derivation on unicode/separator-only directory names
- [ ] **resolved & verified**
**File:** `src-tauri/src/state.rs:1479-1494` **· Reviewer:** rust (S6) **· Confidence:** 92
`repo_name_to_prefix` (called from `assign_term_alias` on every new PTY session) indexes `segments[0]` without an empty-check and slices `&s[..1]`/`s[..2]` by **byte** offset. A directory named `"..."`/`"---"` panics on the empty-vec index; a directory like `"café-app"` or `"日本-tools"` panics on the mid-codepoint slice. Directory names are user-controlled external data. **Fix:** guard `segments.is_empty()`; use `s.chars().next()` / `chars().take(2)` instead of byte slicing.

### [SEC-6] Untrusted CI logs injected verbatim into an autonomous agent terminal
- [ ] **resolved & verified**
**File:** `src/hooks/useCiHeal.ts:81-128` **· Reviewer:** security (S8) **· Confidence:** 80
With branch auto-heal enabled, `fetch_ci_failure_logs` output (attacker-influenceable for repos accepting fork PRs) is written straight into a live agent session via `sendCommand`, no sanitization/truncation/human review — indirect prompt injection into an agent that has shell + repo write access. This is a *remote* attacker (PR/CI author), outside the accepted "local user drives the agent" boundary. **Fix:** cap/strip log content, require one-tap user approval before injection (at least first run per branch), and frame it as untrusted data. Related P2: **S4 SEC-1**, the safety-checker regexes are case-sensitive, so `RM -rf ~`, `Sudo …`, `CAT ~/.ssh/id_rsa` bypass the approval gate on macOS's case-insensitive FS — add `(?i)` to every pattern.

---

## P2 — Important (should fix)

### Correctness & resilience
- [ ] **[S2 BUG]** Worktree stale-dir background recreation emits only the Tauri window event, not `event_bus` — HTTP/SSE/PWA clients never learn the outcome; and there is no `AppEvent::WorktreeCreateFailed` variant at all. Violates the "producers dual-emit" rule. (`worktree.rs:697-726`, conf 92)
- [ ] **[S2 BUG]** Rebase/merge auto-abort paths return `Err("… (aborted)")` without checking whether the abort itself succeeded — the user is told the repo is clean when it may be mid-conflict. (`git.rs:533-562`, `worktree.rs:1609-1617`, conf 80-85)
- [ ] **[S2 BUG]** `remove_worktree_by_branch` returns `Ok(())` even when the requested branch deletion failed (logged-only) — the branch silently persists. (`worktree.rs:863-891`, conf 80)
- [ ] **[S2 BUG]** `parse_porcelain_v2` silently drops unmerged (`u `) entries and `WorkingTreeStatus` has no conflicted field — during a merge the badge can say "conflict" while the Changes panel shows zero files. (`git.rs:2313-2365`, conf 85)
- [ ] **[S3 BUG]** IPC/HTTP parity: the HTTP `poller_start` no-ops when the poller isn't already running (never calls `start`), and drops `pr_hide_drafts` + `ForceResync` — a browser/PWA client can never cold-start GitHub polling. (`github_routes.rs:290-302`, conf 90)
- [ ] **[S3 BUG]** `get_issue_detail_impl` never checks HTTP status — a 404/401 body parses as a valid empty issue and even builds an "autofix" prompt for a non-existent issue. (`github.rs:1761-1829`, conf 90)
- [ ] **[S3 BUG]** Viewer-login resolution failures swallowed with `unwrap_or_default()` → empty `viewer` silently zeroes issue filters and drops the user's own PRs, with no log. (`github.rs:1271-1275,1530-1532`, conf 85)
- [ ] **[S5 BUG]** Health-check failures in the MCP upstream registry discard the actual error and never update `last_error` — the UI shows stale/empty diagnostics. (`mcp_proxy/registry.rs:1286-1317`, conf 88)
- [ ] **[S5 BUG]** `TunnelManager::start()` has no id-collision guard — a double-start spawns a second supervisor + `ssh` child and overwrites the handle, orphaning the first process forever (no `Drop`). (`tunnels/manager.rs:34-74`, conf 82)
- [ ] **[S5 BUG]** MCP `tools/call` accepts any client-supplied `Mcp-Session-Id` and silently auto-registers it as a new valid session — weakens session/identity isolation within the authenticated boundary. (`mcp_transport.rs:3245-3288`, conf 70)
- [ ] **[S5 ARCH]** `mcp_transport.rs`'s `handle_worktree`/`handle_session` reimplement business logic that already exists in `worktree_routes.rs`/`session.rs`, and have already diverged: MCP `worktree create` validates the repo path, the HTTP route doesn't; MCP `session input` skips `stamp_input_ms` + `InputLineBuffer` that the HTTP write path applies (throttle + slash-mode FSM drift). (conf 92-95)
- [ ] **[S8 BUG]** `save_remote_connection` (Tauri IPC) skips the `validate()` its HTTP twin enforces — desktop can persist invalid connections; IPC/HTTP parity violation. (`remote_connection.rs:169-184`, conf 93)
- [ ] **[S9 BUG]** Command-palette "Close terminal tab" closes `terminalIds()[0]` (first tab of the branch), not the active tab. (`actions/actionRegistry.ts:115-118`, conf 90)
- [ ] **[S4 BUG]** `watcher.rs::update_rule` mutates the live shared rule before validating, so a rejected update still corrupts the in-memory rule (e.g. zeroes `max_fires`); the two tests meant to catch this never call the function. (`watcher.rs:276-313`, conf 82)
- [ ] **[S4 BUG]** `TextCorrector::correct` advances byte offsets by the original key length while matching the lowercased key — a case-folding length change (user-editable dictionary) can panic or corrupt. (`dictation/corrections.rs:36-60`, conf 80)

### Security (in-scope, outward-facing)
- [ ] **[S5 SEC]** Relay "E2E encryption" derives its AES key from the same `relay_token` sent in cleartext to the relay for auth — the relay operator can re-derive the key and decrypt all traffic. It's TLS-equivalent, not E2E. (`relay_client.rs:56-61,217-219`, conf 90)
- [ ] **[S5/S6 SEC]** Remote-access secrets (`session_token`, `relay.token`, `vapid_private_key`) are stored in plaintext `config.json` instead of the keychain that already handles GitHub/MCP/provider secrets; `relay.token` is additionally not redacted from `GET /config`. (`config.rs:308-421`, `config_routes.rs:32-45`, conf 85-95)
- [ ] **[S5 SEC]** `auth_rate_limits` DashMap grows unbounded (entries removed only on *successful* auth) — a slow memory leak / DoS vector on any instance with remote access enabled. (`auth.rs`, `state.rs:956`, conf 85-90) *(flagged independently by 3 reviewers)*
- [ ] **[S4 SEC]** `read_file` tool bypasses the sensitive-path approval gate that `cat ~/.ssh/…` hits via the shell path (`_unrestricted: true` hard-coded); and the sensitive-file lists miss `.netrc`/`.npmrc`/`.docker/config.json`/`.kube/config`/`.pgpass`, with `redact_secrets` not catching Docker `"auth"` blobs. (`ai_agent/tools.rs`, `safety.rs`, conf 72-78)
- [ ] **[S1 SEC]** OSC 7770 `suggest=` and OSC 52 clipboard-write are accepted from *anywhere* in the PTY byte stream (not gated on shell-integration provenance) — any displayed file/log can spoof AI-suggestion chips (one-click `sendCommand` auto-Enter) or silently overwrite the clipboard. (`terminal_grid.rs`, `pty.rs`, conf 85-90)

### Performance
- [ ] **[S1 PERF]** `TerminalGrid::process()` rebuilds and diffs the *entire* visible screen (`read_screen_text`, O(rows×cols)) on every PTY read chunk, un-throttled, ignoring the alacritty damage tracking the render path already uses — hundreds/sec under spinner-heavy or flood output. (`terminal_grid.rs:436-460`, conf 85)
- [ ] **[S4 PERF]** Gemini/Codex session discovery does a full recursive scan (Gemini additionally reads+parses *every* session file) with no `max_age` bound, fired on every idle↔busy transition per terminal (~every agent turn), not just the 30s poll — cost grows with lifetime agent history × open terminals. (`agent_session.rs:198-313`, conf 88-92)
- [ ] **[S5 PERF]** All three PTY WebSocket handlers subscribe to the *global* event bus and locally filter by session id → O(sessions × subscribers) clone+match fan-out per event; the codebase already fixed this exact pattern for AI token streams (`ai_stream.rs`) but not for PTY. (`mcp_http/session.rs`, conf 90)
- [ ] **[S6/S6-sec PERF]** Content index `rebuild_index` is a **full** re-walk + re-read + re-BM25-build every time (only binary-classification is mtime-cached); `path_to_idx`/`FileEntry.mtime` are built every rebuild but never read. The module doc claims "incremental" — it isn't. Bounded by a 60s cooldown but still O(total repo text) per qualifying event. (`content_index.rs:139-224`, conf 80)
- [ ] **[S3 PERF]** `resolve_repo_for_rest` / `local_branch_tips` / `tag_committer_date` do blocking file/keychain/git-subprocess I/O directly inside `async` handlers (no `spawn_blocking`) — the ambient path was wrapped correctly, the named-account path wasn't; `resolve_token_for_account` is even called twice per account per poll tick. (`github.rs`, conf 85-90)
- [ ] **[S2 PERF]** `gix_topo_order` walks the *entire* reachable history regardless of the requested page size (bound applied after the full walk) — every commit-log page / graph render pays O(total history). (`git_reads.rs:388-447`, conf 92)
- [ ] **[S2 PERF]** `apply_base_ahead_behind_and_sort` spawns one `git config` subprocess per local branch, sequentially, ungated by the monitoring semaphore — a worktree-heavy repo spawns N subprocesses per `branches_detail`, re-triggered on every cache invalidation. (`git.rs:1867`, `worktree.rs:1315`, conf 90)
- [ ] **[S7 PERF]** The plugin output-watcher hot path pays full LineBuffer reassembly + `stripAnsi` for **every** session once *any* watcher is registered (the bundled `claude-wakeup` plugin registers one), because the agent-type filter runs *after* the string work; `LineBuffer` also has unbounded growth (O(n²)) on newline-less streams (progress bars). (`pluginRegistry.ts:822`, `lineBuffer.ts:16`, conf 75-85)
- [ ] **[S5/S3/S6 PERF]** Recurring "blocking in async without `spawn_blocking`": MCP `disconnect_upstream` (2s sleep loop), `hash_password_http` (bcrypt cost 12), `list_user_plugins_http`, `plugin_read_credential` (keychain shell-out), push-store persistence. All have the correct pattern applied *elsewhere* in the same modules. (conf 75-90)
- [ ] **[S8 PERF]** Multiple user-facing loops serialize IPC round trips instead of `Promise.allSettled`: command-palette terminal search (per keystroke), "Close all tabs"/"Close to right", orphan-worktree cleanup, agent-detection fallback poll. (`useGitOperations.ts`, `commandPalette.ts`, `useTerminalLifecycle.ts`, conf 85-92)
- [ ] **[S9 PERF]** `verifyVisibleFileLinks` awaits `resolve_terminal_path` sequentially per candidate on a 150ms debounce after every frame (the sibling `checkLinksAtRow` already uses `Promise.all`); selection-drag `mousemove` repaints + `getBoundingClientRect` un-rAF-coalesced. (`CanvasTerminal.tsx`, conf 80-90)

### Silent failures (user-facing actions that fail with no visible feedback)
- [ ] **[S9 SILENT]** A consistent, systemic pattern across the frontend: **git stage/unstage/discard, push/pull/fetch/rebase/create-branch, file New/Open/Open-Path, mobile PTY writes, block-navigation, MCP credential save, dictation import** all catch errors with `appLogger.error` only — no toast, no inline error. Destructive ops (discard) are silent too. The toast convention exists and is used for delete/merge in the *same* files, proving the gap is inconsistency, not absence. (S9 silent-failure: `ChangesTab.tsx`, `BranchesTab.tsx`, `App.tsx`, `src/mobile/**`; conf 75-90). Backend equivalents: config/theme/panel-geometry save failures logged at `debug`/not-at-all (S6, S8).

---

## Dedicated Section: Plugin System (S7)

*Requested as its own section. The plugin system is architecturally the strongest-designed subsystem in places (clean `_impl`/`_inner` ports-and-adapters split, defense-in-depth capability checks, thorough path-traversal/zip-slip/SSRF guards, one of the best test suites in the repo) — but it is also the one place non-user code runs, and that is where the review found the most serious issues.*

### Security (the critical cluster — see P1 SEC-1/2/3 above)
The capability model's core weakness is that **`plugin_id` is identity-by-assertion**. Because plugins share the app's JS realm (no per-plugin isolation, `withGlobalTauri: true`), the server-side capability check can be bypassed by any plugin calling `invoke` with another plugin's id. On top of that root cause:
- `plugin_http_fetch` enforces its allowlist against caller-supplied `allowedUrls` instead of the manifest (SSRF).
- `credentials:read` has no denylist, so a plugin can read the app's own `"tuicommander"` keychain vault.
- `read_plugin_data`/`write_plugin_data`/`delete_plugin_data` require *zero* capability and no ownership check → cross-plugin data tampering (S7 SEC-4, conf 85).
- `register_loaded_plugin` can strip another plugin's capabilities (functional DoS) — same root cause (S7 ARCH-1, conf 75).

**Recommendation:** treat the isolation redesign (per-plugin sandboxed iframe + capability-scoped postMessage RPC, so Rust binds checks to a real channel) as a tracked design task. As interim mitigations that don't need the redesign: fix `plugin_http_fetch` to read the manifest (SEC-2), add the vault-service denylist to `credentials:read` (SEC-3), and stream+cap `plugin_http_fetch` bodies (see below).

### Lifecycle & resource leaks
- [ ] **[BUG, conf 90]** `uninstall_plugin` deletes the plugin directory but never sweeps `state.plugin_watchers` (live `notify` handles + blocked debounce threads) or `state.loaded_plugins`; the uninstall button isn't gated on loaded-state, so uninstalling an active plugin leaks a watcher thread + OS handle + orphaned capability grant for process lifetime. **Fix:** have Rust `uninstall_plugin` proactively drop the plugin's watchers and capability entry. (`plugins.rs:863`)
- [ ] **[PERF, conf 75]** `plugin_http_fetch` buffers the full response via `.bytes()` before the size-cap check when `Content-Length` is absent (chunked/streamed) → unbounded memory before rejection. **Fix:** stream via `.chunk()`, abort past `MAX_RESPONSE_BYTES`.
- [ ] **[PERF, conf 80]** `fs:watch` has no per-plugin cap (unlike `exec:cli`'s 60/min limiter); a buggy plugin re-registering watches leaks one OS thread + fs watcher per call.

### Silent failures
- [ ] **[BUG, conf 90]** Several plugin-supplied callbacks are invoked *without* the try/catch that the docs promise ("all boundaries are try/catch wrapped"): `fileIconRegistry.resolve()` (called per file-browser row, inside a reactive memo — a throw can break the whole panel), `filePreviewRegistry.onOpen`, context-menu/terminal `action(ctx)`, activity-item `onClick`. **Fix:** wrap at the registry boundary; catch-and-return-null for the icon path.

### Architecture / doc drift
- [ ] **[ARCH, conf 85]** `plugin_docs.rs` (the AI-facing reference served to code-generating agents) has drifted from `docs/plugins.md` and the actual API: missing `ui:file-preview`/`registerFilePreview`/`registerFileIconProvider`, a factually wrong plan-file path claim, and SDK-method disagreement. An AI author generating a plugin from it will produce incorrect code. **Fix:** reconcile, and add a `make check` grep asserting every `KNOWN_CAPABILITIES` string appears in both docs.

### Type safety & correctness (TS side)
- [ ] **[BUG, conf 90]** `loadPlugin()` doesn't `await pluginRegistry.register()` (floating promise) — success is logged and `loadedPluginIds` updated before Rust registration/`onload` actually completes.
- [ ] **[BUG, conf 95]** Duplicate `unregister_loaded_plugin` IPC calls (`unregister()` already issues it) — chatty + reveals the author didn't realize it's already handled.
- [ ] **[BUG, conf 75]** `planPlugin` never rebinds its plans watcher on repo switch (unlike `storiesTickerPlugin`); its `scanPlans` export is dead code.
- Several `!` non-null assertions and unchecked `as PluginCapability` casts (TYPE-1..4).

### YAGNI / dead surface
`ui:sidebar`/`registerSidebarPanel` and `git:read` capabilities are fully wired end-to-end but have **zero producers** among the built-in + vendored plugins (verified). Not "delete now" — it's public third-party API surface — but either dogfood it or correct the stale CHANGELOG claim.

### Test gaps
`plugin_pty.rs` has zero tests; ~40% of `pluginRegistry.ts` Tier-3 capability gates are untested; the pause feature, `register_loaded_plugin` manifest-validation, and install/uninstall data-preservation/zip-slip flows are untested (blocked by a missing `plugins_dir()` test override — the `plugin_fs.rs` `HOME_DIR_OVERRIDE` pattern should be replicated).

---

## Cross-Cutting Analysis (root causes)

| Root cause | Where it shows up | Suggested systemic fix |
|------------|-------------------|------------------------|
| **God-files / god-objects** | `pty.rs` (11.5k lines), `state.rs` (215K, ~110 flat `DashMap` fields, 617 external touch points), `github.rs`, `mcp_transport.rs` (8k), `config.rs`, `ai_agent/tools.rs` (2.4k), `App.tsx` (3k), `useGitOperations.ts` (2.2k god-hook) | Decompose along seams the code already implies. Highest-value + lowest-risk: `pty.rs` → chunk-processor / reader / process / standby / commands; extract more `AppState` sub-structs (the `GitCacheState`/`RelayState` pattern already proven). Large refactors — track as stories, don't do opportunistically. |
| **Blocking-in-async without `spawn_blocking`** | S3 (keychain, git subprocess, ×2 per tick), S5 (bcrypt, stdio shutdown 2s loop, push persist), S6/S7 (config/plugin fs reads) | Each has a correct sibling in the same module. Sweep for `std::fs`/`Command::output`/`keyring`/`bcrypt` inside `async fn` and wrap. Consider caching parsed registry/bindings in `AppState` behind an `RwLock`. |
| **IPC/HTTP parity drift** | `poller_start` no-op, `save_remote_connection` validation gap, `mcp_transport` reimplementing worktree/session logic, `transport.test.ts` covering ~half of `COMMAND_TABLE` | Extract shared inner functions both transports call; add a test that walks the actual `#[tauri::command]` list and asserts every command is in `COMMAND_TABLE` ∪ `INTENTIONALLY_UNMAPPED`. |
| **Silent failures on user actions** | git stage/discard/push/pull, file ops, mobile writes, config/theme/geometry saves | Route user-action failures through `toastsStore` (frontend) / `appLogger.error` + surfaced state (backend). The convention exists; apply it uniformly. Escalate persistence-write failures from `debug` to `error`. |
| **Argument injection (missing `--`)** | `git.rs`, `worktree.rs`, `conflict_assist.rs` (branch/ref/pathspec/file args) | Add a `git_cli.rs` lint/checklist note; every trailing ref/branch/pathspec arg gets a `--` or `validate_branch_name`. |
| **Doc / stale-comment drift** | `plugin_docs.rs` vs `docs/plugins.md`, stale security comments in `state.rs`/`lib.rs` (claim token rotation / "never reaches JS" that aren't true), stale `DEFERRED`/TODO past their dates | Add grep-based parity checks to `make check`; sweep `DEFERRED (YYYY-MM-DD)` for dates > ~8 weeks old. |
| **Dead code / YAGNI** | `ChatRegistry` write-path (unwired cross-window sync), i18n scaffold (no-op `t()`, empty `en.json`, no UI), `DetachedPlaceholder`, 3 unemitted `AppEvent` variants, `error_classification::classify_error` (shadowed/uncalled), `path_to_idx`/`mtime`, `clamp_cursor_up`, `git:read`/`ui:sidebar` plugin caps | Delete or wire, per YAGNI. Several carry `#[allow(dead_code)]` with "future story" comments past their usefulness. |

### Single-fix opportunities (address multiple findings at once)
1. **Add `--` to all git ref/branch/pathspec args** — closes S2 SEC-1/2/3/4 (one idiom, ~8 sites).
2. **Migrate the 4 legacy `parse_remote_url` call sites** — closes S3 SEC-1 (token leak) *and* S3 ARCH-7 (dual-parser drift) *and* the GHE "silently empty" functional gap.
3. **Extract a shared REST helper with circuit-breaker + rate-limit handling** — closes S3 ARCH-2 (inconsistent resilience across 7 REST endpoints), ARCH-3/4/5 (duplication), and the blocking-in-async items.
4. **Route user-file + `.tuic.json` writes through a temp+rename helper** — closes S6 DATA-2/3/4.
5. **Per-session PTY event channel** — closes S5 PERF (WS fan-out) and the 3× duplicated filter block.

---

## Per-Section Summary

| Section | Overall | Notable |
|---------|---------|---------|
| S1 PTY/Terminal | Strong; well-defended hot path | P2 full-screen diff per chunk (PERF); OSC 7770/52 provenance (SEC); `pty.rs` god-file; a few missing `// SAFETY:` comments |
| S2 Git/Worktree | Disciplined error handling | **P1 arg injection**; abort-not-checked, silent branch-delete, dropped conflict entries; `gix_topo_order` full-history walk; god-files `git.rs`/`worktree.rs` |
| S3 GitHub | Good circuit-breaker/multi-account design | **P1 token leak**; poller IPC parity, empty-success on API errors; blocking keychain in async; inconsistent REST resilience |
| S4 AI/Agents | Sandbox/safety well-tested | **P1 safety-checker case bypass**; Gemini/Codex discovery cost; `update_rule` mutate-before-validate; `tools.rs` god-module; unwired `ChatRegistry` |
| S5 MCP/HTTP/Remote | Exemplary OAuth/PKCE | Relay pseudo-E2E; unbounded rate-limit map; tunnel start race; `mcp_transport` reimplements logic; blocking-in-async |
| S6 Core Infra | Credentials/config mostly solid | **P1 vault migration loss, panic, non-atomic writes**; god-object `state.rs`; content-index not incremental; secrets in plaintext config |
| **S7 Plugins** | Best-designed *and* highest-risk | **P1 capability bypass / SSRF / vault read**; uninstall leaks; docs drift; strong test suite with specific gaps |
| S8 Frontend State | High quality, clean types | **P1 CI-log prompt injection**; god-hook `useGitOperations`; silent save failures; sequential IPC loops; transport test coverage gap |
| S9 Frontend UI | Consistent, no snapshot anti-patterns | God-component `App.tsx`; silent user-action failures; `window.confirm` vs the app's dialog standard; dead i18n/DetachedPlaceholder; large untested components (CanvasTerminal, PaneTree, GitPanel, CommandPalette) |

---

## Recommended Actions

1. **Immediate (P1, before next release):**
   - Plugin capability model: fix `plugin_http_fetch` (manifest allowlist) and `credentials:read` (vault denylist) now; open a design story for real per-plugin isolation.
   - Add `--` guards to all git ref/branch/pathspec args.
   - Migrate the 4 legacy `parse_remote_url` sites (token leak).
   - Fix credential-vault migration ordering + non-atomic file writes.
   - Fix the `repo_name_to_prefix` panic (guard + char-safe slicing).
   - Gate CI-log injection behind approval; add `(?i)` to safety-checker regexes.
2. **This cycle (P2):** IPC/HTTP parity fixes (poller, remote-connection validation, mcp_transport dedup); resilience gaps (health-check `last_error`, tunnel start race, get_issue_detail status check); the PERF items on the PTY/GitHub/plugin hot paths; the systemic silent-failure toast pass.
3. **Follow-up (P3):** god-file decomposition (as tracked stories with Boss sign-off), dead-code/YAGNI removal, doc-drift parity checks in `make check`, and the test-coverage backfill (transport parity test, `plugin_pty.rs`, resize-race, untested stores/hooks/components).

**Next step:** run `/wiz:triage` to turn these into stories (there are well over 5 findings). The P1 cluster and the "single-fix opportunities" list are the highest impact/effort ratio.
