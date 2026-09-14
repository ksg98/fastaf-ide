<!-- tweak-comments v1: inline review comments.
     Format: [tweak:begin:ID]highlighted text[tweak:end:ID @ISO-TIMESTAMP
     comment body (free text, may span multiple lines)
     ] — where [ ] are the HTML comment delimiters <!-- -->.
     The only escape is '-->' → '--&gt;' inside the comment body.
     Read each comment, apply the feedback to the highlighted text,
     then remove the tweak markers. -->

# To Test

Features to test when FastAF is more usable.

**This file is the only tracker for anything a human must verify.** Never open a
story for a post-rebuild or manual check — its criteria can never be met by an
agent, so it stays open forever and the backlog fills with stories nobody can
close. Add an item here instead. When an item passes, delete it; a section with
no items left goes too. What stays open must carry its own stated reason.

> **Where the restart gate sits (measured 2026-08-29).** The backend serving
> `:9876` is a debug build whose process started **2026-08-25 23:20:31**, so the
> newest commit it can contain is `78d8dac2` (08-25 00:39). Everything Rust-side
> up to and including the 08-24 batch **is live** — those sections no longer need
> a restart to be tested, only their own reason to stay open. Everything from the
> 08-26 batch onward (`c344e29f` … and all of 08-27) is **not** loaded. Its own
> binary is already gone from `src-tauri/target/debug/`, so the build time cannot
> be read back off disk; the process start time is the only bound.
>
> **The frontend has no such gate.** In a debug build the HTTP server reads
> `dist/` from disk on every request (`static_files.rs:65-90`), not the
> `include_dir!` copy, so a browser client at `:9876` picks up any frontend change
> after a plain `pnpm build` + reload — no Rust rebuild, no restart. The desktop
> WebView gets the same change over Vite HMR. If a browser check of a frontend fix
> shows nothing, check `dist/index.html`'s mtime before blaming the code.

## A backend-created worktree offers itself as a toast, not a modal (2026-08-30, frontend only — HMR)

The "Switch to new worktree?" confirm was a blocking modal with a ten-second
auto-cancel, raised only by MCP/HTTP worktree creation — the one case with nobody
at the keyboard. It is a toast with a **Switch** button now, mirrored into the
bell so an unattended run leaves the offers waiting instead of discarding them.
Behaviour is covered by `worktreeSwitchPrompt.test.ts`; what tests cannot see is
how it renders and whether it interrupts anything.

- [ ] Have an MCP client call `repo worktree_create`. A toast appears with the
  repo badge, `Worktree "<branch>" created`, the `repo__wt/branch` subtitle and a
  **Switch** button. Nothing blocks, no dialog, no countdown, and typing in the
  focused terminal is uninterrupted.
- [ ] Ignore the toast until it fades, then open the bell: the
  `Worktree: <branch>` row under WORKTREES is clickable and switches to it.
- [ ] Create a worktree while a plain shell is the active tab, then click
  **Switch**: the tab moves to the new branch and `cd`s into the worktree.
- [ ] Repeat with a *running agent* as the active tab: the worktree opens in its
  own terminal and the agent's tab stays on its branch and CWD.

## Per-repo settings survive a restart (2026-08-30, frontend only — HMR, but needs an app restart to prove)

Every per-repo override was being dropped on save: the store sent camelCase keys
to a snake_case Rust struct that has `#[serde(default)]` on every field, so serde
discarded them without a word. Only `path` and `color` — the two names that spell
the same in both conventions — ever reached disk. Overrides looked correct until
the next launch.

- [ ] Settings → a repository → set a per-repo override (base branch, or the
  worktree "Prompt for branch name during creation" toggle). Confirm the new
  value in `repo-settings.json` under the app config dir is written with the
  snake_case key and the value you chose.
- [ ] Restart the app. The override is still set in the UI and still applies.
- [ ] A repo you never customised still shows "(Global Default)" — the fix must
  not turn absent overrides into explicit values.

## An agent quoting a menu footer stops flagging itself as awaiting (2026-08-30, **Rust change — needs `make dev` restart**)

Observed live on Boss's own `tuicommander/main` tab, twice in one turn: the agent
read another session's screen, pasted it into its answer, and the menu footer
came back out inside its own indented output. `parse_question` matched it,
emitted `Question { confident: true }`, and no clear path retracts a confident
question — the tab read "awaiting" while the agent worked, until Boss typed. The
anchor is now matched at column 0 of the rendered row instead of the trimmed
text. Covered by `pty::tests::quoted_ink_footer_in_agent_output_raises_no_question`
(fixture `claude-quoted-ink-footer.tcap`, verified RED without the fix), but a
live agent-frame check cannot be replayed.

- [ ] After restarting `make dev`, ask an agent in a throwaway session to print a
  captured menu screen — footer row included — inside a fenced code block. Its tab
  must stay "working": no `?` in the sidebar, `awaiting_input` false in
  `GET /sessions`.
- [ ] In the same session, open a real interactive menu (any agent prompt that
  draws the selection footer) and confirm the `?` still appears. The regression to
  fear is the opposite one: an over-tight anchor that silences real menus for
  agents whose frame indents them.

## Atomic MCP managed-agent submission (2026-08-27, **Rust change — needs `make dev` restart**)

The running backend cannot expose the new `session action=submit` schema or
handler until it is rebuilt. Validation belongs to the Luna delivery pass; this
manual item covers only the rebuilt live Codex integration.

- [ ] After restarting `make dev`, create a throwaway managed Codex session,
  wait for a confirmed idle composer, and issue one MCP
  `session action=submit session_id=<id> input=/clear` call. The same call must
  return either `status=acknowledged` with terminal-movement evidence or a
  precise non-retryable timeout; it must not require a `status`/`output` poll,
  leave `/clear` in the composer, or run it twice. Close only the throwaway
  session after observing the result.

## Native drag out of the file browser survives a missing icon (2026-08-25, **Rust change — needs `make dev` restart**)

`drag::Image` has no "no image" variant, so an unresolvable `icons/drag-file.png`
was `ImageNotFound` and killed the whole drag session — a cosmetic asset was
load-bearing. The icon is now compiled in (`include_bytes!`) and used whenever the
resolved path is not a real file.

- [ ] Drag a file from the file browser onto a terminal tab, onto the editor pane,
  and out to Finder. All three must start a real OS drag.
- [ ] Confirm `GET http://localhost:9876/logs` shows no `Native drag failed` /
  `drag image not found` warning afterwards.
- [ ] Drag a file onto another folder **inside** the tree — the internal move must
  still work (it never went through the icon path, so this is a no-regression check).

## Config saves stop being refused, and a broken wide char stops ghosting (2026-08-25, **Rust change — needs `make dev` restart**)

Three backend fixes from the 5-day regression review. All three are invisible until
the running binary is replaced.

- [ ] `save_checked` and its stamp guard are gone: every whole-document save
  (`save_activity`, `save_ui_prefs`, `save_notes`, …) is now plain last-writer-wins.
  Exercise the app normally for an hour and confirm `GET http://localhost:9876/logs`
  shows **no** `config write refused` / stamp-mismatch lines — before the fix these
  dropped ~30 activity items in 2.5h while protecting nothing.
- [ ] Print a fullwidth char and overwrite half of it (`printf '\e[1;5H中'` then
  `printf '\e[1;6HX'` in a terminal tab). The leading half must not survive as a
  ghost `中` beside the `X` — the damaged span now covers both cells of the pair.
  Scroll away and back to confirm it is not just hidden by a later full-row reship.
- [ ] Answer the FIRST sub-question of a multi-question `AskUserQuestion` on a
  non-hook agent (grok/codex) and confirm the tab's hover text shows the real
  question, not the `⊠ … ✓ Submit` footer row.

## "Capture Session" in the tab context menu (2026-08-22, **Rust change — needs `make dev` restart**)

New `get_pty_capture` / `set_pty_capture` commands plus a **Capture Session** item in the
terminal tab context menu, gated on `isPerfDebug()`. Until the restart the frontend item is
live but the commands are missing from the running binary, so it will just toast an error.

- [ ] Right-click a terminal tab → **Capture Session**, reproduce something, right-click →
  **Stop Capture Session**, and confirm the toast reports a plausible KB count and the path.
- [ ] Confirm the file appears in `~/Library/Application Support/com.tuic.commander/captures/`
  named after that session, and that starting a second time truncates rather than appends.
- [ ] Flip the tap with `curl` and confirm the menu label follows on the next right-click
  (the store re-reads on open — it must not trust the last value this window wrote).
- [ ] Confirm the item is absent in a release build until `window.__TUIC__.setPerfDebug(true)`.

## grok 1.0.x detected as an agent again (2026-08-22, **Rust change — needs `make dev` restart**)

grok 1.0.5 installs `~/.grok/bin/grok` as a symlink to `grok-1.0.5`; `proc_pidpath` resolves
the link, so the foreground process reads `grok-1.0.5`, `classify_agent` returned `None`, and
the session got no `agent_type`. With no ready-screen adapter the OSC 133 busy bit set once by
the long-lived `grok` command was never cleared, so the tab stayed working for the whole
process. Verified live before the fix: `GET /sessions/<id>/foreground` → `{"agent":null}` while
`GET /sessions/<id>/has-foreground` → `{"process":"grok-1.0.5"}`. `classify_agent` now falls
back to the basename with a trailing `-<digits…>` suffix removed.

- [ ] Run `grok --minimal`, wait for a turn to finish, and confirm the tab goes idle
  (dot stops pulsing) instead of staying busy for the whole process.
- [ ] Confirm `GET http://localhost:9876/sessions` reports `agent_type: "grok"` for that session.
- [ ] Confirm boxed (non-minimal) grok still goes idle, and that a `cursor-agent` session is
  still classified as `cursor` (the suffix strip must not eat a hyphenated tool name).

## Peer identity survives the 1h MCP reaper (2026-08-24, **Rust change — needs `make dev` restart**)

`last_activity` only moves on an MCP request, so an agent on a turn longer than an hour that
calls no TUIC tool had its protocol session reaped — and the reaper deleted the peer identity
with it, while the PTY was still running. Children's handoffs then failed with
`Recipient '<uuid>' is not registered`; for a headerless parent that is permanent, because
re-registering mints a fresh UUID. Observed live on 2026-08-24 in the veritas `Blocker audit`
session ("Il parent FastAF indicato non è più registrato"), with four
`MCP session reaped (idle ≥1h)` entries in the retained log window. The reaper now keeps an
identity that owns a live PTY or is still named as a live session's parent.

- [ ] Leave an agent on a long turn (>1h) with no TUIC tool call, then have a child `send` to
  it — the handoff must be accepted, not refused as unregistered.
- [ ] Check `GET http://localhost:9876/logs` for `kept addressable` after a reap, and confirm
  the retained ids still appear in `agent action=list_peers`.
- [ ] Confirm an identity with no PTY and no child still disappears after its hour (the
  retention must stay bounded) — `list_peers` should shrink over a long idle session.

## Agent sessions reach idle again (2026-08-23, **Rust change — needs `make dev` restart**)

`has_meaningful_descendant` called any descendant outside a three-name allowlist
(`mdkb | tuic-bridge | node_repl`) background work, and `background_work` outranks both
`completion_declared` and an idle shell in the agent-state ladder. Every agent has a daemon
outside that list — Codex 0.149.0 ships `codex-code-mode-host`, and an MCP server started via
`npm exec` reports as `npm`, a name that cannot be allowlisted without hiding real work.
Measured live before the fix: all 14 agent sessions reported `working`, including 11 with an
idle shell and no work on screen. A descendant that starts within 60s of its agent is now
plumbing regardless of name; simulating that rule over the same snapshot returned 11 sessions
to idle and kept the 3 genuinely busy ones working.

- [ ] Let a codex turn finish and confirm the tab goes idle instead of pulsing forever.
- [ ] Same for a claude session (the `npm exec @upstash/context7-mcp` case).
- [ ] Start a long command from an agent (`cargo build`), confirm the tab reads working while
  it runs and returns to idle when it exits — the window must not hide real work.
- [ ] Check `GET http://localhost:9876/sessions`: sessions with `shell_state: "idle"` must no
  longer report `agent_state: "working"` unless something real is running.
- [ ] Known residual (see the `DEFERRED (2026-08-23)` note at `started_with_agent`): a daemon
  that crashes and respawns mid-session escapes the window and pins that one session to
  working until it restarts. Note it if you see it; do not widen the window.

## Repository list restored after the version-skew wipe (2026-08-21, **Rust change — needs `make dev` restart**) — story `637-c311`

The live backend (started 08-20 16:23) predates the `mutationVersion 1` delta contract, so
the hot-reloaded frontend sent delta envelopes that the stale backend wrote to disk as the
whole `repositories.json`. The repo list went to `repos: []`. A replacement was rebuilt
from the pre-migration copy (`~/Library/Application Support/tuicommander/repositories.json`,
08-08, 35 repos) plus `ego` recovered out of the delta's own `after` payload and a minimal
`P42` entry: 37 repos, 3 groups, `repoOrder` complete, active repo `tuicommander`. Both
files live in the config dir as `repositories.restore-2026-08-21.json` and
`repositories.broken-2026-08-21.json`.

**Writing the restore while the app runs does not hold** — it was installed at 22:02 and
the stale backend had overwritten it with an envelope again by 22:03. The restore must go
in while the process is down:

```
# quit FastAF first, then:
cd ~/Library/Application\ Support/com.tuic.commander
cp repositories.restore-2026-08-21.json repositories.json
# then: make dev
```


- [ ] After the restart, confirm the sidebar lists all 37 repos with the 3 groups
  (`Progetti`, `IOS`, third) in their old order, and that `ego` still shows its 3 branches.
- [ ] Confirm repos added between 08-08 and today — other than `ego` and `P42`, which were
  recovered — are genuinely absent, and re-add by hand whatever is missing. That gap is not
  recoverable from any file on disk.
- [ ] Add, rename, group and remove a repo, then confirm `repositories.json` still holds
  the plain `repos`/`repoOrder` shape and **never** an `{id, before, after}` envelope.
- [ ] Confirm `P42` (rebuilt by hand, not from a backup) shows the right branch, display
  name and terminals once opened.

## Repository mutation persistence under the lock (2026-08-21, **Rust change — needs `make dev` restart**) — was story `642-eabd`

The delta-under-lock implementation in `config.rs` / `mcp_http/config_routes.rs` cannot be
exercised until the backend is rebuilt. Post-restart checks only, so it lives here and not
in a story.

- [ ] Confirm the restarted backend accepts a `mutationVersion 1` repository delta over
  both the IPC and the HTTP surfaces.
- [ ] Confirm a stale same-repository mutation is reported as a visible conflict and does
  not overwrite the newer value.

## UTF-16-safe content search offsets (2026-08-21, **Rust change — needs `make dev` restart**) — was story `643-26ac`

`fs.rs` now returns UTF-16 offsets for content-search matches, and
`FileBrowserPanel.tsx` highlights with them. Post-restart checks only.

- [ ] Confirm desktop content-search batches highlight the match after an em dash, an
  accented character and an emoji.
- [ ] Confirm the HTTP content-search response returns the same UTF-16 offsets and that
  ASCII highlighting is unchanged.

## MCP bridge writes into third-party configs (2026-08-21, **Rust change — needs `make dev` restart**) — issue #115

JSON MCP configs are now edited member-by-member through a syntax tree instead of being
reserialized, Zed/Amp/Gemini wait for an explicit install, and Settings → Agents gained
**Remove all MCP integrations**. The unit tests cover the splice, the refusals and the
gate; what they cannot cover is a real client reading the file afterwards.

- [ ] **[MANUAL]** Put a comment, a trailing comma and hand-tuned indentation in a real `~/.config/zed/settings.json`, install the bridge from Settings → Agents, then confirm Zed still starts, still shows every setting, and lists the `tuicommander` context server. `diff` the file against `<config dir>/mcp-backups/zed-settings.json.orig` — the only change must be the added member.
- [ ] **[MANUAL]** Launch FastAF with Zed installed but no bridge entry, and confirm `~/.config/zed/settings.json` is **not** touched (mtime unchanged) and the panel reads "Not installed automatically".
- [ ] **[MANUAL]** Press **Remove all MCP integrations**, then confirm every listed client's config lost only the `tuicommander` entry and that a relaunch does not put them back.

## Render cadence of AI answers and the phone terminal (2026-08-17, frontend only) — story `603-c28f`

F10/F130/F136/F137 from the performance audit. The chat panel renders the live answer on
its own 200 ms cadence instead of once per token batch, and the mobile terminal reuses the
elements of screen rows that did not change. Vite reloads this without a restart.

- [ ] **[MANUAL]** Open a session on a phone or at `:9877` in a narrow browser window, run something with a busy full-screen redraw (`htop`, a TUI agent), and confirm the output stays smooth and the search filter reacts instantly while output flows.

## OSC 133 and OSC 7 cwd in browser mode (2026-08-18, **Rust change — needs `make dev` restart**) — story `623-d369`

Both markers reached the desktop `AppHandle` only, so a browser/PWA client had no command
blocks, no gutter marks, no Cmd+Up/Down navigation and a cwd frozen at session start. They
are dual-emitted now and carried on the `?format=grid` WS the canvas already holds. Nothing
below works against the currently running binary.

- [ ] **After a `make dev` restart**: confirm desktop still works unchanged — the desktop emit was kept, not replaced.
- [ ] **[HUMAN]** Compare the gutter marks side by side, browser vs desktop, on the same session. Canvas painting is not observable over HTTP, so only a visual check proves the marks land on the same rows.

> **Why the browser-mode block checks above are still open (2026-08-20).** An
> automated browser can drive the UI, but macOS/Chrome suspends
> `requestAnimationFrame` while the window is occluded — `visibilityState` still
> reads `visible` and `hasFocus()` still reads `true`, so nothing announces it.
> Command blocks flush through `_scheduleOsc133Flush` (rAF, `terminals.ts:226`)
> and the editor's jump-to-line runs inside a rAF (`CodeEditorTab.tsx:274`), so
> both silently do nothing. Any "it did not render" conclusion from an occluded
> automated window is worthless — raise the window first, then judge.

## Desktop PTY activity pulse (2026-08-17, **Rust change — needs `make dev` restart**) — story `625-56b0`

`cda39f31` deleted the `pty-output` emit and left the listener, so desktop lost every
activity signal for a commit. A payload-free `pty-activity-{id}` pulse replaces it,
throttled to ~1/s and dual-emitted so browser and desktop read the same signal.
Nothing below works against the currently running binary.

- [ ] **After a `make dev` restart**: open the Activity Dashboard, run `for i in $(seq 1 20); do echo $i; sleep 1; done` in a terminal, and confirm the `lastDataAt` column keeps advancing while it runs — it froze completely before. _(2026-08-20, signal proven at the source: with that exact loop running in a throwaway session, `GET /events` carried **exactly 10 `pty-activity` frames for that session id in 10 s** — continuous during the command, at the ~1/s throttle. The `lastDataAt` column is a render of this signal; the column itself was not read because the Activity Dashboard has no reachable trigger in browser mode)_
- [ ] **After a `make dev` restart**: with tab A focused, start long output in background tab B and confirm B raises its unread-activity dot *while output is still flowing*, not only when the command completes. This is the case grid frames cannot report, since the canvas stops acking them while hidden.
- [ ] **After a `make dev` restart**: open the same session in browser mode (`:9877`) and desktop side by side; both must light up their activity indicator on the same output, since both now read one backend signal. _(2026-08-20: the shared signal is proven — `pty-activity` rides `/events` for browser clients (`sse_routes.rs:258`) alongside the desktop `pty-activity-{id}` emit (`pty.rs:369`), and the SSE frames were observed live. What is left is the two indicators lighting up side by side, which needs both UIs visible)_

## Duplicate and orphan event listeners (2026-08-17, **Rust change — needs `make dev` restart**) — story `600-d664`

F4/F5/F7/F11/F17 from the performance audit. Only `CanvasTerminal` listens for OSC 133 now;
content-search batches and errors carry a `search_id`; the dead `pty-vt-log-total` emit is gone;
the AI chat panel no longer subscribes to the producerless chat registry; improvement-scan
proposals are published only by the `proposals-ready` event.

- [ ] **Residual after the browser Command Palette defect is fixed**: run concurrent File Browser and command-palette searches in separate windows and confirm search-id isolation, spinner completion, and detached-window isolation. HTTP content-search transport and independent request surfaces are verified.
- [ ] **After a `make dev` restart**: detach the File Browser into its own window and search in both it and the main window. The two ids are minted at random per search now, not from a per-realm counter that both windows would start at 1, so neither window may see the other's matches.
- [ ] **After a `make dev` restart** — the OSC 133 subscription moved ahead of the canvas font load, so the very first prompt marker of a session is no longer racing it: open a brand-new shell tab and confirm the first command already has a block (the first prompt used to be the one at risk of being dropped once the second listener was gone). _(2026-08-20, attempted, inconclusive — **not a failure, an isolation problem.** Created a fresh session, confirmed its shell emits OSC 133 (4 `133;` markers in the raw output for the first command) and that `pty-cwd` resolved its cwd to `/private/tmp`. But the browser client logged no `[OSC133] … flushed N blocks` line (`terminals.ts:251-254`, `appLogger.debug`, which does reach the browser console) for the new session **or** for an established one during the same window — the flush only runs for a session whose `CanvasTerminal` is mounted (`CanvasTerminal.tsx:2068-2076`), and I could not get the new tab mounted: clicking its tab element did not move the active terminal, and no active-tab signal is exposed on `window.__TUIC__`. Earlier in this same sweep the same browser client did log per-command flushes and painted 13 marks for 13 commands, so the subscription works in general; what stayed untested is specifically the **first** command of a **fresh** tab. Needs a way to activate a tab from automation, or a human click)_
- [ ] **After a `make dev` restart**: open a saved conversation from the AI chat history and confirm its messages stay on screen (they used to blank a moment after loading). _(2026-08-20: **not reachable from a browser — see defect 6 below.** `conversationStore.listAllConversations` returns `[]` behind `if (!isTauri())` (`conversationStore.ts:996`), so the history view opens empty however many conversations exist; `loadConversation` (`:1007`) bails the same way. Confirmed live: the panel's history button leaves the panel text unchanged at 182 chars with no list and no error, while `curl localhost:9876/ai/chat/conversations` returns 200 with real saved conversations. Needs the desktop app, or defect 6 fixed)_
- [ ] **After a `make dev` restart**: run an improvement scan and confirm the proposals appear exactly once, and appear in a second window too.

## Content index freshness after a timestamp-preserving restore (2026-08-17, **Rust change — needs `make dev` restart**)

`ContentIndex::is_current` compared modification times only, so a restore that preserves them left
the index reporting itself current with stale content. The stat fingerprint is now mtime **and**
size, both already read by the same walk.

- [ ] **Confirmed runtime residual**: after warming a content index and waiting past its rebuild cooldown, `cp -p` a different-sized file over an indexed one must rebuild the live index and make the replacement phrase searchable. The disposable runtime probe returned neither unique phrase and logged no rebuild; the preserved-mtime unit test passes.

## Dictation truncation and model-snapshot staleness (2026-08-17, **Rust change — needs `make dev` restart**)

The 300 s recording cap now reports what it dropped: `streaming_loop` counts the trimmed samples,
`stop()` returns them, and `TranscribeResponse.truncated_s` carries them to `useDictation`, which
says so instead of `Ready`. The model snapshot behind the 75 ms microphone meter expires after a
second so a change made by the other build is noticed.

- [ ] **After a `make dev` restart**: dictate normally and confirm the status still returns to `Ready`, then change the dictation model in a second window (or delete the model file) and confirm Settings > Dictation reflects it within about a second without a restart.

## Resumed session knowledge (2026-08-17, **Rust change — needs `make dev` restart**)

The startup load of session knowledge is capped at the 40 newest files, so a resumed older session
had no record in memory. Recording an outcome for it started a blank one, and the next flush wrote
that blank over the file. Both writers now read the file first.

- [ ] **After a `make dev` restart**: with more than 40 session-knowledge files present, reopen a session older than the newest 40, run a command in it, and confirm its earlier history survives in `<config dir>/ai-sessions/<id>.json`.

## Wave-1 perf runtime re-measure (2026-08-17, **Rust change — needs `make dev` restart**) — story `620-3281`

The unit tests cannot measure what these changes were made for. **Baseline, captured before the
`605-f104` fix:** the last 4000 log lines of the running instance held **360** `Emit repo-changed
(working-tree)` against **3** `(git-state)`. That ratio is what F40/F41/F42 has to move.

- [ ] **After a `make dev` restart**: sidebar diff badges and branch stats still update while an agent writes in a worktree — the emit reduction must not cost responsiveness.
- [ ] **After a `make dev` restart**: Build Cleaner and the File Browser still behave after the `plugin_fs.rs` changes, and the app boots with no new warnings in `GET http://localhost:9876/logs`.

## MCP stdio backlog and SSE stream ownership (2026-08-17, **Rust change — needs `make dev` restart**)

The stdio upstream reader now uses a bounded, drop-oldest queue (256 lines / 8 MiB, 16 MiB per
line) instead of an unbounded channel, and one RPC waits on a single deadline instead of a
64-message budget. A `GET /mcp` SSE stream takes a process-wide generation on its session and its
teardown releases the session only while it still holds it.

- [ ] **After a `make dev` restart**: with a real stdio upstream configured (mdkb, context7), connect it, call one of its tools with a large argument, and confirm the tool list and the call still work — the request now crosses a writer thread instead of going straight down the pipe. Then restart the bridge/agent so its `GET /mcp` reconnects, and confirm `notifications/tools/list_changed` still reaches the agent afterwards. Finally close the agent (`DELETE /mcp`) and reconnect it, and confirm notifications still arrive.

## Working-tree read freshness and artifact trim accounting (2026-08-17, **Rust change — needs `make dev` restart**)

`get_working_tree_status` single-flight is now keyed by repository **plus** a generation counter that
every mutating git command bumps, so a coalesced read can no longer answer with a snapshot taken
before the mutation. A forced artifact rescan no longer joins a scan that started earlier, and
`trim_build_artifact` measures each target before removing it and returns the reclaimed bytes.

- [ ] **After a `make dev` restart**: stage a file in the Git panel and confirm the Changes list updates on the first refresh. Then open the Build Cleaner, trim a `target/` directory and confirm the reported size drops by what was removed, not by the old estimate.

## Repo watcher ignore rules (2026-08-17, **Rust change — needs `make dev` restart**)

`build` and `out` no longer count as build-output directory names; `.gitignore` decides, parents
included. `.git/info/exclude` and the root `.gitignore` are separate layers in git's own
precedence, and editing `info/exclude` now rebuilds the matcher.

- [ ] **After a `make dev` restart**: in a repo with a tracked `build/` or `out/` directory, edit a file there and confirm the git panel and file browser refresh. Then run a full `cargo build` and confirm the panels stay quiet — `target/` is still pruned.

## Rust-side plugin OutputWatcher matching (2026-08-17, **Rust change — needs `make dev` restart**) — story `599-6e94`

The `pty-output` throttle dropped every chunk inside its 100 ms window, which corrupted the plugin
OutputWatcher line reassembly in the WebView. Rust is now the only line assembler: the reader thread
reassembles, cleans and matches the lines, and pushes `pty-watcher-lines-{session}` batches (100 ms
window, ordered, and lossless through the batcher — delivery itself stays live-only, like every
other event on this bus). The raw `pty-output` event, its coalescer and the frontend `LineBuffer`
are gone. Watcher sets are per frontend, so a browser tab and the desktop window no longer overwrite
each other, and browser clients receive watcher matches for the first time.

- [ ] **After a `make dev` restart**: `claude-wakeup` still fires on a real `/done` line, and `at-capacity-retry` still fires on a real capacity line — both now matched in Rust. _(2026-08-20: **`claude-wakeup` is not installed** — `/plugins/list` returns `rtk-dashboard`, `wiz-kanban`, `csv-preview`, `build-cleaner`, `mdkb-dashboard`, `tuic-vscode-icons`, `at-capacity-retry`. So half this item has nothing to fire; its watcher (`plugins/claude-wakeup/main.js:385-397`, pattern `/done/i`) is also gated on a recent wake having been sent, so it would not fire on a bare `/done` line anyway. `at-capacity-retry` is installed but loads only on the desktop client, which `agent-browser` cannot reach)_
- [ ] **After a `make dev` restart**: a rare line printed once, with the PTY then completely quiet, still reaches a watcher within ~100 ms (the ticker drains the tail; it no longer waits for more output). _(2026-08-20, attempted and blocked — **no OutputWatcher exists on a browser client to receive the line.** Probe: held `/events` open, echoed a line containing `done` into a quiet throwaway session, and got 18 `pty-activity`, 29 `pty-parsed`, 3 `pty-osc133` and 1 `pty-cwd` in 10 s but **zero** `plugin-watcher-lines`. That is correct behaviour, not a transport failure: `emit_watcher_lines` (`pty.rs:406-412`) returns early when no line matched a registered watcher, and the SSE bridge itself is present (`sse_routes.rs:261,346`). See the item below for why nothing is registered)_
- [ ] **After a `make dev` restart**: open the web UI alongside the desktop app and confirm a watcher fires in the browser tab, and that neither client blinds the other. _(2026-08-20: **a browser client registers no OutputWatcher at all**, so this is not reachable through the UI. `window.__TUIC__.plugins()` on the live browser client returned exactly two loaded plugins — `plan` and `stories-ticker` — and neither registers one; outside the host itself (`pluginRegistry.ts:293`) and the type declaration, no `registerOutputWatcher` call exists anywhere in `src/`. The watchers this section is about ship as **user** plugins, which do not load in browser mode: `/plugins/list` reports 7 installed (`rtk-dashboard`, `wiz-kanban`, `csv-preview`, `build-cleaner`, `mdkb-dashboard`, `tuic-vscode-icons`, `at-capacity-retry`) and none of them appeared in the browser client. Testing this needs a user plugin loading in web mode)_
- [ ] **After a `make dev` restart**: reload the browser tab ten times (each reload leaves a client id behind, and the bound is 8), then confirm a watcher still fires in the desktop window within 30 s — the heartbeat has to re-install the set eviction dropped. _(2026-08-20: the reload half is drivable from a browser, but the assertion is about the **desktop** window firing a watcher, and `agent-browser` cannot reach the Tauri webview. Also blocked upstream by the two items above — the browser client registers no watcher set, so ten reloads leave no watcher-set client ids to evict)_

## Terminal copy gutter normalization (2026-08-17, **Rust change — needs `make dev` restart**) — story `622-6c69`

Terminal selection extraction now removes Claude's repeated `NBSP NBSP ▎` visual
gutter only from coherent multi-line runs. It continues to join soft-wrapped rows
and preserves literal block characters, indentation, bullets, numbering, emoji
shortcodes, and non-breaking spaces inside the message.

- [ ] **After a `make dev` restart**: copy the original long Claude message and paste it into Slack; no `▎` gutter or gutter NBSPs remain, while lists, blank lines, indentation, `:wave:`, `:pray:`, and the body spacing in `QA  Engineering` are unchanged. _(2026-08-21 reattempt: the fixture was staged successfully in throwaway session `audit-luna-20260821-copy` and rendered in the persistent browser; trusted `mouse move/down/up` drag plus `Cmd+C` completed, but `agent-browser clipboard read` again hung with `Resource temporarily unavailable (os error 35)`, and `pbpaste` still contained unrelated pre-existing clipboard text. The paste payload therefore remains unproven; needs a human drag/clipboard target or a backend endpoint returning current selection text)_
- [ ] **After a `make dev` restart**: copy a lone `▎` and an ASCII-indented `  ▎` code/table line; both paste unchanged. _(2026-08-21 reattempt: the lone-bar and indented-bar fixture rows were rendered in throwaway session `audit-luna-20260821-copy`; trusted drag/Cmd+C reached the canvas, but clipboard read remained unavailable (`Resource temporarily unavailable`, with unrelated `pbpaste` content), so unchanged paste is still unproven)_

## Build Cleaner: Trim vs Clean (2026-08-16, **Rust change — needs `make dev` restart**) — story `598-e7fe`

Artifact rows gained a second action. **Trim** removes only regenerable intermediates
(Rust `<profile>/{deps,build,incremental,.fingerprint}`, Swift `index-build` + `ModuleCache`/`index`/`*.build`,
Maven `classes`/`generated-*`/`*-reports`, Gradle `classes`/`tmp`/`intermediates`/…) and leaves the built
executables on disk; **Clean** is the old full `remove_dir_all`. Measured on 5 real Rust repos:
113.9 GB of `target/`, 112.9 GB trimmable (98.2–99.8%), 1.04 GB of actual output.

- [ ] **After a `make dev` restart**: click **Trim** on the real `src-tauri/target` in the dashboard — not done on purpose, the row is 58 GiB and a Trim forces a full rebuild of the running dev app. Boss's call.
- [ ] **After a `make dev` restart**: a running `cargo build` in another window is not broken by a Trim of a *different* repo's `target` (the hot-window badge should mark the active one "recent").
- [ ] Visual: the two-tier button styling reads correctly in light and dark themes — `.safe` on accent, `.danger` on error — and the armed states ("Trim?" vs "Delete all?") are distinguishable at a glance.
- [ ] Cross-platform: on Windows and Linux, confirm a Trim of a Rust `target/` reclaims the same four dirs and leaves `*.exe`/the binary in place. The pattern matcher is separator-agnostic by construction and clippy compiles on Windows CI, but **Windows CI does not run the Rust tests** (`if: matrix.platform != 'windows-latest'`), so this is unverified at runtime.

## Authoritative agent state (2026-08-12, **Rust change — needs `make dev` restart**) — story `592-acde`

Question/choice lifecycle, causal capture replay, non-blocking MCP UI confirmation, lossless
session-state reducer, OSC 777 batching, shell-starting semantics, tall-HUD chrome cutoff, and
strengthened MCP `intent:` instructions. All Rust-backed, so none of it is live until a restart.

- [ ] **After a `make dev` restart**: a stale historical question does not re-arm after submitting a later turn.
- [ ] **After a `make dev` restart**: a bare Enter clears an active question or choice, on desktop *and* over HTTP/PWA input.
- [ ] **After a `make dev` restart**: leaving an MCP `ui action=confirm` dialog unanswered does not block requests from other agents.
- [ ] **After a `make dev` restart**: a non-empty Codex composer above a status HUD taller than 15 rows does not leak HUD text into question parsing.
- [ ] **After a `make dev` restart**: a newly spawned detected agent reports `starting` until real busy or idle evidence arrives.
- [ ] **After a `make dev` restart**: a newly initialized MCP agent emits `intent:` at task start and on material phase changes.

## Prompt-derived descriptions for orchestrated PTYs (2026-08-12, **Rust change — needs `make dev` restart**) — story `597-e4dc`

Codex collaboration exposes `task_name`/`message` but no `pty_description`; the backend now derives
display-only metadata from the original spawn prompt.

- [ ] **After a `make dev` restart**: a Codex collaboration subagent shows its task description above the terminal.

## Agent worktree creation prompt (2026-08-05)

- [ ] Create a worktree through MCP while an agent terminal is active, then choose **Open Worktree**: the worktree's terminal must open while the agent terminal remains attached to its original branch and working directory, with no injected stop/switch message.

## Perf pass + light-theme fix — visual checks (2026-06-09)
### 022-dc94 — Scrollbar track-height cache
- [ ] Smooth-scroll gesture: scrollbar thumb position/size stays visually correct (no jump/drift) _(controller logic covered by `src/components/Terminal/__tests__/canvasTerminalScroll.test.ts` — 4/4 passed on 2026-08-05; the scrollbar thumb still needs visual validation)_

### 027-deb3 — rowCache lagging-frame guard
- [ ] Fast scroll gesture: no flicker or wrong overscan content _(cache-generation and lagging-frame controller coverage is in `src/components/Terminal/__tests__/canvasTerminalScroll.test.ts` — 4/4 passed on 2026-08-05; flicker/overscan rendering still needs visual validation)_

## #79 — vim & repeating key (macOS press-and-hold) (2026-06-06)
- [ ] [HUMAN] In a release `.app`, open vim and hold `j`/`l`/`i` → cursor repeats, NO accent picker popup _(needs release build: dev build lacks proper bundle domain; fix registers `ApplePressAndHoldEnabled=NO` in `press_and_hold.rs`, called from `lib.rs` setup)_
- [ ] [HUMAN] Typing accented chars still works where intended (Option-key composition path unaffected — only the hold-for-accent picker is suppressed)
- [ ] [HUMAN] A user with explicit global `defaults write -g ApplePressAndHoldEnabled -bool true` still sees their override (registration domain is lowest priority)

## Content Index Strategy (2026-05-24)
- [ ] Set "Active repo only": switch repos → content search only works for the repo that was active at boot _(NOTE: boot pre-warm selects only the persisted active repo (`lib.rs:1419-1442`), but `content_index.rs:438-440` rebuilds any repo receiving `RepoChanged` whenever the strategy is not `disabled`; the claimed post-switch exclusivity is therefore not proven and may not match current behavior.)_
- [ ] "Active + on switch": warm_content_index fires on repo switch (check logs for index build for the new repo) _(NOTE: current source registers `warm_content_index` as an IPC/HTTP command (`fs.rs:472-477`, `mcp_http/fs_routes.rs:274`) but has no frontend caller on repository switch; the repo-change updater rebuilds enabled indices asynchronously via `content_index.rs:438-440`. This specific `warm_content_index` event contract is not proven and may be a story-worthy documentation/implementation mismatch.)_

## AI Chat (Level 1)
- [ ] Ollama selected + running: ~~model list populated from `/api/tags`~~ **residual:** render the required green availability dot. _(Browser runtime populated the local model list; no green dot was rendered.)_
- [ ] Ollama selected + not running: red dot with "Not detected" message _(NOTE: `detect_ollama` returns `{available:false, models:[]}`, but `ProvidersTab.tsx` does not render a red dot or `Not detected` message.)_
- [ ] Context lines slider: 50-500, persists across restart _(NOTE: no context_lines slider exists in the codebase. AI Chat tab only has temperature slider and scheduled tasks. Feature not implemented.)_
- [ ] Status bar: ~~chat bubble icon toggles the AI Chat panel~~ **residual:** decide and visually validate an active highlight for status-bar panel toggles. _(Toggle behavior was verified live; no active-highlight class exists and applying it consistently needs a style decision.)_

## AI Chat — Detachable Panel (1388-9bda)
- [ ] Detached window receives streaming chunks from active conversation _(NOTE: `AIChatPanel.tsx:39-42` explicitly documents that detached-window stores are separate and streaming/controls are not fully synchronized; generic panel projection sync is not registered for the AI Chat adapter in `App.tsx:124-132`.)_
- [ ] Closing detached window emits `ai-chat-window-closed` event _(NOTE: the generic bridge listens for `panel-window-closed`, but no AI-specific `ai-chat-window-closed` emission was found; current contract is `panel-window-closed` in `useDetachedPanelBridge.ts:12-16`.)_
- [ ] Send message from main window → stream visible in detached window _(NOTE: detached AI Chat has separate stores and the adapter has no `serialize`/`syncIntervalMs` projection; source comment at `AIChatPanel.tsx:39-42` identifies this as unresolved.)_
- [ ] Close detached window mid-stream → main panel resumes with partial text _(NOTE: no cross-window AI conversation projection is registered; the generic panel close bridge restores UI state but does not transfer streaming text.)_
- [ ] Switch terminals in main window while detached → subscription updates chatId _(NOTE: the AI Chat adapter passes the initial `chatId` only; no AI-specific panel-action handler or projection sync was found in `App.tsx:124-132`.)_

## AI Agent — Level 2 Loop (1299/1300/1301/1302)
- [ ] Rejoining session after reload: ~~chat message text reloads from the conversation store~~ **residual:** persist and recover tool-call history, `agentState`, and `currentIteration`; the conversation store is schema v1, while schema v2 belongs to session knowledge.

## Smart Prompts Drawer (Cmd+Shift+K)
- [ ] Auto-execute ON → prompt sends Enter automatically after injection _(2026-08-20: **the flag is unreachable for any prompt a user can create — see defect 4 below.** Only `useSmartPrompts.executeInject` reads it (`useSmartPrompts.ts:240`) and only when `injectTarget === "terminal"`; the drawer's own `doInject` (`PromptDrawer.tsx:158-177`) never reads it at all. Live half of the test: created a temp prompt, made a throwaway shell session active, opened the toolbar dropdown — the row rendered `itemDisabled` with title "No agent detected in terminal", 14 of 15 rows likewise. Finishing this needs an agent session, and the only agent sessions running are Boss's live ones, which must not be injected into. The temp prompt was deleted; the library is back to its original 31 entries)_
- [ ] Auto-execute OFF → prompt text pasted without Enter, user can edit before sending _(2026-08-20: same blocker as the item above. The OFF branch is `pty.write` without Enter at `useSmartPrompts.ts:247-248`, and is also what a `compose` target falls back to when no compose panel exists)_

## Plan Panel (515-660c / 516-41a5 / 517-74c2)
> **OBSOLETE (panel removed 2026-04-02, commit `123f7a2c` "refactor(plan): remove HTML panel"; sidebar panel also dropped, `1634e0b1`; stale doc refs cleaned in `331bd649`).** The plan feature is now plugin-only (`planPlugin.ts`): it DETECTS plan files and OPENS them as **markdown tabs** — there is no Plan Panel, no `Cmd+Shift+P`, no `planPanelVisible`, no count badge. Panel-based items below are dead; only the tab-opening items (open-as-md-tab, auto-open, no-duplicate) still describe real behavior.
- [ ] Switching repos rescans plans for the new active repo (no panel — affects which plans auto-open as tabs) _(NOTE: `planPlugin.ts:103-106` scans only during plugin load, and exported `scanPlans()` at `:264-266` has no caller elsewhere in `src`; an active-repo switch rescan is not currently demonstrated)_

## Voice Dictation (Stories 117-123)
### Model Management
- [ ] Model status shows "Ready" after download completes _(NOTE: `DictationSettings.tsx:29-35` renders `Downloaded`/`Active`; no `Ready` status is currently implemented.)_

## Smart Prompts API Mode
- [ ] Select provider (OpenAI/Anthropic/etc.) → model placeholder updates _(browser verified: the Add Model form keeps the static placeholder `e.g. claude-sonnet-4-5-20241022`; current `ProvidersTab.tsx` has no dynamic provider-specific placeholder.)_
- [ ] No API key configured → canExecute returns error with Settings link _(NOTE: `useSmartPrompts.ts:109-125` returns the plain reason `Headless provider not configured — add a provider and assign the Headless slot in Settings → Providers`; no clickable Settings link is produced.)_
- [ ] PWA/browser → API mode shows "requires desktop app" message _(NOTE: browser transport maps `execute_api_prompt` through HTTP, and no `requires desktop app` guard/message exists in the API execution path.)_
- [ ] [HUMAN] Wrong API key → toast shows "Authentication failed" with Settings hint _(2026-08-21 Luna audit: code and `error_mapping_auth_keyword` verify the 401 mapping at `src-tauri/src/llm_api.rs:141-143,231-236`, and `src/utils/promptContext.ts:109-115` routes a failed result to a toast. The safe HTTP probe of `/prompt/execute-api` returned 400 for missing content; no bad-key request was sent because it could use live credentials/external API. The rendered toast and Settings hint remain unverified.)_

## ChoicePrompt (story 1296-ce3e)
- [ ] Agent resumes work (status-line emits) → `choice_prompt` cleared, overlay disappears _(NOTE: current test `test_session_state_status_line_keeps_choice_prompt` explicitly preserves the prompt during status-line repaint; the checklist expectation does not match current behavior.)_
- [ ] Codex numbered-choice dialog (if/when encountered) captured by parser — add fixture if not _(NOTE: `output_parser.rs:93-95,1754-1782` documents and implements the shared numbered-choice shape for Codex, but no Codex screen capture/fixture exists in the current corpus; do not invent one.)_
- [ ] Aider confirmation dialog — add fixture if layout differs _(NOTE: the parser documents the same cross-agent layout, but no Aider capture/fixture exists in the current corpus; a live Aider prompt is required before adding evidence.)_

## Command Block System (2026-05-20)
- [ ] [HUMAN] Cmd+F with block-scoped toggle ON → only matches within current block shown _(filter logic and targeted tests pass; residual is a trusted browser SearchBar/CodeMirror interaction on a mounted editor.)_
- [ ] Settings > Terminal > Blocks → toggle timestamps and folding on/off _(NOTE: the current settings state persists `show_block_timestamps` and `block_folding_enabled`, but no matching Settings-panel controls were found; the only current controls are the runtime modifier/shortcut paths in `CanvasTerminal.tsx:2106-2110,2165-2183`.)_
- [ ] [HUMAN] Run 500+ commands → ~~no crash~~ **residual:** prove frontend oldest-block eviction, bounded count, and no memory growth. _(HTTP generated 510 OSC 133 blocks and the browser rendered output through `cmd-510` without a crash; store tests pass.)_
- [ ] [HUMAN] Claude Code session: tool calls show as blocks without OSC 7770 (heuristic detection) _(2026-08-21 Luna audit: the targeted Rust parser tests passed; detection is implemented at `src-tauri/src/pty.rs:3341-3368,4993-5012`. HTTP rendered a Claude-like `⏺ Read(foo.txt)` screen in `luna-legacy-20260821-heuristic`, but its proven `agent_type` was `null` (plain shell), not Claude, and no live agent session was used.)_

## Process Monitor
- [ ] Panel: changing refresh interval to Manual stops auto-polling _(NOTE: live `/process/monitor` HTML has no refresh-interval selector or Manual mode; it only auto-refreshes on the fixed 3-second timer.)_
- [ ] Panel: Refresh button triggers immediate data fetch _(NOTE: live `/process/monitor` HTML has no Refresh button; only the fixed timer is implemented.)_

## Search/UI consistency: unified SearchBar + scrollbar overview + file-browser tracking (2026-06-11)
- [ ] [VISUAL] Live (needs rebuild): open Cmd+F in the code editor → compact SearchBar pill (counter inside input); typing shows orange full-width ticks covering the scrollbar and hides the green git ticks; closing search brings the git overview back. Replace row expands via the chevron. _(2026-08-21 Luna audit: `SearchBar.test.tsx`, `editorSearchEngine.test.ts`, and `searchOverview.ts:59-128` passed/inspected; the active throwaway browser panel had no CodeMirror or SearchBar, so no trusted editor interaction was attempted.)_
- [ ] [VISUAL] Live (needs rebuild): open a brand-new (untracked) file → the git-change overview shows a SINGLE tick at the top, not a solid green bar. _(2026-08-21 Luna audit: `gitGutterRuns.test.ts` passed and `src/components/CodeEditorPanel/gitGutter.ts:48-71` collapses contiguous additions; creating an untracked file or mutating the dirty worktree was out of scope, and no editor panel was active.)_
- [ ] [VISUAL] Live (needs rebuild): search inside a diff tab → orange match ticks appear on the diff scrollbar and track scroll. _(2026-08-21 Luna audit: shared SearchBar/search-overview code and targeted SearchBar/editor tests passed; no diff editor was active in the browser DOM, so trusted query/scroll observation was skipped.)_
- [ ] [VISUAL] Live (needs rebuild): editor scrollbar visually matches the terminal's (14px track, rounded inset thumb). _(2026-08-21 Luna audit: source inspection confirms the shared scrollbar rule in `src/components/CodeEditorPanel/theme.ts:22-23` and 14px search ruler in `searchOverview.ts:103-123`; no editor canvas was active for a visual comparison.)_
- [ ] [VISUAL] Live (needs rebuild): open a file deep in a subtree → the file browser (tree view) auto-expands its parents and scrolls it into view, highlighted with the accent bar. Switching the active editor tab moves the highlight. _(2026-08-21 Luna audit: `src/components/FileBrowserPanel/FileBrowserPanel.tsx:260-289` implements ancestor expansion/scroll and targeted FileBrowser tests passed; the browser had no safe throwaway repo/editor target, so no click was made.)_
- [ ] [VISUAL] Live (needs rebuild, story 443-ea2b): install/enable the `docx-preview` plugin, open a `.docx` from File Browser, and confirm it opens the Mammoth HTML preview panel with conversion notes/raw-text toggle; Edit opens the same file in CodeMirror. Requires backend restart because `host.readFileBase64()` is Rust-backed. _(2026-08-21 Luna audit: `plugins/docx-preview/main.js:8-64` and plugin-host tests were inspected; `GET /plugins/list` did not list `docx-preview`, and installing/opening a DOCX would require config/repo mutation plus the Rust restart explicitly called out here.)_
- [ ] DEFERRED (story 041-cd15): HTML Preview search → shared SearchBar (in-iframe search needs a postMessage bridge); shared sidebar-filter component for Error Log / Knowledge History / Branch Switcher etc. ("consistency of a different kind" for narrow sidebars).
- [ ] [VISUAL] Live (story 040-29e1): open a tracked file in the code editor → a dim italic annotation "Author · relative time · summary" appears at the end of the active line and follows the cursor (no flicker, no fetch per keystroke). Edit a line → it shows "You · Uncommitted changes". Toggle `settingsStore.setInlineBlameEnabled(false)` → annotation disappears. External (absolute-path) files show no annotation. _(2026-08-21 Luna audit: `inlineBlame.test.ts` passed and `CodeEditorTab.tsx:453-488` confirms reactive enable/fetch behavior; no tracked editor was activated, and editing the dirty worktree was intentionally skipped.)_

### Legacy-tag Luna pass — 2026-08-21

All 11 raw legacy-tag lines in this section were audited through code inspection, targeted tests, safe HTTP probes, and a new stealth browser session. None is complete: visual/editor behavior was not observable on the active throwaway terminal canvas, and no live session received input. The macOS capture ladder step was attempted read-only but showed an existing live session, so further macOS interaction was skipped. Throwaway IDs `luna-legacy-20260821-blocks` and `luna-legacy-20260821-heuristic` were the only sessions written, and cleanup was completed after this pass.

## Markdown preview: inline comments anchor + highlight correctly (2026-07-15)

- [ ] [VISUAL] Commenting a word that repeats many times in the doc (e.g. "reason" ×18) highlights the ACTUAL selected occurrence, not the first one. _(root cause: `findSourceMatch` used first-occurrence `indexOf`; fixed with DOM occurrence-ordinal → Nth source occurrence. Logic verified in `tweakComments.test.ts` incl. real-file offsets; visual anchor position needs an eye.)_
- [ ] [VISUAL] Selecting text overlapping an existing highlight hides the "Add comment" button; keyboard-selecting over one and saving shows "That text already has a comment" instead of silently nesting/vanishing. _(logic verified: overlap-rejection + OverlappingCommentError; DOM pre-filter `rangeIntersectsHighlight` needs a visual check.)_

## Native key monitor: F13-F20 + Ctrl+Tab (#495-ec28, 2026-07-28, Rust — needs `make dev` restart)

- [ ] Help > Keyboard Shortcuts > pencil on any action, press **F13** (or F16-F20): the combo is recorded and persists. Repeat with a modifier (Cmd+F13) — the recorded string must match what a normal key produces. Same for the Global Hotkey field at the top of the tab.
- [ ] If **F14/F15** record nothing: check `curl 'http://localhost:9876/logs?source=native-keys'`. A "extended function key observed" line means AppKit delivered it and the gap is downstream; no line means macOS consumed the key system-wide for keyboard illumination — remap it in System Settings, not a bug here.

## Claude/Codex stay busy with a LIVE agent (#497-4e67, 2026-07-29, Rust — needs `make dev` restart)

Data integrity and the slash-menu log flood are already verified automatically —
`tests/terminal-stress/run.py` passes all four scenarios at 2000 records against a
HEAD build, with zero `slash_menu` log records. What is left needs REAL agents:

- [ ] Give Claude a long tool call (something taking minutes) while its empty `❯` composer stays visible: the tab must stay busy for the whole call, not flip idle. Then let it finish — the completed `✻ …ed for 1m 25s` summary must go idle normally.
- [ ] Claude with a **blocking Stop hook**: the tab must NOT settle to completed while the hook is still doing visible work, and the follow-up suggestions from the premature Stop must be discarded rather than left on screen.
- [ ] Codex v0.145+ with a background terminal: the `»` composer row (not the historical `›`) must anchor the Working marker, and the tab stays busy.

## Cross-repo content search covers every registered repo (#483-7b93, 2026-07-29, Rust — needs `make dev` restart)

- [ ] Command palette, `?OPENROUTER` with **Search all repos** on: matches appear from repos you have NOT opened this session. _(2026-08-20, measured against the shipped backend: they do NOT. `/fs/search-content-all?query=OPENROUTER` returned matches from `tuicommander` only, with `repos_searched: 1` and `repos_pending: 40`, unchanged across four polls over 80 s. This is the documented design, not a regression — `fs.rs:613-616` says outright that "the configured warm strategy owns build scheduling: one cross-repo query must not enqueue every registered repo behind the single global build semaphore". With the default `active_and_switch` strategy an unopened repo has no index, so it stays unsearchable. The criterion as written is only satisfiable with the `all` strategy)_
- [ ] Repeat the search a few seconds later: the pending count drops and matches appear, proving `ensure_index` was kicked off by the first search rather than the repo staying invisible forever. _(2026-08-20: **the pending count does not drop.** Four searches over 80 s all reported `repos_pending: 40`, and no index build appeared in the logs. `search_content_all_impl` (`fs.rs:656-671`) counts a missing index and moves on — it never calls `ensure_index`. The criterion describes an intent the implementation deliberately rejected)_

**Consequence worth a decision (2026-08-20):** the two points above make the
`N still indexing, retry shortly` wording misleading. Nothing is indexing, and
retrying never helps under the default strategy. Either the search must warm the
missing indices (what this checklist assumed) or the message must stop promising
progress that will not happen.

## Codex busy while a background terminal runs (#482-33ec, 2026-07-29, Rust — needs `make dev` restart)

- [ ] Start a background terminal from Codex (something long, e.g. `sleep 120 &` via its own runner) so its status row reads `• Waiting for background terminal (Ns • esc to interrupt)`. The tab dot must stay **busy (non-green)** for the whole wait. Before the fix the verb swap flipped it idle within seconds and nothing could re-enter busy until the next user submission.
- [ ] While it is waiting, confirm the session is NOT put into standby (auto-standby SIGSTOPs an idle session — a false idle here would suspend Codex mid-work).
- [ ] After it finishes, the transcript line `• Waited for background terminal · <cmd>` (past tense, no `esc to interrupt`) must NOT hold the tab busy — it should go idle normally.

## Off-domain OAuth authorization servers no longer blocked (2026-08-01, Rust — needs `make dev` restart)

- [ ] Authorize an MCP upstream served through a gateway whose AS metadata carries a different `issuer` (e.g. a `*.mcp-s.com` tenant): the flow must reach the consent dialog instead of failing with "Issuer mismatch … mix-up attack".
- [ ] That dialog must be the **warning** variant and say the authorization server is on a different domain, naming the AS origin — and Cancel must still abort cleanly (upstream back to `needs_auth`).
- [ ] Authorize an upstream whose AS is on the same registrable domain: dialog stays the plain `info` variant with no cross-domain sentence.
- [ ] `curl 'http://localhost:9876/logs?source=mcp_oauth'` after the gateway case shows the `AS metadata issuer differs from the discovery URL` warning (warn, not error).
- [ ] Regression: an upstream with an explicit `authorization_endpoint`/`token_endpoint` override still skips discovery and gets the plain dialog.

## Worktree mid-rebase stays alive (2026-08-01, Rust — needs `make dev` restart)

- [ ] Finish the rebase (`--continue` through the conflicts): the row must survive the whole way and settle back on its branch.
- [ ] `git rebase --abort` from the worktree: row still there, branch restored, no prompt.
- [ ] Regression: delete a worktree's branch with `git branch -D` while the worktree exists and no operation is running — the archive/delete prompt MUST still appear.

## Grok returns to idle after a long turn (2026-08-01, Rust — needs `make dev` restart)

- [ ] Watch the tab dot during the turn: it must stay busy while the `⠋ Waiting for response…` row is animating, and only then go green.
- [ ] Regression: Aider — its Knight Rider `█░` spinner must still hold the tab busy (the fix only excludes a row trimmed to a *single* block glyph).
- [ ] Regression: a short Grok turn whose output fits the viewport (no scrollbar column) still goes idle as before.

## OpenCode returns to idle after a finished turn (2026-08-02, Rust — needs `make dev` restart)

- [ ] Run an OpenCode turn: the tab dot must go green within seconds of the composer coming back, instead of sitting busy for the whole process.
- [ ] Watch the dot DURING the turn (including a tool phase such as a long `bash` call): it must stay busy while the footer shows `⬝⬝⬝■■■  esc interrupt`.
- [ ] Auto-standby must not SIGSTOP an OpenCode session mid-turn.
- [ ] Regression: with OpenCode exited and a plain shell on screen, the session must not report Ready off the leftover frame (the adapter requires both the `┃`/`╹▀▀▀` frame and the `ctrl+p commands` status bar).

## Screen adapters still missing for amp / cursor / goose / droid (2026-08-02, audit — blocked on installs)

Audited while fixing OpenCode (#535-d4f5): these four have no ready-screen adapter, so if
their foreground command is long-lived they hit the same OSC 133 "busy forever" failure.
None of the binaries is installed on this machine, and writing an adapter from documentation
rather than a live capture is exactly how grok shipped green tests over a stuck UI.

- [ ] [HUMAN] Install `amp` and capture its idle + mid-turn screens, then decide whether it needs an adapter.
- [ ] [HUMAN] Same for `cursor-agent`.
- [ ] [HUMAN] Same for `goose`.
- [ ] [HUMAN] Same for `droid`.

## Alternate-screen scrollback (2026-08-03, Rust — needs `make dev` restart / `make build`)

Reported by Boss: `gh run watch <id>` renders but has no scrollbar. Root cause: the alternate
screen had scrollback capacity 0, so `historySize` was always 0 and the scrollbar hid itself.
Now the separate alt grid keeps the lines that scroll off, with the same user-visible result as
iTerm2's save-to-scrollback option but a different internal architecture. Backend is covered by
tests replaying a real `gh run watch` PTY capture
(`src-tauri/src/fixtures/alt_screen/gh-run-watch.raw`); canvas rendering is not observable over HTTP.

- [ ] [VISUAL] Open `vim`/`htop`/`lazygit`: wheel still goes to the app; `Shift+wheel` scrolls TUIC history; quitting restores the shell scrollback unchanged. _(only the mouse-reporting forwarding is left unverified — the enter/exit half is covered above.)_

## tuic CLI: repo opening + command ergonomics (2026-08-03)

The `tuic` sidecar was rebuilt (`node src-tauri/build-sidecar.mjs`), so the CLI half is live
immediately. The app half — the `open-repo` deep link adding an unknown folder — is frontend
code and needs the WebView to have reloaded.

- [ ] [HUMAN] `tuic <dir>` on a folder NOT in the sidebar: one confirmation appears, then the repo is added and activated exactly like the "Add Repository" button (branch selected, terminal opened, watcher started).
- [ ] [HUMAN] `tuic run pnpm dev` in a repo: a session appears and the command is running in it.

## Smart Prompts settings tab + HelpPanel system-menu note (2026-08-05, frontend only — Vite HMR is enough)

`SmartPromptsTab` existed but was never registered in `SettingsPanel`, so the drawer's
"Manage Smart Prompts..." landed on General. Now it is a nav entry (`smart-prompts`) and the
drawer opens it directly. Separately, HelpPanel gained the missing note pointing at the native
system menu bar (desktop only — browser mode has no native menu).

- [ ] Visual pass: ~~Smart Prompts category groups/counts and mode/placement/built-in badges~~ **residual:** inspect the expanded editor and desktop HelpPanel note spacing under Quick Actions. _(Browser screenshot `/tmp/luna-smart-prompts.png` proves the groups/counts/badges; browser Help has no native system-menu note.)_

## GitHub panel keyboard UX + persisted collapse (2026-08-05, **Rust change — needs `make dev` restart**)

Arrow/Enter navigation across the three GitHub panel sections, plus collapse state persisted through
`save_ui_prefs`. PrSection is now fully controlled by GitHubPanel (collapse, expansion, dismissed
PRs lifted) so the navigable row list and the rendered rows cannot drift apart.

- [ ] **After a `make dev` restart**: collapse a section, quit, relaunch — the section is still collapsed. Without the restart the Rust `UIPrefsConfig` field is absent and serde silently drops it, so it only persists in-session.
- [ ] Visual: the `.ghItemRowActive` highlight (inset accent bar) reads clearly in light and dark themes, and the active row scrolls into view on long lists.

## Compose enqueue + MCP attention callback (2026-08-08, **Rust change — needs `make dev` restart**)

Compose panel gained a second submit that queues instead of steering, and the `ui` MCP tool
can now raise a named notification sound (new `attention` callback). Both are Rust-backed, so
nothing below works against the currently running binary.

- [ ] **After a `make dev` restart**: with an agent mid-turn, `Shift+Ctrl+Enter` a prompt, watch the badge show `1 queued`, and confirm the prompt is typed the moment the agent finishes — not before.
- [ ] **After a `make dev` restart**: queue two prompts, confirm they arrive in order across two idle windows, and that clicking the badge discards them.
- [ ] **After a `make dev` restart**: confirm a generic OSC 777 `Claude Code needs your attention` completion notice does not leave the tab awaiting, while plan/skill pickers still do.
- [ ] **[HUMAN] Listen to the selected `attention` sound in the rebuilt app** — Settings > Notifications > Attention > Test. Boss selected sample C on 2026-08-09: triangular G4→G4→E5, 75/75/140 ms, 50 ms gaps, gain 0.8. Confirm the native engine matches the approved direct-synthesis sample and remains identifiable from another room without being irritating.
- [ ] **After a `make dev` restart**: `ui action=toast sound="attention"` from an MCP client shows the toast **on the desktop app** (it never did before — the event was bus-only) and plays the callback; muting Attention in Settings silences it while the toast still appears.

## Detached AI Chat window (2026-08-18, frontend only) — story `624-a6c3`

The detached chat now loads the conversation it was detached from and can send to the
terminal it was detached from. Vite reloads this without a restart.

- [ ] Detach the chat, type a message in the separate window, confirm it sends and the reply streams there (it was read-only before — the textarea said "Focus a terminal first").
- [ ] Close the detached window, reopen the panel in the main window, confirm the exchange is there.
- [ ] Detach from terminal A, switch the main window to terminal B, send from the detached window, close it, then switch back to A and confirm A shows the new messages.
- [ ] Detach with a non-terminal tab focused and confirm the window is read-only, with the "No terminal focused" banner rather than a broken send.

## Post-fix verification leftovers (2026-08-19) — stories `627-4571`, `628-7148`, `616-71e1`
### `627-4571` — needs the desktop app

- [ ] **[HUMAN]** Browser/PWA transport and tracked cwd are verified; **residual:** prove canvas OSC 133 gutter painting and trusted Cmd+Up/Down navigation on a visible browser client. _(HTTP captured OSC133 A/C/D, including exit codes 1/0, and cwd changes.)
- [ ] **[HUMAN]** Desktop still gets both events after the payload change: `pty-cwd` now carries `{cwd}` instead of a bare string. _(code confirms the desktop emits at `pty.rs:4777-4787` and `:4806-4811` with bus emits following; no desktop runtime observation is possible from a second instance)_
- [ ] **[HUMAN]** Frame bytes/s before and after on a busy session, confirming the ~3x drop the binary format predicts. _(post-fix side measured: 596 720 B over 16 frames. The "before" is unobtainable — no pre-fix binary exists any more, and a post-fix process cannot yield an honest baseline. Either accept the post-fix number alone or rebuild a pre-fix commit deliberately)_
- [ ] **[HUMAN]** A background tab still rings its bell, and switching back repaints immediately with no stale rows. _(needs audible delivery and row freshness by eye; hidden frames are decoded and ring at `CanvasTerminal.tsx:1358-1393`, show requests a full repaint at `:2121-2158`)_
- [ ] **[HUMAN]** A browser client and the desktop app streaming the same session both keep painting — neither steals the other's dirty rows. _(needs the desktop WebView alongside a browser; per-client gate rationale at `grid_gate.rs:1-21`, WS recovery at `mcp_http/session.rs:1481-1492`)_
- [ ] **[HUMAN]** A plain file save logs `Emit repo-changed (working-tree)` and the Git panel's Log/History/Stashes do NOT re-run their git processes; a `git commit` logs `(git-state)` and they DO refresh. _(requires mutating a real repo. Tabs depend on `getGitRevision` — `LogTab.tsx:207-224`, `HistoryTab.tsx:88-99`, `StashesTab.tsx:57-69`; `bumpGitRevision` moves both counters at `repositories.ts:779-795`)_
- [ ] **[HUMAN]** FileBrowser backend create/rename/copy/delete and read/write are verified over HTTP; **residual:** open and save a file through the FileBrowser/editor UI. _(Disposable repo HTTP operations passed; no live repo was mutated.)_
- [ ] **[HUMAN]** Dropping a large folder still freezes the UI. **This confirms a deliberate gap, it is not a regression** — `fs_transfer_paths` was intentionally left synchronous because it is the drag-drop backend and D&D needs Boss's approval. _(the gap is intact and documented at `fs.rs:1615-1629`; the native Finder→Tauri drop cannot be driven from browser mode)_
- [ ] **[HUMAN]** AI agent `read_file` / `write_file` / `edit_file` / `list_files` / `search_files` / `search_code` still work on the blocking pool. _(all six mapped in `ai_agent/tools.rs:2460-2477`, dispatched through `spawn_blocking` at `:2525-2534`; write/edit need the desktop confirmation UI)_
- [ ] **[HUMAN]** Terminal search and scrolled-back history backend reads are verified over HTTP; **residual:** trusted Cmd+F next/previous, file links, OSC 8 hover, and selection copy. _(Grid reads/search/scroll endpoints passed; UI bindings and clipboard remain unproven.)_
- [ ] **[HUMAN]** With a session producing heavy output, dragging a selection or typing in the search box no longer stalls the WebView. _(this is the freeze the finding is about; offload mechanism at `pty.rs:10167-10227`. Needs a visible live canvas and timed main-thread observation)_
- [ ] **[HUMAN]** HTTP `scroll-to`/offset behavior is verified; **residual:** trusted wheel, scrollbar drag, Cmd+Up/Down, and Home/End input routes. _(HTTP `terminal/scroll-to` returned 200 with `display_offset=120`; UI routes remain unobserved.)_

### `628-7148` — copy normalisation, content proven, rendering not

The text the copy produces is fully asserted by 9 green Rust tests
(`cargo nextest -E 'test(copied_selection)'`). What is left is only how a paste
target renders it.

- [ ] **[HUMAN]** Copy a Claude blockquote, paste into Slack, confirm no gutter bars. _(content proven by `copied_selection_strips_repeated_claude_gutters`, `_strips_space_indented_gutters`, `_accepts_nbsp_separator_and_preserves_body_nbsp`)_
- [ ] **[HUMAN]** The pasted paragraph has no mid-sentence line breaks; bullets and blank lines keep their own line. _(proven by `copied_selection_rejoins_rows_claude_wrapped_for_width`, `_rejoins_bullet_continuations_but_not_the_next_bullet`, `_stops_rejoining_after_the_wrapped_paragraph_ends`, `_normalizes_after_unwrapping_soft_wrapped_rows`)_
- [ ] **[HUMAN]** Copying a short hand-written quote or a code block is unchanged. _(the over-reach guards: `copied_selection_keeps_lone_or_non_claude_gutters`, `_keeps_deliberate_breaks_in_a_short_quote`)_

### `616-71e1` — measurement gaps left open on purpose

The story is complete; these are the two things its own document records as not
obtainable, kept here so nobody re-derives them from scratch.

- [ ] **[HUMAN]** Reproduce the F120 drag-drop freeze by dropping a large folder from Finder, and time it. _(the residual is real and narrowed to one command, `fs_transfer_paths` at `fs.rs:1624`, sync on the macOS main thread while every sibling moved to `spawn_blocking_fs`. Thread evidence was measured — `ps -M` 86 threads, `sample` ties WebKit IPC to `com.apple.main-thread` — but the freeze itself was not reproduced)_
- [ ] **[HUMAN]** Re-measure watcher emit suppression under real repo churn. _(`head_emits_suppressed` measured 0/min, but only on an idle instance with no repo mutation in the window. That is a floor: it proves quiescence, it does not re-measure the `repeat_count: 12` storm behind issue #82)_

### Story `632-8d67` — clicking an MCP toast jumps to its terminal

Backend change, so it needs a rebuilt binary: `make dev` does not hot-reload
`src-tauri/**`. Everything else in the story is verified by test.

- [ ] **[HUMAN]** From a rebuilt desktop app, have an agent call `ui action=toast` and click the toast — it must switch to that agent's tab. _(verified by test at the seams: the Rust bus event carries `origin_session_id` and the click focuses the matching terminal, `src/__tests__/components/ToastContainer.test.tsx`. What no test covers is the real IPC round trip through a live `AppHandle`, plus that the tab is genuinely the one on screen afterwards)_

### Story `631-e618` — browser mode renders (closed as an artefact)

Browser mode was verified working: a real headed browser at `:9877` sized every
canvas to its container and painted a live PTY. One comparison was not possible.

- [ ] **[VISUAL]** In browser mode, with a shell that has OSC 133 integration, check the gutter marks render at the same size as the desktop app. _(the probe shell had no shell integration, so there were no gutter marks on screen to compare. Rows, cursor, status bar and cwd all render — screenshot `/tmp/631-browser-mode.png`)_

### Story `627-4571` — restart checks the HTTP surface cannot reach

The 2026-08-18 Rust sweep is committed and the app has been restarted on it (binary
built 14:05, commits 10:35). Everything reachable over HTTP was verified and checked
off in the story: the `repo-changed` kind split, the binary frame format, the async
fs commands, the async grid reads (`scroll-info`, `lines`, `row-text`,
`search-buffer`, and a deleted session answering 404 rather than 500), and every
scroll mutation landing exactly where asked — `scroll` delta, absolute `scroll-to`,
and the coalesced `scroll-to-offset` (offset 100/200/0 → `riga-278`/`riga-178`/
`riga-378`, `display_offset` tracking each one). Read that offset back after a
beat: the endpoint coalesces, so an immediate read still reports the old position
and looks like a no-op.

What is left is canvas painting and input handling, which no endpoint exposes.

- [ ] **[VISUAL]** Frame bytes/s on a busy session, against the ~3x drop the binary format predicts. _(the pre-change baseline is gone with the old binary, so this is now a sanity check on the absolute number, not a before/after)_
- [ ] **[VISUAL]** A background tab still rings its bell, and switching back to it repaints immediately with no stale rows.
- [ ] **[VISUAL]** A browser client at `:9877` and the desktop app streaming the same session both keep painting — neither steals the other's dirty rows.
- [ ] **[MANUAL]** FileBrowser backend operations are verified over HTTP; **residual:** editor open/save and the visual FileBrowser interaction. _(All disposable HTTP create/read/write/search/rename/copy/delete operations passed.)_
- [ ] **[MANUAL]** AI agent `read_file` / `write_file` / `edit_file` / `list_files` / `search_files` / `search_code` still work — they now run on the blocking pool.
- [ ] **[VISUAL]** Terminal backend search/grid reads are verified asynchronously over HTTP; **residual:** Cmd+F next/previous, file-link opening, OSC 8 hover, and selection copy UI.
- [ ] **[VISUAL]** With a session producing heavy output, dragging a text selection or typing in the search box no longer stalls the WebView — the freeze F95 is about.
- [ ] **[MANUAL]** Dropping a large folder still freezes the UI. _(`fs_transfer_paths` was deliberately NOT converted — this confirms the known gap, it is not a regression. Same residual as F120 above)_
- [ ] **[MANUAL]** Desktop still gets both events after the payload change: `pty-cwd` now carries `{cwd}` instead of a bare string.

## Defects found during the 2026-08-20 browser sweep

### 1. A `null` answer is an error on the HTTP transport (browser/PWA only)

`transport.ts:2233-2235` throws `RPC <cmd>: empty response body` whenever the
decoded body is `null`. But `null` is a legitimate answer: `/agent/discover-session`
returns HTTP 200 with the body `null` when no session file matches, mirroring the
Tauri command's `Option<String>` → `None`.

Live evidence: the browser console on Boss's running instance carries
`[AgentDetect] term-2/3/4/6/10/15 discover_agent_session failed —
RPC discover_agent_session: empty response body`, once per terminal per poll.
Confirmed by hand: `POST /agent/discover-session` → `200`, `content-length: 4`, body `null`.

Consequence: **agent session discovery never succeeds for a browser/PWA client**,
so resume-after-restart cannot work there, and every 30 s poll logs a failure.
Every other command whose valid answer is `null` has the same fate.

- [x] Fix: distinguish "no body" from "body is `null`" in the transport, then confirm
      the AgentDetect errors stop and a browser client discovers a Claude session id. _(verified: focused transport tests and isolated :9877 POST `/agent/discover-session` returned literal `null`; a matching Codex fixture was discovered by both curl and browser fetch.)_

### 2. Two clients fight over `repositories.json`

With the desktop app and a browser client both attached, the browser's persistence
fails: `RPC save_repositories failed: 500 {"error":"config file changed on disk since
it was last read"}`. The guard is doing its job — the whole-object save would
otherwise clobber the desktop's write — but the frontend swallows the rejection as a
`debug` log, so the user's change is silently dropped rather than retried or merged.

- [ ] Decide: retry-on-conflict (reload, re-apply, save) or surface the failure. Silent
      loss is the one option that is certainly wrong. _(NOTE: Luna proved the delta protocol, queueing, visible error path, and Rust conflict behavior in tests, but the rebuilt-runtime proof is blocked: the current shared `repositories.json` was previously written as a delta by the stale Rust backend, and Sol's compatibility repair is awaiting root authorization. No shared config was repaired.)_

### 3. Content-search highlight offsets are byte offsets fed to a UTF-16 slice

`fs.rs:1007-1011` takes the match offsets from `matcher.find(line.as_bytes())`, which
are **byte** offsets, and `FileBrowserPanel.tsx:1359-1363` feeds them to
`line_text.slice()`, which counts **UTF-16 code units**. Every multi-byte character
before the match shifts the highlight by the difference.

Reproduced live: `src-tauri/src/llm_api.rs:21` contains an em-dash before the match,
and the rendered highlight was `enrouter, ` instead of `openrouter` — exactly the
2-unit drift a 3-byte `—` produces. Line 15 of the same file, pure ASCII, highlighted
correctly.

- [x] Fix: return char/UTF-16 offsets from the Rust side (or slice by bytes in the frontend), then re-check a line with an em-dash, an accented word and an emoji before the match. _(verified: Rust offset tests, FileBrowser desktop/browser rendering tests, and isolated :9877 HTTP results for ASCII/accent/em-dash/emoji returned UTF-16 ranges.)_

### 4. `autoExecute` is unreachable for every user-created prompt

The drawer's prompt editor renders an **Auto-execute** checkbox and persists it
(`PromptDrawer.tsx:447,652,759`), but no path a user can reach ever reads it:

| Link in the chain | Where | What breaks |
|---|---|---|
| The drawer's own injection ignores the flag | `PromptDrawer.tsx:158-177` | `doInject` keys off `executeImmediately` (double-click / "Insert & Run"), never `prompt.autoExecute` |
| The one reader requires `injectTarget === "terminal"` | `useSmartPrompts.ts:236-249` | default is `"compose"`, so the flag is skipped |
| `injectTarget` is editable only in Settings → Smart Prompts | `SmartPromptsTab.tsx:394-398` | — |
| …which lists only prompts tagged `smart` | `SmartPromptsTab.tsx:141` | the drawer's editor never sets `tags`, so drawer-created prompts are invisible there |

Verified live on `:9876`: the Settings → Smart Prompts tab listed only the built-in
groups (Git 4, Review 6, Pr 3, Merge 3, Ci 5, Investigation 5, Code 3 — 29 built-ins).
A prompt created through the drawer did not appear, and neither do Boss's own
`X - Hook` and `superGoal`. So a user can tick Auto-execute, save it, and it can
never take effect.

- [x] Fix: pick one owner for the flag. Either have `PromptDrawer.doInject` honour
      `autoExecute` the way `executeInject` does, or tag drawer-created prompts
      `smart` so `injectTarget` becomes editable. Leaving a checkbox that does
      nothing is the one option that is certainly wrong. _(verified: focused PromptDrawer/useSmartPrompts/usePty/sendCommand tests cover enabled/disabled user-created prompts, precedence, fallback, and exactly-once submission.)_

### 5. The Command Palette button exists only where the palette cannot open

`Toolbar.tsx:763-778` renders a "Command palette (⌘P)" button **as the browser-mode
fallback** — its own comment says it is there because "browser-desktop has no native
menu and keyboard shortcuts may be swallowed by the browser". But `App.tsx:986-989`
mounts `<CommandPalette>` behind `<Show when={isTauri()}>`, so in browser mode the
component never exists. The button therefore appears in exactly the one mode where
clicking it can do nothing: `commandPaletteStore.toggle()` flips state that nothing
renders.

Verified live on `:9876`: the button is present in the browser toolbar; clicking it
leaves zero palette elements in the DOM.

This is also the precise reason the cross-repo `?OPENROUTER` palette items in the
`#483-7b93` section cannot be exercised from a browser.

- [x] Fix: either mount the palette in browser mode (dropping the Tauri-only actions
      from the list) or drop the fallback button. Shipping a dead control in the mode
      that was supposed to need it most is the one option that is certainly wrong. _(verified: browser component/Toolbar tests, trusted toolbar click on :9877 with focused dialog, HTTP filename/content searches, foreign-batch rejection, and `/tmp/validate-six-command-palette-current.png`.)_

### 6. AI chat persistence is switched off in browser mode, though its HTTP routes exist

`conversationStore.ts` guards its whole persistence layer with `if (!isTauri()) return`
and reaches the backend by importing `@tauri-apps/api/core` directly, bypassing the
`transport.ts` wrapper that would map the call to HTTP. Six functions are affected:

| Function | Line | Effect in a browser |
|---|---|---|
| `deleteConversation` | 377 | old conversation never deleted |
| `schedulePersist` | 394 | no debounced autosave |
| `persistNow` | 405 | no save at all |
| `initFromDisk` | 451 | nothing restored on load |
| `listAllConversations` | 996 | returns `[]` — history list always empty |
| `loadConversation` | 1007 | a history entry can never be opened |

The backend is not the problem — `mod.rs:1045-1057` serves the full family
(`/ai/chat/conversations` GET, `/ai/chat/conversation` GET+POST,
`/ai/chat/conversation/delete` POST, `/ai/chat/new-id` POST). Verified live:
`curl localhost:9876/ai/chat/conversations` returns 200 with real saved
conversations, while the browser panel's history button opens an empty view
(panel text stays 182 chars, no list, no error logged — the guard returns before
any call is made).

This is the IPC/HTTP parity rule in AGENTS.md being broken in the frontend rather
than the backend: a browser/PWA user's AI chat keeps no history whatsoever.

- [x] Fix: route these six through `invoke` from `transport.ts` and drop the
      `isTauri()` guards, so the existing routes are actually used. _(verified: browser persistence suite covers all six operations, stale/error behavior, and no direct Tauri invoke; :9877 browser-created fixture survived reload, opened from history, and was deleted via the UI, with a subsequent 500 not-found response.)_

## Luna validation audit — 2026-08-21

All unchecked checklist entries were reviewed and reconciled against the strongest
available evidence. Items remain open when their full stated behavior still needs a
desktop WebView, a rebuilt/release app, real hardware, an external service, a real
agent, a destructive or repository-mutating action, or a visual/manual observation.
Existing evidence notes and defect candidates above remain authoritative; no source
fixes were made during this audit.

Validation evidence:

- `rtk cargo nextest run --manifest-path src-tauri/Cargo.toml --no-fail-fast`: 4,641 tests passed.
- `rtk cargo test --manifest-path src-tauri/Cargo.toml --doc`: 0 passed, 1 ignored.
- `rtk pnpm vitest run`: 355 files and 5,386 tests passed; the run still reports one async timer leak in `ToastContainer.test.tsx` via `activityStore.ts:30`.
- The targeted Luna queue tests passed: `enqueue_never_overtakes_a_command_already_waiting` and `clear_queued_commands_preserves_peer_deliveries`.
- Live `:9876` HTTP probes used uniquely named throwaway sessions, covering PTY output/activity, SSE events, terminal lines/row text, search-buffer, scroll/scroll-to/scroll-to-offset, and deleted-session `404` behavior. The final `audit-luna-20260821-copy` fixture session was deleted and verified absent.
- Persistent stealth-browser session `tuic-test` exercised Smart Prompts navigation/settings, Help, AI Chat history, and the Command Palette toolbar button. Smart Prompts evidence is `/tmp/luna-smart-prompts.png`; the browser copy-selection retry is recorded in the copy items above.
- The deployed docs site loaded through the same persistent browser; Pagefind query `terminal` returned 61 results. At 375×667, the responsive layout still clipped the content/search hero, so that item remains open with screenshots recorded above.

The remaining `[HUMAN]`, `[VISUAL]`, and `[MANUAL]` entries are therefore intentional gaps, not unattempted assumptions. In particular, the six live defects documented above remain open until their fixes are implemented and revalidated.

### Tagged-item second pass — 2026-08-21

This second pass supersedes the stale mobile/docs wording in the preceding audit
paragraph. It covers every tagged item still open at the start of this pass; the
three items promoted above are the only tagged items closed by this run.

- **32 — promoted.** A headed browser run against `:9876` streamed an answer of
  about 17k DOM characters and rendered one fenced code block plus one table;
  the AI panel and terminal remained responsive. Evidence:
  `/tmp/luna-ai-chat-long.png`, `/tmp/luna-ai-chat-long-final.png`.
- **33 — remains open.** At 375×667 the terminal canvas sized to 342×580 and a
  live `FLOW-` search updated while output streamed; this does not prove the
  requested full-screen redraw (`htop`/TUI agent) smoothness.
- **46, 471, 514 — remain open.** Browser-side terminal rendering and HTTP
  transport evidence exist, but no safe desktop-WebView side-by-side visual
  comparison proved gutter mark placement and size.
- **215–217, 455 — remain open.** Release-app key-repeat/Option composition,
  explicit macOS defaults precedence, and native attention audio require the
  rebuilt release app and/or real hardware/hearing; no such interaction was
  claimed.
- **310–311 — remain open.** `tweakComments` and `tweakDomHighlight` targeted
  tests passed (54 tests), but the repeated-occurrence anchor and overlap UI
  still need a visual browser/editor check.
- **380–383 — remain open.** `amp`, `cursor-agent`, `goose`, and `droid` are
  not installed (`command -v` returned no path), so their idle/mid-turn adapter
  screens cannot be captured.
- **394 — remains open.** Vim 9.1 was opened visually in a throwaway session,
  but the wheel/Shift+wheel forwarding and quit/scrollback sequence was not
  completed: the browser wheel automation hung and was terminated safely.
  `lazygit` is not installed; no live session was reused.
- **402–403 — remain open.** `tuic --version`/`tuic --help` worked (1.7.4),
  but the two commands were not run because they would create a real TUIC
  session or dev process outside the disposable HTTP-session scope.
- **413–414 — promoted.** The deployed docs site returned 61 Pagefind results
  for `terminal`; at 375×667 the hero search and menu-bar search panel were
  usable after closing the contents drawer, with no horizontal page overflow.
  Evidence: `/tmp/luna-docs-desktop.png`,
  `/tmp/luna-docs-mobile-closed-audit.png`,
  `/tmp/luna-docs-mobile-search-panel.png`.
- **472 — remains open.** `/events` delivered live `pty-cwd` payloads while a
  throwaway session changed from `/private/tmp` to `/`; the desktop AppHandle
  counterpart was not observable from this browser instance.
- **473 — remains open.** The post-fix stream was measurable, but no honest
  pre-fix binary baseline remains for the requested before/after bytes-per-
  second comparison.
- **474–475, 507, 532–533, 539 — remain open.** Background-tab bell/repaint,
  browser-plus-desktop painting, native toast focus, and desktop event delivery
  require trusted desktop WebView/audio observation.
- **476 — remains open.** A disposable Git repo was mutated only through the
  HTTP FS API; no Git-panel revision split was exercised against a UI repo.
- **477, 534 — remain open.** HTTP create/read/write/search/rename/copy/delete
  operations passed against a disposable repo, but FileBrowser UI and editor
  open/save were not promoted from backend evidence.
- **478, 499, 538 — remain open.** Native Finder folder drag/drop was not
  attempted; the documented synchronous residual therefore remains neither
  reproduced nor disproved.
- **479, 535 — remain open.** No real AI-agent tool call was run; source and
  blocking-pool routing are evidence only.
- **480, 482, 536 — remain open.** Browser search, scrolled history, and
  Cmd+Up/Down were exercised; Home/End did not move history in this shell, and
  file-link/OSC8 hover plus clipboard proof remain incomplete. The trusted
  selection-copy probe selected `COPY_OK`, but paste into both a data-page and a
  local HTTP textarea remained blank; no clipboard-read API was used.
- **481, 537 — remain open.** A streaming-output search remained visually
  responsive, but no sufficiently heavy-output timed WebView-freeze measurement
  was obtained.
- **490–492 — remain open.** The normalization Rust tests passed and selection
  highlight was visible, but the trusted paste target stayed empty, so the
  end-to-end clipboard contract is not promoted.
- **500 — remains open.** No real repository churn was generated; the idle
  suppression reading cannot stand in for the requested storm measurement.
- **531 — remains open.** Same missing pre-fix bytes-per-second baseline as 473.

Audit incident: after a browser re-render, one Vim close attempt targeted the
live `Filter design` session instead of the throwaway tab. HTTP inspection found
an empty input buffer, no shell command or repository mutation, and the session
was left running; all further app UI automation was stopped. This is recorded as
an automation-targeting incident, not a product result.

## Rust changes staged 2026-08-21 — require a `make dev` restart

Neither is live in the running app; the Rust backend does not hot-reload.

### Awaiting badge through a multi-question `AskUserQuestion`

Observed on the live `Wire format` Claude tab: a multi-question dialog was on
screen waiting on Boss and the tab read "working". Sub-question 1 badges the
tab, answering it clears the badge, and sub-question 2 repaints its title and
options while the `Enter to select` footer stays byte-identical — so the
changed-rows parser never fires again. Fixed by `rearm_awaiting_for_open_dialog`
(`pty.rs`), which reads the footer off the full screen as a presence level.

- [ ] Open a multi-question AskUserQuestion (several sub-questions + Submit) and
  answer them one at a time. The tab must stay on the awaiting badge for EVERY
  sub-question, and drop it only once the dialog closes.
- [ ] Confirm no notification storm: one awaiting notification per dialog, not
  one per repaint or per arrow keypress.

### MCP elicitation drives awaiting (needs the hooks re-enabled)

`claude_hook_map()` gained `Elicitation` → awaiting and `ElicitationResult` →
busy, so an MCP server's `elicitation/create` dialog ("MCP server X requests your
input", Accept/Decline) badges the tab. Unverified against the running Claude
binary — the doc is the only source that these events fire.

- [ ] Re-enable Claude hooks in Settings → Agents (the map changed, so the badge
  reads "Hooks: re-enable"). Note: `~/.claude/settings.json` currently carries NO
  TUIC hooks at all, so nothing is instrumented today.
- [ ] Trigger the Context7 sign-in elicitation. Tab must go awaiting, and clear
  on Accept/Decline.
- [ ] Record it with `/diagnostics/capture` so the `.tcap` becomes a fixture.

### Every MCP `initialize` is logged

`initialize_session_id` now reports how a client arrived — `fresh`, `resumed` or
`reconnected` — and the handshake is logged at info with `source=mcp_initialize`.
A `reconnected` record carries the stale id in `presented_session`.

- [ ] After the restart, `curl 'http://localhost:9876/logs?source=mcp_initialize'`
  must show one record per agent handshake.
- [ ] Kill and relaunch an agent tab: its re-handshake must log `reconnected`
  with the previous session id, not `fresh`.

### grok is detectable again (`grok-1.0.5` symlink)

grok 1.0.5 installs `~/.grok/bin/grok` as a symlink to `grok-1.0.5`, and
`proc_pidpath` resolves the link, so the foreground process reads `grok-1.0.5`.
The running binary (built 22 Aug) matches agent names exactly, so every grok tab
gets `agent_type = None`. Measured live on 24 Aug: both an installed grok tab and
a fresh probe reported no `agent_state`, and
`get_session_foreground_process` returned `null`.

Consequence while undetected: `session_is_agent` is false, so nothing can be
typed into grok's composer — no peer message, no orchestrator mail wake — and
the OSC 133 busy bit set once by the long-lived `grok` command is never cleared,
so the tab reads working forever. The screen adapter that would fix both is
already shipped; classification never reaches it.

`strip_version_suffix` (uncommitted) closes it. Needs a `make dev` restart.

- [ ] Run `grok` in a tab. `session action=list` must show `agent_type`-derived
  `agent_state`, not an absent field.
- [ ] Finish a turn: the tab must leave working and reach `idle`, then
  `completed` once grok emits its `suggest:` marker.
- [ ] `agent action=send` to that grok tab while it is idle: `delivery_path`
  must be a terminal/wake route, not `inbox_only`, and the line must appear in
  grok's composer.
- [ ] Confirm `cursor-agent` and other hyphenated binaries still classify
  correctly (covered by unit test, but re-check one live tab).

## Extended-thinking gate covers Opus/Sonnet 4.6 (needs `make dev` restart)

`supports_extended_thinking` (`src-tauri/src/ai_agent/conversation_engine.rs`)
matched only `opus-4-7` / `opus-4-8` / `opus-4-9` — the last of which is not a
real model. Opus 4.6 and Sonnet 4.6 are in genai 0.6.5's own
`SUPPORT_EFFORT_MODELS` + `SUPPORT_ADAPTIVE_THINK_MODELS`, so they were being
denied reasoning for no reason. The Claude 5 family stays gated OFF on purpose:
genai's `claude-opus-(\d+)-(\d+)` regex needs a minor-version suffix, so a bare
`claude-opus-5` misses every table and would get the legacy `budget_tokens`
payload that Claude 5 rejects with a 400.

- [ ] Point an AI-chat provider at `claude-sonnet-4-6` with reasoning on and
  confirm reasoning chunks stream (no 400).
- [ ] Same with `claude-opus-4-6`.
- [ ] Point one at `claude-opus-5` and confirm it still answers normally — no
  `thinking` block, and crucially no 400 from the API.

## Dead commands removed: `update_session_cwd`, `get_global_hotkey` (needs `make dev` restart)

Both were registered Tauri commands with zero callers, carrying stale
DEFERRED notes claiming the feature was unwired. Both premises were false:
Rust already handles OSC 7 in-stream (`pty.rs`, `TermEvent::Osc7`), and the
hotkey already reaches the settings UI via the config payload. Removed the
commands, their `lib.rs` registrations, and their `INTENTIONALLY_UNMAPPED`
entries in `transport.ts`.

- [ ] `cd` around in a terminal, restart TUIC, confirm the restored session
  reopens in the last cwd (not the launch-time one).
- [ ] Open Settings → Keyboard Shortcuts and confirm the global hotkey still
  displays its current value on load, and that setting a new one still works.

## `VtLogBuffer::resize` lost its dead `shell_state` param (needs `make dev` restart)

The param was `_shell_state` (ignored) and its only caller computed a
`shell_states` lookup purely to feed it. Renamed `resize_with_shell_state` →
`resize`, dropped the param and the now-pointless lookup in `pty.rs`.

- [ ] Resize the window and a split pane over a full screen of content: the
  viewport must repaint fully, no blank area until a scroll.
- [ ] Resize while a fullscreen TUI (vim/htop) is running — alt screen must not
  reflow.

## File Browser: new file/folder now appears in tree view (Vite HMR, no restart)

`TreeNode` fetched its children only inside the click that expanded it, so
nothing could re-read an already-expanded folder. Every invalidation path was
dead: creating a file, deleting, renaming, and the `dir-changed` watcher all
drop a cache key and expected a reload that never happened — the row simply
never appeared, or the node rendered empty forever. Moved the fetch into a
`createEffect` keyed on expanded-state + cache presence.

- [ ] Tree view, expanded folder → right-click → New File → `.env`: the row
  must appear immediately (dimmed, because gitignored).
- [ ] Same for New Folder, Delete and Rename on an already-expanded folder.
- [ ] Create a file from an external editor inside an expanded folder: the
  `dir-changed` watcher must make it appear without collapsing/re-expanding.

## Markdown preview: checkboxes inside table cells

`[x]` / `[ ]` / `[~]` in a whole table cell now render as a real checkbox and
toggle the source. GFM task lists are list-item-only, so marked never did this.

- [ ] Open a markdown doc with a status table (e.g. `ego/docs/18-pi-hermes-…`),
  click a cell checkbox: it must toggle and the file must save with the mark
  changed at that exact cell, not another one on the same line.
- [ ] A table with the checkbox column in a different position must still map
  1:1 (two tables in the same doc with different column indexes).
- [ ] `[x]` inside a code fence must stay literal text.

## Voice plugin (`tuic-voice`)

Speaks an agent's prose while it streams, via the WebView's `speechSynthesis`.
Already loaded live (JS hot-reload, no rebuild needed) — the log confirms 68
voices in the WKWebView. What a human still has to judge is whether it picks the
right text, because every filter stage is a heuristic and the fixtures are
synthetic: no real Claude/Codex turn was ever replayed through it.

Right-click a terminal for **Voice: settings / toggle / stop speaking**.

- [ ] Run a Claude turn that mixes prose with tool calls: only the prose is read.
  A spoken `Bash`, `cargo`, a file path or a diff line is a filter bug — turn on
  "Log every dropped line" in the settings panel and check `GET :9876/logs` for
  the rule that let it through (or wrongly dropped a sentence).
- [ ] The status line / HUD below the input box is never read. This is the
  bottom-zone rule; if any of it is spoken, `chromeCutoff` found no `❯` anchor.
- [ ] Speech starts on the first complete sentence, NOT at the end of the turn.
- [ ] No sentence is repeated as the TUI repaints.
- [ ] The last sentence of a turn is spoken even without a full stop.
- [ ] "Voice: stop speaking" cuts off mid-sentence, immediately.
- [ ] An Italian reply is read with an Italian voice, not an English one
  mangling it — the plugin sets no `lang` by default, so this may need a voice
  picked by hand in the settings panel.
- [ ] Codex / Grok / Gemini: the drop rules were written against Claude Code's
  glyphs (`⏺`, `⎿`). Check what each of the others does to the filter.

## Voice plugin freeze (fixed)

Boss had to disable the plugin: the app locked up completely as soon as it
started speaking. Cause was an infinite loop in `drain()` — the buffer was cut on
`[.!?…:]` but the "is this worth saying" test excluded the colon, so a short
colon-terminated chunk was consumed, rejected and put back unchanged, and the
next pass cut it at exactly the same place. Frontend-only, so a reload is enough.

- [ ] Re-enable `tuic-voice` and run a turn containing a short clause before a
  colon ("Ecco il piano: ..."). The UI must stay responsive throughout.
- [ ] A turn ending on a colon with nothing after it: nothing is spoken until
  the turn ends, then the tail flushes. No freeze while waiting.
- [ ] An abbreviation ("e.g.", "v1.2") mid-sentence does not stop the real
  sentence after it from being spoken.

## Cross-repo tab misfiling (fixed)

Every "which repo owns this?" question now goes through one resolver
(`utils/repoOwnership.ts`), which has no parameter through which the focused
repo could reach it. Frontend-only — a browser reload picks it up, no rebuild.

Four of these were driven through the web UI on `:9876` with `agent-browser`.
Note for whoever repeats it: in dev, `:9876` serves the **built** `dist/`, not
Vite (which sits on `:1421`). A source edit is invisible there until
`pnpm build` — the desktop WebView gets it over HMR, the browser does not.

- [x] Launch a PTY / agent in repo A while looking at repo B: the tab appears
  under A, not B. _(verified: focused on `tuicommander`, MCP-spawned a session
  with `cwd=…/ego`; `ego:master` went 3→4 terminals, `tuicommander:main` stayed
  at 2.)_
- [ ] A plan file written by a session in repo A opens as a tab under A while
  you are on B. Previously the event was dropped outright — check the app log
  for `[plan] event:` with the right `ownerRepo=`.
- [x] Open the same relative path (e.g. `README.md`) in two different repos:
  two separate tabs, each visible only under its own repo. _(verified: opened
  `README.md` from `tuicommander` and from `ego`; each repo's tab bar shows
  exactly one, and the content differs.)_
- [x] Reopen a file belonging to repo A while focused on repo B: the existing
  tab is re-activated and stays under A — it must NOT migrate to B. _(verified:
  reopened tuicommander's `README.md` while focused on `ego`; tuicommander still
  has exactly one README tab, ego still has its own.)_
- [ ] "Open With FastAF" on a file from a repo that is not the focused
  one: the tab is scoped to that file's repo, not shown under every repo.
  _(NOTE: desktop-only — the file association does not exist in web mode, so
  this one cannot be driven from the browser.)_
- [ ] Click a file path printed by an agent running in another repo: the tab
  lands under that repo.
- [ ] Register a repo AFTER sessions are already running inside it (this was
  `gate-os` in Boss's log): its parked tabs move to it automatically. The log
  shows `[Reconcile] <id> ... → <repo>:<branch>`. _(NOTE: not driven from the
  browser — unregistering and re-registering one of Boss's live repos writes to
  the shared `repositories.json`. Needs a scratch repo.)_
- [x] `cd` a terminal from one repo into another (OSC 7): the tab does NOT move.
  It stays under the repo it was opened in, keeps its place in the tab strip, and
  the sidebar counts do not change. _(REVERSED on 2026-08-29. This item once asked
  for the opposite and was ticked when the tab followed the `cd` — that was the
  regression Boss reported as "the app changes repo on its own". **Driven live in
  the web UI on 2026-08-29 and it FAILED first: `reclaimParkedTerminal` was only
  half the fix.** A throwaway session in `veritas` that cd'd to `mdkb` moved
  anyway — veritas 3→2, mdkb 2→3 — and the sidebar followed it, because
  `CanvasTerminal` also feeds the cwd to `onCwdChange` →
  `performCwdReassignment`, a second re-homing path that additionally calls
  `repositoriesStore.setActive` when the tab is the active one. Log evidence:
  `[CwdChange] term-24 → …/mdkb:main`, and the same line for the desktop
  client's own id `term-472`. Guarded now (`createTerminalWorktreeCoordinator.ts`)
  so a cwd may only re-place a tab inside its owning repo. Re-driven after the
  fix: cwd moved to mdkb, brainstorming stayed at 2, mdkb stayed at 2,
  `activeRepoPath` unchanged, no `[CwdChange]` line at all.)_
- [x] `cd` a PARKED terminal (one whose cwd matched no registered repo) into a
  repo that is registered: that one does move, and the log shows
  `[Reconcile] <id> ... → <repo>:<branch>`. This is the only case a `cd` settles.
  _(verified live 2026-08-29 in the web UI: a session opened on `/tmp` parked in
  the active repo — `cwd "/tmp" is owned by no registered repo` — then a `cd` into
  `veritas` produced `[Reconcile] term-25 …/mdkb:main → …/veritas:main` and moved
  the counts mdkb 4→3, veritas 2→3. The active repo did NOT change, which is the
  difference between settling a parked tab and re-homing an owned one.)_

## Background file tab must not steal the pane

Found while testing the item above. `tuic://open/<path>` with `focus: false`
deliberately does NOT switch repo — but it still called `mdTabsStore.add`, which
activates. The result was the exact ghost the focused branch avoids: the file's
content filling the pane while its own tab button is filtered out of the bar,
under a repo it does not belong to.

- [x] Open a file from repo A with `focus: false` while looking at repo B:
  nothing appears in B — no tab button, no content. _(verified in the web UI:
  zero occurrences of the filename anywhere in B's view.)_
- [x] The same tab IS present under repo A, unactivated. _(verified: switching
  to A shows it in the tab bar.)_
- [ ] `tuic://edit` with `focus: false` behaves the same way (same fix, via the
  new `background` option on `editorTabsStore.add`) — not exercised live.

## Poisoned `repositories.json` guard

Frontend-only (reload is enough). Reproduces the 2026-08-21 loss on purpose, so
**back the real file up first** and do it with the app stopped.

```bash
D=~/Library/Application\ Support/com.tuic.commander
cp "$D/repositories.json" "$D/repositories.mine.json"
echo '{"mutationVersion":1,"repos":[],"groups":[]}' > "$D/repositories.json"
```

- [ ] Start the app: the repo list is empty AND the Errors badge carries
  "repositories.json holds a mutation delta". No stack trace about
  `Object.values`.
- [ ] With the app still running, restore the backup over the poisoned file. The
  restored file must still be intact a minute later — saves are blocked, so
  nothing clobbers it. This is the step that failed during the incident.
- [ ] Restart: the 38 repos are back and a normal mutation (add a repo, reorder)
  saves again.
- [ ] A genuinely empty file (`{}`) still starts a fresh install: empty list, no
  error, and adding a repo persists.

## mdkb code intelligence — after `make dev` restart AND a fresh mdkb install

Rust change: needs a TUIC restart. It ALSO needs an mdkb newer than 3.7.17 —
`code_graph` only carries the machine-readable `symbols` field from the commit
added alongside this fix. Build and install mdkb first (`cargo build --release`
in the mdkb repo, then put the binary in a trusted dir), otherwise find-references
fails with "code_graph response has no 'symbols'".

- [ ] **Find references** (Shift+F12 on a symbol in the code editor) lists the
  callers. Before this fix it silently returned an empty list, always — mdkb
  answers `code_graph` with prose and TUIC was parsing it as JSON.
- [ ] Clicking a reference opens the caller **on the right line**, not one line
  above it. mdkb ranges are 0-based; TUIC now shifts them.
- [ ] **Outline panel**: clicking a symbol lands on its own line, not the line
  before. Check a symbol on line 1 of a file too — it used to clamp to line 1
  either way, hiding the off-by-one.
- [ ] **Cmd+Click go-to-definition** in the editor lands on the right line.
- [ ] Outline nesting: methods inside a type are indented one level, top-level
  functions are not. (Previously everything with any scope got the same indent.)
- [ ] With the OLD mdkb still installed, find-references shows no results and
  logs `mdkb_references failed: ... no 'symbols'` — it must NOT look like a
  symbol with zero callers. Check `GET http://localhost:9876/logs`.

## MCP `ui action=confirm` on every client — after `make dev` restart

Rust change: needs a TUIC restart. The native OS dialog is gone; the request now
goes to the desktop WebView, browser tabs and the mobile PWA at once, plus a
mobile push, and the first answer wins.

- [ ] Ask an agent for a confirmation (`ui action=confirm`). The dialog appears
  **in-app** (dark themed), not as a light macOS system sheet.
- [ ] The same dialog appears at the same time on `http://localhost:9876/mobile.html`
  in a browser or on the phone. This is the whole point — before, a remote human
  could not answer and the agent blocked until someone reached the machine.
- [ ] On a phone-width screen the dialog is readable and both buttons are
  tappable — it reuses the desktop `shared/dialog.module.css`, which had never
  been rendered at that width before. (Needs a live backend to raise a real
  confirm, so it could not be screenshot-checked at implementation time.)
- [ ] A confirm with a **long** message scrolls inside the dialog and still shows
  its buttons. `.popover` clips overflow, so `.body` now caps at 60vh and
  scrolls — check a couple of ordinary desktop dialogs (rename branch, create
  worktree, unsaved changes) still look unchanged, since that CSS is shared.
- [ ] Answering on **mobile** unblocks the agent, and the desktop dialog
  disappears by itself. Then the reverse: answer on desktop, mobile dismisses.
- [ ] With a mobile push subscription registered, a confirm raised while the PWA
  is closed sends a push carrying the title.
- [ ] Escape / clicking the overlay answers **cancel**, and Enter also takes
  Cancel — the agent asks before destructive ops, so Enter must not approve.
- [ ] Leave a confirm unanswered for 5 minutes: the agent receives
  `{confirmed: false, reason: "no answer within 300s"}` and the dialog closes on
  every client. It must NOT read as an approval.

## Nested shell prompt no longer reads as working

Requires a `make dev` restart — the change is in `src-tauri/src/pty.rs`.

- [ ] In a shell tab run `sh` (or `sudo su`). Within ~4s of the inner prompt
  appearing the tab badge goes **idle**. Before, OSC 133 latched it `busy` for
  as long as the inner shell lived — observed stuck for 33 minutes.
- [ ] Run a real command in that inner shell (`sleep 20`, a build): the tab goes
  back to working while it prints, and returns to idle at the prompt.
- [ ] `sudo dd if=… of=…` with no output for a minute must stay **working** —
  the wrapper has real work under it. This is the regression the probe must not
  cause.
- [ ] An agent tab (Claude, Codex) is unaffected: its badge still follows the
  ready-screen adapter, not this probe.


## Repository saves survive a concurrent diffstat change

Requires a `make dev` restart — the change is in `src-tauri/src/config.rs`.

- [ ] With two windows open on the same config, work in a repo so its diff counts
  keep moving (an agent committing is enough). Rename another repo, reorder the
  sidebar, add a repo. Each must persist. Before, `GET /logs` showed a stream of
  `Repository changes were not saved` / `repository configuration conflict`, and
  nothing was written.
- [ ] `GET http://localhost:9876/logs?level=error` shows no
  `Repository changes were not saved` entry over a working session.
- [ ] Rename the same repo in two windows without reloading either: this must
  STILL conflict. The exemption covers counts, not intent.
- [ ] The sidebar diff counts keep updating — the exemption must not make them
  unwritable.

## A parked tab names the repo to register

Frontend only; Vite HMR picks it up.

- [ ] Have an agent spawn a child via MCP in a worktree of a repo that is NOT
  registered (`<repo>__wt/<branch>`). A toast appears: *Tab parked in the wrong
  repo — nothing claims "<repo root>"*. The log warning names the same path.
- [ ] Reconnecting many sessions from that one repo raises ONE toast, not one
  per session.
- [ ] Register that repo: the parked tab moves to it by itself, and the active
  repo does NOT change under you while the tab moves.

## An exited tab says so instead of going black

Frontend only; Vite HMR picks it up. Already verified live in the running dev
build: `term-100` ("GitHub state", exited agent in a deleted worktree) renders
one `terminal-exited-notice`, the other 15 tabs render none. What is left is the
visual check.

- [ ] Click an exited tab (grey dot). The panel shows a centred, muted *Session
  ended* / *The process exited and its output was released. Close this tab to
  remove it.* — not a black void.
- [ ] Open a brand-new terminal: the notice must NOT flash before the PTY
  spawns. A new tab also has a null sessionId; only `shellState === "exited"`
  may show the notice.
- [ ] Let an agent finish in a background tab: the tab keeps its grey dot and
  its name, and the panel shows the notice when you switch to it.

## Repository saves converge across windows

**Rust change — a `make dev` restart (or `make build`) is required.** The
frontend half is HMR-only, but `repositories-changed` is emitted by the backend,
so nothing happens until the Rust process is rebuilt.

- [ ] Open the desktop app and a browser at `http://localhost:9876/`. Rename a
  repo in the browser. The desktop sidebar shows the new name without a reload,
  and vice versa.
- [ ] Add a repo in one client: it appears in the other, in the right sidebar
  position.
- [ ] Remove a repo with no terminals open in one client: it disappears from the
  other.
- [ ] Remove a repo that has open terminals in the other client: that client
  KEEPS the repo and its tabs (they must not be orphaned), and the repo is still
  visible in the sidebar — not just present in memory.
- [ ] Remove a worktree/branch in one client while the other has a terminal open
  on that exact branch: the branch row and its tabs stay in the other client.
- [ ] Rename a repo in one client while the other has that same repo open and
  actively changing (edit a file so the diffstat moves): the rename still lands.
- [ ] Group a repo in one client, then delete the group there: the other client
  loses the group and shows the repo ungrouped, with no empty accordion left.
- [ ] Switch the active repo in one client: the other client's focus does NOT
  move.
- [ ] After any of the above, rename a *different* repo in the client that
  received the change. `GET http://localhost:9876/logs?level=error` shows no
  `Repository changes were not saved`, and the first client's change is still
  there — the receiver must not have reverted it.
- [ ] Toggle something that writes no change (re-save the same value): the other
  client must not re-read. `GET /logs` shows no burst of `load_repositories`.

## Auto-retry on Claude Code's prose 5xx message

**Rust change — a `make dev` restart (or `make build`) is required.** The parser
runs in the backend, so nothing changes until the Rust process is rebuilt.

**Precondition:** Settings → Agents → Claude → enable auto-retry. It is
`auto_retry_on_error`, default `false`, and it is currently unset in
`config.json`, so with it off you only get the red error badge and no retry.

- [ ] Reach a real `API Error: 500 Internal server error. This is a server-side
  issue…` in a Claude tab. `GET http://localhost:9876/logs` shows
  `[ApiError] … pattern=claude-server-error-friendly kind=server` followed by
  `[AutoRetry] claude: attempt 1/3 in 5s`.
- [ ] The tab does NOT play the error sound and does NOT show the red awaiting
  badge while a retry is pending — only after the 3rd attempt is exhausted.
- [ ] `continue` is injected after 5s and the turn resumes.
- [ ] With auto-retry disabled for Claude, the same error sets the red badge
  immediately and injects nothing.
- [ ] The message wraps across terminal rows (narrow the window before it
  fires): detection still happens — the pattern anchors on `API Error: 5xx`.
- [ ] A 429/overload (`API Error: 529` or "temporarily limiting requests") is
  still logged as a rate limit, not as a server error, and injects nothing.
