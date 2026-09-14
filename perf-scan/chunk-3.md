# Chunk 3 — Terminal grid frame path (produce → transport → decode → paint)

Findings F20-F29. Format mirrors `performance_scan.md`. Read-only pass; no code
was modified.

**Assumed viewport for every size estimate below: 200 cols × 50 rows.** Stated
explicitly because every byte count in this chunk scales linearly with both. All
sizes are *derived from the wire format in code*, not measured, unless marked
otherwise.

---

## Files evaluated

| File | Area read | Verdict |
|---|---|---|
| `src-tauri/src/pty.rs` (frame ticker 6860-7052) | produce/coalesce/backpressure | F24, F26, F27, F28 |
| `src-tauri/src/pty.rs` (`grid_send_min_interval_ms` 6773-6784) | send-rate floors | clean (unit-tested, correct) |
| `src-tauri/src/pty.rs` (reader loop 7054-7172) | dirty flag + vt lock | contributes to F26 |
| `src-tauri/src/pty.rs` (`ChunkProcessor` vt section 4290-4404) | lock scope on intake | F26 |
| `src-tauri/src/pty.rs` (`send_grid_frame` / subscribe / ack / request 9421-9498) | transport + gate | F20, F21, F27 |
| `src-tauri/src/pty.rs` (`terminal_scroll*`, `terminal_styled_rows` 9527-9576) | scroll + row cache feed | F20 |
| `src-tauri/src/pty.rs` (`apply_resize` grid path 7930-8000) | resize frame | clean |
| `src-tauri/src/terminal_grid.rs` (`serialize_dirty_rows` 1552-1697) | frame diffing/encoding | F23, F24 |
| `src-tauri/src/terminal_grid.rs` (`serialize_styled_range` 1720-1751, `encode_cell`/`encode_col_count` 344-400) | shared cell encoder | F23 |
| `src-tauri/src/mcp_http/session.rs` (`handle_ws_grid_session` 1385-1499) | browser transport | F27 |
| `src-tauri/src/state.rs` (`grid_watch`/`grid_frame_*` 1305-1311, `GRID_SCROLLBACK` 3608) | channel wiring | F24, F27 |
| `src-tauri/patches/alacritty_terminal/.../term/mod.rs` (`LineDamageBounds` 139-160, `scroll_up_relative` 959-989) | damage source | F23, F24 |
| `tauri-2.11.5/src/ipc/mod.rs` (`IpcResponse` blanket impl 181-189), `ipc/channel.rs` (128-185) | Channel encoding | F20 |
| `src/components/Terminal/CanvasTerminal.tsx` (`onFrame` 1343-1547) | decode/merge/ack | F20, F21, F22, F25, F27 |
| `src/components/Terminal/CanvasTerminal.tsx` (`paintFrame`/`repaintOverlay` 446-806) | overlay repaint | F29 |
| `src/components/Terminal/CanvasTerminal.tsx` (`rowToText` 859-866, `updateSuggestOverlay` 877-946) | per-row text | F25 |
| `src/components/Terminal/CanvasTerminal.tsx` (`scanRowForLinks` 1560-1589, `verifyVisibleFileLinks` 1595-1660) | link scan | F25 |
| `src/components/Terminal/CanvasTerminal.tsx` (smooth scroll 1094-1212, 1275-1341) | cache render + prefetch | F22, F25 |
| `src/components/Terminal/CanvasTerminal.tsx` (IntersectionObserver 2036-2084) | visibility flow control | F21 |
| `src/components/Terminal/CanvasTerminal.tsx` (effects 3009-3030) | Solid reactivity | clean (2 effects, neither per-frame) |
| `src/components/Terminal/canvasTerminalUtils.ts` (`decodeBinaryFrame` 189-285, `decodeStyledRange` 307-350) | decode allocs | F29 |
| `src/components/Terminal/gridRenderer.ts` (`paintRow` 1205-1324, `paintGrid` 1326-1347) | canvas paint | F29 |
| `src/components/Terminal/canvasTerminalTransport.ts` | both transports | F20, F27 |
| `src/components/Terminal/canvasTerminalScroll.ts` | row cache lifecycle | F22 |
| `src/components/Terminal/glyphCache.ts` | shared metrics | clean (metrics memo, no per-frame `measureText`) |
| `src/components/Terminal/frameTiming.ts`, `src/utils/perfTrace.ts` | instrumentation gating | clean (dormant unless `perfDebug`) |
| `src/components/TerminalArea.tsx` (145-178), `src/styles.css` (103-114) | tab mounting model | F21 |

---

## Findings

### F20 — every grid frame crosses the desktop IPC as a JSON array of decimal numbers (P1)

`subscribe_terminal_grid` (`src-tauri/src/pty.rs:9450-9462`) registers a
`tauri::ipc::Channel<Vec<u8>>`, and `send_grid_frame` (`pty.rs:9440`) pushes the
binary frame through it. `Channel::send` requires `TSend: IpcResponse`
(`tauri-2.11.5/src/ipc/channel.rs:292-297`), and the only impl that matches
`Vec<u8>` is the blanket `impl<T: Serialize> IpcResponse for T`
(`tauri-2.11.5/src/ipc/mod.rs:181-189`), whose body is
`serde_json::to_string(&self)` producing `InvokeResponseBody::Json`. The
`From<Vec<u8>> for InvokeResponseBody` → `Raw` conversion
(`ipc/mod.rs:112-116`) is a *different trait* and is never reached.

So a 110 KB binary frame is turned into a string like `"[26,0,50,0,97,0,0,0,…]"`
before it leaves Rust. Because that string is well over
`MAX_JSON_DIRECT_EXECUTE_THRESHOLD = 8192` (`ipc/channel.rs:37`), it takes the
`_ =>` arm at `channel.rs:167-181`: the body is parked in `ChannelDataIpcQueue`
and the webview is told to `invoke('plugin:__TAURI_CHANNEL__|fetch', …)` — an
extra full IPC round trip per frame — after which JS receives a `number[]`, not
an `ArrayBuffer`.

**This is not inference — the frontend says so.** `TauriTransport.registerChannel`
types the callback `(data: ArrayBuffer | number[])` and converts with
`new Uint8Array(data).buffer` (`canvasTerminalTransport.ts:49-51`), and the
sibling command with the identical `Vec<u8>` return type is consumed as
`(await invokeRef("terminal_styled_rows", …)) as number[]` with an explicit
`if (!Array.isArray(res)) return` guard (`CanvasTerminal.tsx:1193-1200`). The
browser WS path, by contrast, gets real binary (`ws.binaryType = "arraybuffer"`,
`canvasTerminalTransport.ts:138`) — so **the desktop app pays a cost the PWA does
not.**

Cost per full-screen frame (estimate, derived from the wire format at
`terminal_grid.rs:1536-1551`, not measured):

| Stage | Work |
|---|---|
| frame bytes | `26 + 50 × (4 + 200 × 11)` = **110,226 B** |
| `serde_json::to_string` | ~2.2-2.9 chars/byte (counted per field: 9 chars for the 4 char-bytes, 12 for fg, 6 for a default bg, 4 for attrs = 31 chars per 11-byte cell) → **~250-320 KB string** |
| transport | that string, plus one `webview.eval` + one `invoke` round trip |
| JS parse | a 110,226-element `number[]` (≈880 KB as a SMI array) |
| JS convert | `new Uint8Array(arr)` walks all 110,226 elements |

At the sustained-animation floor of ~30 fps (`pty.rs:6775`) that is roughly
**7-9 MB/s of JSON per actively-rendering session**, allocated in Rust, parsed by
the JS engine, and copied — to reconstruct bytes that already existed.

`terminal_styled_rows` (`pty.rs:9565-9576`) has the same defect on the
scroll-prefetch path: `ROW_CACHE_CHUNK = 64` rows × 2206 B ≈ 141 KB per chunk,
and `ensureCacheBand` (`CanvasTerminal.tsx:1171-1182`) requests a band of chunks
per gesture.

The fix is small and local: return `tauri::ipc::Response::new(frame)` /
`Channel<tauri::ipc::Response>` so the body is `Raw`, which the same
`channel.rs:167` arm delivers as an `ArrayBuffer` with no JSON at any point. Both
frontends already accept `ArrayBuffer`.

### F21 — a hidden terminal runs the entire frame pipeline and acks first, so flow control never engages (P1)

`TerminalArea.tsx:145-178` renders **every** terminal via `<For>`; `.terminal-pane`
is `display: none` until `.active` (`src/styles.css:103-114`). Nothing unmounts,
so `unsubscribe_terminal_grid` is never called for a background tab and Rust keeps
producing and sending frames for all of them. Boss's live instance right now has
**9 sessions** (measured: `GET :9876/sessions`), at most one of which is visible.

The `IntersectionObserver` at `CanvasTerminal.tsx:2036` is introduced by the
comment *"Flow control: stop acking frames when hidden, request full frame on
show"*. It does not do that. `onFrame` acks **unconditionally on line 1352**,
before any visibility test; the `if (hidden) return` is at **line 1542**, and all
it skips is `scheduleRepaint()` and `scheduleFileLinkVerification()`. A hidden
terminal therefore still pays, per frame:

- the Rust `serialize_dirty_rows` + the whole of F20's JSON round trip;
- `decodeBinaryFrame` — 4 typed arrays per row (`canvasTerminalUtils.ts:242-245`);
- `scanRowForLinks` for every row in the frame (`CanvasTerminal.tsx:1445`) —
  see F25;
- `rowCache.set` per row (`:1511`) — see F22;
- the immediate ack, which **fully reopens the backpressure gate**, so the ticker
  sends the next frame at the full rate.

It gets worse: `hidden` also clears `rowMap` (`:2078`), so every subsequent frame
is a *partial* merge into an empty map, which calls `scheduleReconcile()`
(`:1495`). `shouldFireReconcile` (`canvasTerminalUtils.ts:127`) checks
`alive`/`isScrolling`/`scrollPosF`/`displayOffset` — **not `hidden`** — so an
invisible terminal actively fires `terminal_request_frame` up to once per second
(`RECONCILE_MAX_WAIT_MS = 1000`), each one forcing `grid_force_full_damage()`
(`pty.rs:9484`) — the single most expensive frame shape — to be built,
JSON-encoded, shipped, decoded, and thrown away.

Only the canvas paint is actually saved. The cheap correct version is one early
`if (hidden) return;` before the ack (leave the gate closed and let the ticker's
existing 500 ms force-reset idle the session), plus a `hidden` term in
`shouldFireReconcile`.

### F22 — `rowCache` has no size check on the path that fills it every frame (P1)

`onFrame` seeds the smooth-scroll row cache on **every frame, for every row**:

```ts
// CanvasTerminal.tsx:1509-1513
if (scroll.position == null || frame.displayOffset === Math.floor(scroll.position)) {
    for (const row of frame.rows) {
        rowCache.set(frame.historyBase + frame.historySize - frame.displayOffset + row.index, row);
    }
}
```

`scroll.position` is `null` at rest, so the guard is always true during normal
output. The key is the *eviction-stable all-time* index — deliberately monotonic
(`terminal_grid.rs:1699-1714`) — so a line that scrolls in gets a **new** key and
never overwrites an old entry.

The `ROW_CACHE_MAX = 6000` trim exists only inside `fetchChunk`
(`CanvasTerminal.tsx:1203-1205`), which is reached only from `ensureCacheBand`
← `renderCachedBase` ← `renderSmooth` — i.e. **only while a smooth-scroll gesture
is running**. `seedCacheFromCurrentFrame` (`:1278`) also writes with no check.

Four events clear the cache (`scroll.clearCache()`): a resize/remeasure
(`:420` — which also fires on hidden→visible), entering a smooth-scroll gesture
(`:1286`), an alt-screen swap (`:1375`), and the `fetchChunk` overflow (`:1204`).
A terminal that stays the active tab, is never resized, is never wheel-scrolled
and does not toggle alt screen hits none of them.

Footprint per cached row (estimate, from `DecodedRow` at
`canvasTerminalUtils.ts:25-38`): `Uint32Array(200) × 3 + Uint8Array(200)` ≈
**2.6 KB**. A build log emitting 100 lines/s therefore adds ~260 KB/s to a Map
that nothing trims. This is the only genuinely unbounded structure found in the
chunk-3 path; everything else (`fileLinkCache` 500 FIFO at `:1653-1656`,
`detectedLinks` keyed by viewport row, `requestedChunks`) is bounded.

### F23 — alacritty reports damaged *columns*; the serializer throws them away and ships the whole row (P2)

`TermDamage::Partial` yields `LineDamageBounds { line, left, right }`
(`src-tauri/patches/alacritty_terminal/src/term/mod.rs:139-148`). The serializer
keeps only the line number:

```rust
// terminal_grid.rs:1608-1610
TermDamage::Partial(iter) => iter.map(|b| b.line).filter(|&l| l < num_lines).collect()
```

and then unconditionally emits every column of that row
(`terminal_grid.rs:1684-1688`), because `encode_col_count`
(`terminal_grid.rs:344-354`) always returns `num_cols` (only OR-ing in the
wrap flag) — there is no left offset and no trailing-blank trim in the wire
format at all.

Concretely: a spinner advancing one glyph damages one line, columns *k..k+1*.
That is ~11 useful bytes. We ship **2,204 bytes** (a 200-column row), which F20
then inflates to ~6 KB of JSON. A one-character keystroke echo is the same shape.
Trailing blanks are the other half of the waste — an 80-character prompt line in a
200-column terminal ships 120 fully-encoded empty cells.

Verified the consumer before calling it waste: `paintRow`
(`gridRenderer.ts:1205-1233`) already computes `lastVisibleCol` itself and skips
empty trailing cells, and `rowMap` merges by row index — so a column-ranged row
would need a wire change (a per-row `col_start`, plus a partial-row merge in
`onFrame`), not just a serializer change. The information loss is nonetheless
unambiguous, and the header already carries a per-row `col_count` field to hang it
on.

### F24 — one line scrolling into history forces a full-screen frame, for the first 10,000 lines of every session (P2)

`serialize_dirty_rows` marks the grid fully damaged whenever the viewport
descriptor moves:

```rust
// terminal_grid.rs:1596-1602
let viewport_changed = self.last_frame_display_offset != Some(display_offset)
    || self.last_frame_history_size != Some(history_size)
    || self.last_frame_screen_lines != Some(num_lines)
    || self.last_frame_columns != Some(num_cols);
if viewport_changed { self.term.mark_fully_damaged(); }
```

`history_size` increments on **every** line that scrolls off the top, until the
scrollback cap. That cap is `GRID_SCROLLBACK = 10_000` (`state.rs:3608`). So for
the first 10,000 scrolled lines of a session — which is most sessions — *any*
frame that contains a newline at the bottom of the screen is a full-screen frame:
110 KB, ~275 KB of JSON (F20), 50 rows re-decoded and repainted.

The full damage itself is not the bug — the rowMap is keyed by viewport row, so
after a scroll every row genuinely has new content, and alacritty already calls
`mark_fully_damaged()` in `scroll_up_relative`
(`patches/…/term/mod.rs:988`), making this branch redundant for that case rather
than wrong. The bug is structural: **the wire protocol has no "scrolled by N"
opcode**, so a 1-line scroll cannot be expressed as anything smaller than a full
screen. A `scroll_delta: i16` in the header (frontend re-keys `rowMap` by
`index - delta` and asks only for the newly exposed rows) collapses the common
case from 50 rows to 1.

### F25 — the same row is stringified 2-3 times per frame, by `+=` concatenation (P2)

```ts
// CanvasTerminal.tsx:859-866
function rowToText(row) {
    let text = "";
    for (let ci = 0; ci < row.count; ci++) {
        const cp = row.codepoints[ci];
        text += cp === 0 ? " " : String.fromCodePoint(cp);
    }
    return text;
}
```

200 `String.fromCodePoint` allocations plus 200 rope appends per call, and the
result is not memoized on the `DecodedRow` it was derived from. Per frame it is
called from:

1. `scanRowForLinks` — once per row in the frame, from `onFrame`'s merge loop
   (`:1442-1446`). Ungated: no throttle, no visibility check (see F21). Each call
   also runs a global `WEB_URL_RE.exec` loop over the text and a
   `fileLinkCache.get(text)` — a Map lookup **keyed by the full row string**, so
   the 200-char string is hashed as well as built.
2. `updateSuggestOverlay` — again for every dirty row (`:892`), or for all
   `numRows` rows when `fullRepaintNeeded` (`:918-919`), plus two regex tests each.
3. `verifyVisibleFileLinks` — all rows again (`:1607`). This one *is* throttled
   (150 ms, `canvasTerminalLinks.ts:52-58`), so it is the least of the three.

During a smooth-scroll gesture `renderCachedBase` adds a fourth site
(`:1136-1140`): a full `numRows` `rowToText` sweep **per rAF**, i.e. 50 strings ×
60 fps = 3,000 row stringifications/s, on top of the `{ ...cached, index: r }`
object spread per row per frame (`:1110`).

This is also an architecture-rule item (AGENTS.md "all business logic in Rust"):
URL/file-path detection is pure text work with no DOM dependency, and Rust
already owns the cells. It is the same shape as F3 (watcher regexes on the main
thread) one layer down.

### F26 — the vt mutex is held across frame serialization, contending with PTY byte intake (P2)

Both sides of the PTY take the same `vt_log_buffers` mutex and both hold it
across real work:

- **Ticker**: `let mut g = vt.lock(); … let frame = g.serialize_dirty_rows(); drop(g);`
  (`pty.rs:7026-7036`). On full damage that is 50 × 200 = 10,000 `encode_cell`
  calls, each resolving two colors and pushing 11 bytes
  (`terminal_grid.rs:359-400`).
- **Reader**: `let mut vt = vt_log.lock();` then `vt.process(…)`, the chrome
  cutoff (which builds a `Vec<&str>` over the screen), `detect_agent_screen_activity`,
  and `vt.screen_rows()` — a full-screen clone into owned `String`s — all inside
  the guard (`pty.rs:4313-4390`).

So every 16-33 ms the ticker blocks byte intake for the duration of a full-screen
encode, and every chunk blocks the ticker for the duration of a VT parse plus a
screen clone. The two threads are `raise_thread_for_interactive_io()`-boosted
specifically because this path is latency-critical (`pty.rs:6879`, `:7056`), which
makes the shared lock the remaining serialization point. Both call sites correctly
drop the guard before `send_grid_frame`, so the IPC is *not* under the lock —
credit where due.

Secondary, same function: `send_grid_frame` (`pty.rs:9427-9434`) does two
`state.grid_watch.get(session_id)` DashMap lookups where one would do, and clones
the whole frame `Vec` for the watch channel — the clone is only paid when a WS
client is attached, so this is a small structural nit, not a hot cost on desktop.

### F27 — the frame-delivery gate is unsound on both transports (P2)

**Desktop.** `grid_frame_in_flight` is a bare `AtomicBool` with no frame id.
`ack_terminal_frame` (`pty.rs:9471-9475`) clears it unconditionally. The ticker
force-resets it after `MAX_IN_FLIGHT_MS = 500` and sends the next frame
(`pty.rs:6947-6972`). So when the frontend is *actually* slow — the only situation
the gate exists for — the sequence is: force-reset → send frame N+1 → the late ack
for frame N arrives → gate opens again → frame N+2 sent immediately. The frontend
receives a burst precisely when it is behind. `MAX_STUCK_BEFORE_PAUSE = 3` +
`STUCK_PAUSE_MS = 1000` is the mitigation, and it only engages after three such
cycles.

**Measured** (`GET :9876/logs`, Boss's live instance, last 1000 lines): five
`grid_frame_in_flight stuck, force-resetting` warnings, `elapsed_ms` 502-510,
across three different session ids. Each one is ≥500 ms of a terminal not
updating.

**Browser.** `handle_ws_grid_session` (`mcp_http/session.rs:1394-1441`) subscribes
to a `tokio::sync::watch` and documents *"latest-frame-wins: slow clients
automatically skip intermediate frames"*. But the frames on that channel are
**deltas** — only the rows alacritty marked dirty. Skipping one silently strands
whatever rows it carried; the client's `rowMap` shows stale content with no error.
There is no ack on this path at all (`session.rs:1484-1487`: *"No ACK needed —
watch channel handles backpressure naturally"*). This is the A.5 pattern from the
methodology: a drop mechanism applied to a stateful reassembly stream.

The saving grace, and the reason this is P2 not P1: the frontend's
`scheduleReconcile` self-heal (`CanvasTerminal.tsx:1049-1075`) pulls a full frame
within `RECONCILE_MAX_WAIT_MS = 1000` whenever the terminal is at rest at offset
0 — which is exactly the state a browser client is normally in. So the corruption
window is bounded at ~1 s. It is not bounded while scrolled back or mid-gesture,
because `shouldFireReconcile` refuses to fire there.

### F28 — one dedicated 16 ms polling thread per session, running whether or not anyone is subscribed (P3)

`spawn_pty_session` starts a `std::thread` per session whose entire body is
`sleep(16 ms)` + `ticker_dirty.swap(false)` (`pty.rs:6876-6907`). It runs for the
life of the session regardless of whether a terminal is mounted, visible, or
subscribed. With the 9 sessions measured on Boss's instance that is **~560 timer
wakeups/s at complete idle** just to read an atomic, plus the per-session reader
and silence-timer threads.

Two consequences beyond the wakeups:

1. **No subscriber check before the expensive part.** When the ticker sees dirty
   it takes the vt lock and runs `serialize_dirty_rows()` (`pty.rs:7026-7036`)
   *before* `send_grid_frame` discovers there is no `grid_channels` entry and no
   watch receiver and drops the result on the floor (`pty.rs:9424-9441`). A
   session whose tab was closed but whose PTY is still running (agent working in a
   detached/unmounted pane) pays a full encode per dirty tick for nothing. The
   check is two DashMap lookups and belongs at the top of the tick.
2. The work is per-session where a single global ticker scanning
   `grid_frame_dirty`, or a condvar the reader signals, would do — methodology
   C.12/C.13.

### F29 — decode and paint allocate per row per frame; no run or glyph batching (P3)

**Decode** (`canvasTerminalUtils.ts:242-260`): four typed arrays per row
(`Uint32Array ×3 + Uint8Array`) = 200 allocations for a 50-row frame, ~6,000/s at
30 fps, all short-lived. Cells are read with seven separate `DataView` calls each
(`getUint32` + 6 × `getUint8`) — 110,000 `DataView` calls for a full frame. A
single `Uint8Array` view over the buffer with manual shifts, or reusing per-row
arrays across frames when `count` is unchanged, removes both.

**Paint** (`gridRenderer.ts:1205-1324`): `paintRow` makes four passes over
`row.count` (backward `lastVisibleCol` scan, backgrounds, text, decorations). The
background pass emits one `fillRect` per cell with no merging of adjacent
identical backgrounds — a full-width colored band is 200 `fillRect` calls plus 200
`fillStyle` assignments. The text pass calls `String.fromCodePoint(cp)` and
`fillText` **per glyph** (`:1304-1305`); the deliberate comment at `:1235-1237`
explains why glyphs are not batched into runs (sub-pixel drift from the rounded
`cellWidth`), which is a legitimate correctness reason — but it also means there
is no glyph atlas anywhere in this renderer, so every visible character is
re-shaped and re-rasterized on every repaint of its row.

`repaintOverlay` (`CanvasTerminal.tsx:457-466`) additionally clears and rebuilds
the *entire* overlay canvas on every frame, including a walk of
`term.commandBlocks` (bounded at `MAX_BLOCKS = 500`) in `paintGutterMarkers`
(`:615-627`) and a `find` per folded block in `paintFoldedBlocks` (`:637`). These
are Solid store proxy reads inside a rAF callback — untracked, so no reactivity
hazard (**question 5 answers clean**: the component has exactly two
`createEffect`s, `:3014` and `:3019`, and neither is frame-driven; `currentFrame`
is a deliberate plain ref) — but each property access still goes through the store
proxy. `octx.measureText` (`:686`) is per-frame only while Ctrl+Cmd is held
(`blockTimestampsVisible`, `:2196`), so it is not a standing cost.

Finally, a stale-comment hazard of the F7 kind: `gridRenderer.ts:1-8` states the
module is *"used by BOTH the main thread … and the render worker (OffscreenCanvas)"*
and `frameTiming.ts:13-21` documents a `"sched"` metric as *"worker-mode only"*.
**No worker exists** — `grep -rn "new Worker\|OffscreenCanvas" src/` returns only
`CommitGraph.tsx` and these type unions. All grid painting is on the WebView main
thread. A future reader will look for a worker that was never landed.

---

## Not covered by chunk 3

- **Selection/search/link *interaction* handlers** (mouse drag, `terminal_search`,
  `terminal_get_logical_line`, clipboard). Read only where they are called from
  the repaint path; their own IPC cost was not analysed.
- **`canvasTerminalBindings.ts`, `canvasTerminalTouch.ts`, `kittyKeyboard.ts`,
  `terminalInput.ts`** — the input half of the loop. `stamp_input_ms` was read
  only as an input to the ticker's throttle.
- **Resize/reflow cost** (`resize_with_shell_state`, history reflow). The frame
  it produces was traced; the reflow itself was not.
- **`suggestOverlay.ts` pattern matching** (`SUGGEST_ANCHOR_RE`, `isSuggestBlock`,
  `continuationRowsAfterSuggest`) — counted as call sites in F25, not opened.
- **`mcp_http/session.rs` log-mode WS and the ring catch-up** — chunk 2b's area;
  only the grid-mode handler was read.
- **`terminal_grid.rs` outside the two serializers** — `process`, reflow, search,
  scrollback readers. Only `serialize_dirty_rows`, `serialize_styled_range` and
  the shared cell encoder were audited.
- **No profiler was run.** The only measured numbers in this chunk are the five
  `grid_frame_in_flight stuck` warnings with their `elapsed_ms` (F27) and the live
  session count of 9 (F21). Every byte count and every frame-rate figure is an
  estimate derived from the wire format and the ticker constants, and is labelled
  as such at its use site.

---

## Open questions

- **Is the ack round trip needed at all?** With the ticker as the sole damage-driven
  sender and a 16 ms floor already in place, the gate's only job is to detect a
  wedged WebView. A monotonic `last_painted_seq` piggybacked on the next
  `terminal_request_frame` / scroll command would give the same detection with zero
  dedicated IPC per frame. Not filed as a finding because I did not establish that
  the gate is *removable* without reintroducing the ack→flush→ack saturation the
  comment at `pty.rs:9464-9468` says it fixed.
- **How tight is alacritty's column damage in practice?** F23 assumes
  `LineDamageBounds.left/right` are narrow for a spinner tick. The fork's
  `damage_from_point`/`damage_cursor` call sites were not audited, and a
  conservative widening (e.g. whole row on any cursor move) would shrink the win
  substantially. Worth measuring before designing the wire change.
- **Does `ChannelDataIpcQueue` leak on teardown?** F20's large-payload path parks
  the body in a Rust-side map keyed by `data_id` and relies on the JS `fetch` to
  drain it (`tauri-2.11.5/src/ipc/channel.rs:169-180`). If a webview is destroyed
  or a tab unsubscribes with a fetch in flight, I did not confirm the entry is
  reclaimed. Bounded in practice by the in-flight gate (one frame outstanding),
  so at most one stale entry per session — noted, not filed.
- **`updateKeyboardLift` on touch devices** calls
  `containerRef.getBoundingClientRect()` from `onFrame` (`CanvasTerminal.tsx:1490`
  → `:3005`), i.e. a forced layout per frame while the soft keyboard is open. It
  early-returns on desktop (`:2990`), so this is mobile-only and I could not
  exercise it. Flagged for whoever owns the mobile path.
- **F24's 10,000-line window**: I did not verify what fraction of real sessions
  exceed `GRID_SCROLLBACK` and therefore stop paying the per-newline full frame.
  An agent in alt screen has its own history budget (`alt_scrolling_history`,
  `terminal_grid.rs:447`) that is wiped on every alt enter/exit, so alt-screen
  agents likely never reach the cap and pay it for the whole session — plausible,
  not proven.
