# Chunk 10 — mobile client, dictation/audio pipeline

Scope: `src/mobile/**` (the whole PWA client), `src-tauri/src/dictation/**`,
`src/stores/dictation.ts` beyond the poll gate, and the idle cost of
`src-tauri/src/native_keys.rs`. Same methodology, severity scale and
verification ladder as `performance_scan.md`. Finding ids F130-F139.
Read-only pass; no code was modified, no session created or closed, no audio
recorded.

F14 (log-mode WS materializes the whole styled screen 5×/s under the
`VtLogBuffer` lock) is the server half of the path F130 describes and is **not**
repeated here.

---

## Files evaluated

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src/mobile/components/OutputView.tsx` (memos 191-199, render 201-233, mount 144-182) | 10 | 2026-08-16 | **F130**, F137 |
| `src/mobile/utils/logLine.ts` (`groupLineBlocks` 129-147, `normalizeLogLine` 195-207, `lineMatchesQuery` 155-158) | 10 | 2026-08-16 | contributes to F130; F136, F137 |
| `src/mobile/useSessions.ts` (poll 79-100, SSE 104-126) | 10 | 2026-08-16 | **F131**, F132, F138 |
| `src/mobile/screens/SessionsScreen.tsx` (`For` 126-128) | 10 | 2026-08-16 | contributes to F131 |
| `src/mobile/components/SessionCard.tsx` (34) / `QuestionBanner.tsx` (25-31) | 10 | 2026-08-16 | contribute to F131 |
| `src/mobile/utils/useDebouncedStatus.ts` | 10 | 2026-08-16 | contributes to F131 (state destroyed by the churn) |
| `src/invoke.ts` (`ensureSse` 110-128, `listen` 164-207) | 10 | 2026-08-16 | **F132** |
| `src-tauri/src/mcp_http/sse_routes.rs` (`sse_events` 26-82) | 10 | 2026-08-16 | contributes to F132 (filter is opt-in) |
| `src/stores/dictation.ts` (`startAudioLevelPolling` 150-157) | 10 | 2026-08-16 | **F133** |
| `src-tauri/src/dictation/commands.rs` (`get_dictation_status` 85-113, `start_dictation` 173-329) | 10 | 2026-08-16 | **F133**, F139 |
| `src-tauri/src/config.rs` (`load_json_config` 146-169) | 10 | 2026-08-16 | contributes to F133 |
| `src-tauri/src/dictation/model.rs` (`model_exists` 85-92, `model_size_bytes` 95-97) | 10 | 2026-08-16 | contributes to F133 |
| `src-tauri/src/dictation/transcribe.rs` (`transcribe` 82-140) | 10 | 2026-08-16 | **F134** |
| `src-tauri/src/dictation/streaming.rs` (`streaming_loop` 124-214) | 10 | 2026-08-16 | **F135** |
| `src-tauri/src/dictation/audio.rs` (`process_audio_chunk` 198-252) | 10 | 2026-08-16 | clean (scratch buffers reused, `try_lock`, 30 s ring cap) |
| `src-tauri/src/dictation/vad.rs` | 10 | 2026-08-16 | clean (single pass over the last 1 s window) |
| `src-tauri/src/dictation/mod.rs` (`DictationState`, `shutdown` 49-57) | 10 | 2026-08-16 | clean (join order documented and correct) |
| `src-tauri/src/dictation/fn_key_monitor.rs` | 10 | 2026-08-16 | clean (already covered in 2b; re-read only for the idle-cost question) |
| `src-tauri/src/native_keys.rs` | 10 | 2026-08-16 | clean when inactive — see "Not covered" note 1 |
| `src/mobile/MobileApp.tsx`, `useVersionCheck.ts`, `useMobileNotifications.ts` | 10 | 2026-08-16 | F138; otherwise clean |
| `src/mobile/screens/SessionDetailScreen.tsx`, `ActivityScreen.tsx` | 10 | 2026-08-16 | clean (countdown/snapshot timers are correctly scoped) |
| `src/mobile/components/CommandInput.tsx`, `syncGuards.ts`, `utils/retryWrite.ts` | 10 | 2026-08-16 | clean (end-anchored delta, no per-keystroke full-line rewrite) |
| `src/mobile/components/IdeasOverlay.tsx`, `CommandWidget.tsx`, `SlashMenuOverlay.tsx`, `TerminalKeybar.tsx`, `SuggestChips.tsx` | 10 | 2026-08-16 | clean (mounted only while their overlay is open) |

---

## Findings

### F130 — the mobile terminal view destroys and rebuilds its entire rendered DOM on every screen frame (P1)

`OutputView` holds up to `MAX_LINES = 500` scrollback lines
(`OutputView.tsx:7`) plus the live screen rows, and renders them through three
chained memos:

```
allLines      = [...logLines(), ...screenRows()]        OutputView.tsx:191
displayedLines= allLines().filter(...)                  OutputView.tsx:193-197
lineBlocks    = groupLineBlocks(displayedLines())       OutputView.tsx:199
<For each={lineBlocks()}>                               OutputView.tsx:210
```

`groupLineBlocks` (`logLine.ts:129-147`) allocates a **fresh wrapper object per
line** on every run — `blocks.push({ type: "text", line })`. Solid's `<For>` is
keyed by reference, so a rerun produces zero identity matches: every block root
is disposed and every line `<div>` (with its `<Index each={line.spans}>`
children) is created from scratch. The underlying `LogLine` objects would have
kept their identity across a screen-only update; the wrapper allocation throws
that away.

The trigger is `onScreenRows` (`OutputView.tsx:169-172`), which fires from the
log-mode WS frame. Per F14 the server sends a `screen` payload only when its
hash changes — but an agent that is working repaints continuously (spinner,
elapsed timer, token counter), so during exactly the state a mobile user watches
this is the full 5 Hz poll rate of `handle_ws_log_session`.

Cost, measured where measurable (`GET :9876/sessions/<id>/output?format=log&limit=100`
against a live agent session on this machine, 2026-08-16):

- one `screen` payload = **32 rows, 234 spans, 9789 bytes** of JSON
- scrollback span density = **595 spans / 100 lines ≈ 5.95 spans per line**

So a full buffer is ~500 line `<div>`s × ~5.95 span nodes + 32 screen rows ×
~7.3 = **≈3 700 DOM nodes recreated per frame**. At 5 Hz that is **≈18 500 node
creations per second on a phone** — the node count is measured, the multiplication
by the frame rate is an estimate derived from F14's 200 ms poll, not profiled.

Two cheaper things ride along on the same trigger and are also full-buffer:
`allLines()` reallocates a 532-element array, and `hasBoxDrawing`
(`logLine.ts:121-123`) runs a `RegExp.test` over **every span of every line** —
~3 200 regex executions per frame — purely to decide table grouping that only
the screen rows could have changed.

The fix does not need a redesign: making `groupLineBlocks` reuse the block
object for an unchanged line (or moving the grouping into the Rust log frame,
per AGENTS.md rule D.15) restores `<For>`'s identity matching and reduces a
screen repaint to the 32 rows that actually changed.

### F131 — the 3 s poll replaces every session object, so the session list is torn down and rebuilt 20 times a minute (P2)

`useSessions.fetchSessions` (`useSessions.ts:79-93`) does
`setSessions(await rpc("list_active_sessions"))` every `POLL_INTERVAL_MS = 3_000`
(`:63`, `:99`). The result comes from `resp.json()`, so **every `SessionInfo`
and every nested `state` object is a new reference on every tick**, whether or
not anything changed.

Both consumers iterate it with reference-keyed `<For>`:

- `SessionsScreen.tsx:126-128` → one `SessionCard` per session
- `QuestionBanner.tsx:30` → one `BannerItem` per awaiting session

So every 3 s all cards are disposed and recreated, including their SVG icon
subtrees and their `AgentIcon`. `HeroMetrics` and `questionCount()`
(`MobileApp.tsx:129`, `SessionsScreen.tsx:95`) re-filter the whole list on the
same tick.

Measured on this machine (2026-08-16): `curl :9876/sessions | wc -c` =
**7843 bytes for 12 sessions**, i.e. ~2.6 KB/s per connected mobile client of
JSON that is mostly identical tick to tick — over cellular, and it is the same
data the desktop poll measured in F30 (6025 bytes for 9 sessions).

**Correctness consequence of the churn** — this is why it is filed rather than
left as a style note. `SessionCard` builds its status through
`useDebouncedStatus(() => props.session)` (`SessionCard.tsx:34`), whose entire
busy-hold state lives in component-local closure variables
(`useDebouncedStatus.ts:19-20`: `cooldownTimer`, `inBusyHold`) with an
`onCleanup` that clears the timer (`:55-57`). Recreating the component destroys
that state: the 2 s `BUSY_HOLD_MS` cooldown can never outlive a poll tick, so
the debounce the file exists to provide is capped at 3 s of wall clock and is
restarted from `deriveStatus` on every tick. The detail screen's copy
(`SessionDetailScreen.tsx:38`) is not affected — that component is not inside a
`<For>`.

The `pty-parsed` SSE handler at `useSessions.ts:114-118` already shows the
right shape: `prev.map(...)` rewrites only the matching session and preserves
every other reference. Reconciling the poll result the same way (or `reconcile`
from `solid-js/store` keyed on `session_id`) removes the churn and fixes the
debounce.

### F132 — the mobile client subscribes to `/events` with no type filter and receives all 27 event kinds (P2)

`ensureSse()` (`invoke.ts:111-128`) opens `new EventSource(`${origin}/events`)`
— **no `?types=` query**. `sse_events` (`sse_routes.rs:31-49`) treats an absent
`types` as "forward everything" (`:17-18`: *"When omitted, all events are
forwarded"*), so the server serializes and streams **all 27 `AppEvent` variants**
(`event_type_name`, `sse_routes.rs:86-114`) to every mobile client.

The mobile client registers exactly three (`useSessions.ts:104-120`):
`session-created`, `session-closed`, `pty-parsed`. The other 24 are dropped by
the browser — `attachSseEventType` (`invoke.ts:131-148`) only adds a native
listener for registered names — but only *after* they have crossed the network
and been framed by the browser's SSE parser.

Three of the unfiltered variants are not small: `AppEvent::UiTab` carries a
full `html` document (`sse_routes.rs:201-218`), `DiffTriageProgress` carries a
per-file classification list (`:241-259`), `GitHubIssuesUpdate` carries the
whole issue set for a repo (`:228-230`). Any of these fires on a desktop action
the phone user is not even looking at.

Two amplifiers: `event_payload` + `serde_json::to_string` run **once per
connected SSE client** (F9), and the mobile client is the connection most likely
to be on a metered link.

The contrast is inside the same repo: `subscribeEvents` in `transport.ts:2386-2388`
builds `/events?types=${encodeURIComponent(types)}` from its handler map. Only
`invoke.ts`'s shared `EventSource` skips it. The fix is to rebuild the URL when
the registered-type set changes, which is bounded — `listen()` already owns
`_sseListeners` and already re-attaches on reconnect (`:122-125`).

### F133 — the microphone meter costs a config file read, a JSON parse and three `stat`s, 13 times a second, on the IPC thread (P2)

`startAudioLevelPolling` (`stores/dictation.ts:150-157`) runs
`invoke("get_dictation_status")` on a **75 ms** interval — 13.3 calls/s — and
its callback reads exactly one field: `status.audio_level` (`:154`).

Each call executes `get_dictation_status` (`commands.rs:85-113`), which does:

| Work | Site |
|---|---|
| `configured_model()` → `get_dictation_config()` → `load_json_config` | `commands.rs:80-83`, `:614` |
| ↳ `path.exists()` (stat) + `fs::read_to_string` (open/read/close) + `serde_json::from_str` | `config.rs:152-162` |
| `model::model_exists()` → `path.exists()` + `path.metadata()` | `model.rs:85-92` |
| `model::model_size_bytes()` → `path.metadata()` | `model.rs:95-97` |
| `transcriber_arc.lock()`, `audio.lock()` | `commands.rs:91`, `:107-111` |

That is ~5 filesystem syscalls plus a file read plus a JSON deserialization,
13×/s, to fetch a value that is already sitting in an `AtomicU32`
(`audio.rs:46`, `:186-188`) and is loaded with a single `Relaxed` load. The full
`DictationStatus` (7 fields, 2 owned `String`s) is serialized across IPC each
time; six of the seven fields cannot change between ticks.

**Which thread this runs on.** `get_dictation_status` is a non-`async`
`#[tauri::command]`, which the macro compiles to `ExecutionContext::Blocking`
(`tauri-macros-2.6.3/src/command/wrapper.rs:126-128`, `:248-251`) — the body is
invoked inline from `handle_ipc_message` (`tauri-2.11.5/src/ipc/protocol.rs:185`),
i.e. on the thread that delivers the webview IPC message. On macOS that is the
`WKScriptMessageHandler` delegate, which wry constructs with a
`MainThreadMarker` (`wry-0.55.1/src/wkwebview/mod.rs:553-554`) — the main/UI
thread. This is **code-derived, not runtime-verified**; the syscall cost is real
regardless of which thread pays it.

Scope caveat: this is bounded to an active recording (`startRecording` →
`startAudioLevelPolling`, `stopRecording` → `stopAudioLevelPolling`,
`stores/dictation.ts:335`, `:363`), which is why chunk 4 marked the file clean
on the *gating* question. The per-tick cost is what was not examined. Dictation
is also off by default (`DictationConfig::default().enabled = false`,
`commands.rs:596-608`), so nobody who does not use dictation pays this.

Cheapest correct fix: a dedicated `get_audio_level` command returning `f32`
(reading only the atomic), or caching the parsed `DictationConfig` behind an
`ArcSwap` invalidated by `set_dictation_config`.

### F134 — whisper decoder state is reallocated for every streaming window (P2)

`WhisperTranscriber::transcribe` (`transcribe.rs:114-117`) calls
`self.ctx.create_state()` on **every** invocation. `create_state` is a thin
wrapper over `whisper_init_state`
(`whisper-rs-0.16.0/src/whisper_ctx_wrapper.rs:466-473`), which allocates the
KV self/cross caches and the GGML compute buffers sized by the model — for
`large-v3-turbo` (the default, `commands.rs:588-590`) those are the largest
per-inference allocations in the pipeline.

`transcribe` is called once per streaming window from `transcribe_window`
(`streaming.rs:226`), i.e. every `INITIAL_STEP_MS`→`MAX_STEP_MS` = **1.5 s to
3 s** of speech, for the whole session, plus once more for the final pass
(`commands.rs:434`). The `WhisperContext` itself is already correctly created
once and shared through `Arc<dyn Transcriber>` (`commands.rs:229-230`,
`:289-294`) — only the state is churned.

whisper.cpp's own `stream` example, which this loop's doc comment says it
follows (`streaming.rs:7-9`), creates a single state and reuses it across
windows. Hoisting the state into `WhisperTranscriber` behind a `Mutex` matches
that and matches the existing lifetime, since `shutdown()` already sequences the
streaming-thread join before dropping the transcriber (`mod.rs:49-57`).

No timing was measured — starting a recording was outside this pass's mandate.
The claim here is the allocation pattern, not a millisecond figure.

### F135 — the session recording is accumulated unbounded and re-transcribed in full at stop (P2)

`streaming_loop` keeps `all_audio: Vec<f32>` (`streaming.rs:131`) and appends
every drained sample to it (`:154`) for the lifetime of the recording. Nothing
trims it. The two 30 s caps in the pipeline bound something else:

- `MAX_SAMPLES` in `process_audio_chunk` (`audio.rs:246-250`) bounds the *capture
  ring*, i.e. how far the streaming thread may fall behind.
- `MAX_BUFFER_S` (`streaming.rs:39`, `:161`) bounds `step_buf`, i.e. the current
  window.

Neither bounds `all_audio`. At 16 kHz mono `f32` that is 64 KB/s: a 10-minute
dictation holds a **38 MB** contiguous `Vec` and, at stop, hands all of it to
`transcriber.transcribe(&all_audio, …)` (`commands.rs:434`) for a single
full-length whisper pass — 20 internal 30 s chunks of `large-v3-turbo`
inference, while the user waits and every streaming partial that already covered
that audio is discarded (`accumulated_partials` is only used for an accuracy log
line, `commands.rs:481-504`).

This is a deliberate design ("a single high-quality final transcription",
`streaming.rs:122-123`) and the growth is bounded by session length, not
unbounded in the leak sense — hence P2, not P1. It is recorded because the cost
is **super-linear in a user-visible way**: the longer the dictation, the longer
the stop-to-text latency, on a path where the incremental result already exists.
`spawn_blocking` (`commands.rs:396`) correctly keeps it off the tokio worker, so
the app does not freeze — the user just waits.

### F136 — every delivered log span is regex-rewritten on the main thread, and the whole screen is re-normalized per frame (P3)

`normalizeLogLine` (`logLine.ts:195-207`) runs `forceTextPresentation` — a
global `String.replace` against a 12-character class (`:177`) — over **every
span's text**, and does so on:

- `OutputView.tsx:53` — initial HTTP load (100 lines, measured 595 spans)
- `:56` and `:170` — **the whole screen, on every screen frame** (measured 32
  rows / 234 spans)
- `:164` and `:97` — incremental log lines and scroll-up chunks

The screen path is the one that repeats: 234 `replace()` calls per frame, up to
5 Hz, producing a new `String` for every span that contains one of the 12
characters (which for an agent status line is most of them — the class exists
precisely because agents use those glyphs).

Secondary note, not a cost: the function **mutates its input in place**
(`:201-203` assigns to `span.text` of the caller's object) and then returns it.
That is safe today because every caller passes freshly parsed JSON it owns, but
it means the function cannot be memoized or reused on a shared buffer, which is
the obvious way to stop redoing the screen every frame.

Per AGENTS.md rule D.15 this is text work Rust already has the data for: the
VS15 suffix could be applied once when the log frame is built
(`state.rs:3784-3798`), not once per client per frame.

### F137 — the output filter recomputes the plain text of every line on every keystroke and every frame (P3)

With the search bar open (`SessionDetailScreen.tsx:130-149`), `displayedLines`
(`OutputView.tsx:193-197`) runs `lineMatchesQuery` over the whole buffer. Per
line, `lineMatchesQuery` (`logLine.ts:155-158`) does
`lineText(line).toLowerCase().includes(query.toLowerCase())` — that is a
`spans.map()` array allocation, a `join("")`, and **two** `toLowerCase()`
allocations, with `query.toLowerCase()` recomputed inside the loop instead of
once.

For a full 532-line buffer that is ~532 intermediate arrays and ~1064 temporary
strings per evaluation, and the memo re-evaluates on every keystroke *and* on
every screen frame that changes `allLines()`. It also runs upstream of F130, so
a filtered view pays both.

Low severity because it is gated on the search overlay being open, which is a
deliberate, short-lived user action. The cheap fixes are hoisting
`query.toLowerCase()` out of the predicate and caching `lineText` on the
`LogLine` at normalize time. The correct fix is the existing backend search:
`POST /sessions/{id}/terminal/search-buffer` already does this in Rust
(`mcp_http/mod.rs`), and the mobile client does not use it.

### F138 — nothing in the mobile client is gated on page visibility (P3)

There is no `visibilitychange` listener, no `document.hidden` read and no
`pagehide` teardown anywhere in `src/mobile/**` (grep over `*.ts`/`*.tsx`,
excluding tests, returns only the `error`/`unhandledrejection` handlers in
`index.tsx` and the `visualViewport` handlers in `MobileApp.tsx:55-57`). So
three things keep running unconditionally:

| Timer / stream | Site | Period |
|---|---|---|
| session list poll | `useSessions.ts:99` | 3 s |
| version check `fetch("/api/version")` | `useVersionCheck.ts:52` | 60 s |
| log-mode WS (drives F14 server-side and F130 client-side) | `OutputView.tsx:151-176` | up to 5 Hz |

**Severity is P3 deliberately.** The two intervals are largely neutralised by the
platform: iOS Safari/standalone suspends timers and tears the socket down within
seconds of backgrounding, and Chrome freezes a backgrounded tab after ~5 min.
That mitigation is the OS's, not the app's, and it does not cover the case that
matters most: **screen on, app foregrounded, session detail open, user reading**.
There the 3 s poll refetches all 12 sessions (F131's 7843 bytes) even though the
open session's state is already arriving on the WS `state` frame
(`transport.ts:2253-2256` → `SessionDetailScreen.tsx:208`), and the WS keeps
delivering full screens at 5 Hz. Suppressing the poll while `showDetail()` is
true would remove a redundant transport, not just defer it.

### F139 — `start_dictation` reads the same config file three times and loads the model on the blocking command thread (P3)

`start_dictation` (`commands.rs:173-329`) calls `get_dictation_config()` —
which is an unconditional `exists()` + `read_to_string` + `serde_json::from_str`
(`config.rs:151-168`) — three times in one invocation: via `configured_model()`
at `:209`, then directly at `:255` and again at `:281`. Two of the three are
literally adjacent (`:255` for `config.device`, `:281` for `config.language`).

On the same command, and on the same thread, it also runs
`permission::request()` (which can block on a TCC dialog, `:202`),
`WhisperTranscriber::load()` (`:229` — reads the whole GGML model from disk;
`large-v3-turbo` is the default) and `AudioCapture::start_with_device` (`:257`,
which enumerates CoreAudio devices). Like F133 this is a non-`async`
`#[tauri::command]`, so it runs inline in `handle_ipc_message` on the
WKWebView message thread rather than on a worker — the frontend even has a
`loading` flag for it (`stores/dictation.ts:330`, `:351`), which suggests the
latency is known and just not moved off-thread.

P3 because it is once-per-recording-start on a feature that is off by default,
and the model load is skipped on subsequent starts (`:219` short-circuits when
the model has not changed). Filed because `#[tauri::command(async)]` is a
one-line change and the triple config read is free to remove.

---

## Not covered by chunk 10

Declared explicitly so a later chunk does not re-derive the boundary.

1. **`native_keys.rs` idle cost — examined and clean, no finding.** The
   `RcBlock` at `native_keys.rs:52-103` is invoked by AppKit on *every* keydown
   in the process, but the inactive path is: one `keyCode()` message send, one
   `u16` compare against `KVK_TAB`, and a linear scan of the 8-entry
   `EXTENDED_FUNCTION_KEYS` slice (`:29-38`, `:76`). No allocation, no emit, no
   lock, and `modifierFlags()` is only read once a code matches. There is
   exactly one `KeyDown` monitor, which the module header explicitly protects
   (`:16-17`). At human typing rates this is unmeasurable; it stays clean.
   `fn_key_monitor.rs` is the same shape on `FlagsChanged` and was already
   cleared in chunk 2b.

2. **`src/mobile/**` CSS / layout thrash.** `OutputView`'s `scrollToBottom`
   (`:123-130`) writes `scrollTop` inside a `rAF` and `fetchOlderLines`
   (`:99-106`) reads `scrollHeight` before a prepend and writes after — both are
   correct read/write ordering, but whether the 5 Hz `scrollTop` write forces a
   synchronous layout on iOS was not measured. Needs a device profile, not code
   inspection.

3. **`src/mobile/screens/ActivityScreen.tsx` data source.** The screen reads
   `activityStore.getActive()`, but nothing in the mobile bundle hydrates that
   store — the only writer reachable from mobile is `toastsStore.add`
   (`stores/toasts.ts:105`). Whether the Activity tab is therefore near-empty in
   practice is a product question, not an efficiency one; the screen's own
   10 s snapshot timer (`:60`) is correctly scoped to the mounted tab.

4. **Mobile bundle size / cold start.** `src/mobile/index.tsx` pulls in
   `stores/notes`, `stores/toasts`, `stores/activityStore`, `transport.ts` and
   `agents.ts`. How much desktop-only code the PWA ships is a chunk-8 (cold
   start) question and was not measured here.

5. **`useMobileNotifications`** does an O(n²) `current.find()` inside a loop over
   `prevStates.keys()` (`:100-101`). At 12 sessions on a 3 s tick that is 144
   comparisons per tick — noted, not filed.

6. **The audio callback under real load.** `process_audio_chunk` is clean by
   inspection (scratch buffers reused and test-asserted at `audio.rs:445-481`,
   `try_lock` so the RT thread never blocks, 30 s ring cap). How often the
   `try_lock` actually fails — i.e. how much audio is silently dropped, which the
   comment at `:192-194` calls "rare" — was not measured, and measuring it
   requires recording audio, which this pass was told not to do.

7. **No profiling was run.** Measured here: the `/sessions` payload (7843 B / 12
   sessions), the `format=log` payload (32 screen rows / 234 spans / 9789 B, and
   595 spans per 100 scrollback lines). Everything else is either an
   explicitly-labelled estimate derived from those measurements, or a structural
   claim with a `file:line`.

---

## Open questions

- **F130's frame rate depends on F14's change-detection.** The server hashes the
  styled spans and skips unchanged screens (`mcp_http/session.rs:1319-1331`). A
  Claude Code spinner changes the screen every ~120 ms, so 5 Hz is the right
  number *while an agent works* — but nobody has logged the actual `screen`
  frame rate a phone receives during a real session. One counter next to the
  hash comparison would settle whether F130 fires 5 times a second or 5 times a
  minute, and that decides whether it is P1 or P2.
- **Is the mobile client the only unfiltered `/events` consumer?** `invoke.ts`'s
  `listen()` is shared with browser-mode desktop (`isTauri() === false`), so a
  desktop user on the web UI also gets all 27 types. Confirming that — and
  deciding whether `transport.ts:subscribeEvents` and `invoke.ts:listen` should
  share one filtered EventSource instead of opening two — is a transport-layer
  call, not a mobile one.
- **F131's fix interacts with `SessionDetailScreen`.** `MobileApp.tsx:75-87`
  deliberately keeps `lastKnownSession` as a stale snapshot so the "Session
  ended" overlay can render. Any `reconcile`-based fix has to preserve that: the
  detail screen must keep reading a *value* that survives the session leaving
  the list.
- **F135's design intent.** Re-transcribing the full recording is stated as
  intentional. Whether the accuracy delta justifies the stop-latency for long
  dictations is a product decision — the accuracy log line
  (`commands.rs:493-504`) already records exactly the number needed to answer
  it (`match=%`), so the data may already exist in Boss's logs.
- **F133/F139 thread claim.** The chain macro → `ExecutionContext::Blocking` →
  `handle_ipc_message` → wry's main-thread-constructed script-message delegate is
  code-derived. A one-line `std::thread::current().id()` log in
  `get_dictation_status` compared against the setup thread would confirm it
  before anyone writes the `(async)` fix.
