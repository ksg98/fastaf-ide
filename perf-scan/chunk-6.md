# Chunk 6 — Plugin host API surface (partial)

Methodology, severity and verification ladder: see `performance_scan.md`.
Reserved finding range: **F50-F59**. Owner: main session. Date: 2026-08-16.

## Files evaluated

| File | Date | Verdict |
|---|---|---|
| `src/stores/statusBarTicker.ts` | 2026-08-16 | F50 |
| `src/components/StatusBar/TickerArea.tsx` (20-55) | 2026-08-16 | contributes to F50 |
| `src/components/StatusBar/StatusBar.tsx` (55-95) | 2026-08-16 | clean — exemplary, see note |
| `src/plugins/pluginRegistry.ts` (host `invoke` sites) | 2026-08-16 | clean (all user/event-driven, no polling) |
| `src/plugins/dashboardRegistry.ts` | 2026-08-16 | clean (54 lines, registry only) |
| `plugins/*/main.js` (timer inventory) | 2026-08-16 | contributes to F50 |

## Findings

### F50 — the status-bar ticker re-publishes its whole message list once per second, unconditionally (P3)

`src/stores/statusBarTicker.ts:76-80`, `scavenge()`, runs every `SCAVENGE_MS = 1_000`
while at least one ticker message exists, and calls
`setMessages((prev) => prev.filter(...))`. `Array.prototype.filter` **always**
returns a new array, so the signal is written with a fresh reference on every
tick even when nothing expired. Solid's default equality is `===`, so every tick
notifies.

Consumers are plain accessors re-run on notify, not memos:
`TickerArea.tsx:48` (`allMessages`) and `:29` (`rotation`, which additionally
calls `getAll().filter(...)` at `:39`). Net effect: a status-bar re-render every
second, forever, on the same main thread that paints the terminal.

`rotate()` (`statusBarTicker.ts:83-85`) adds a second unconditional wake every
`ROTATION_MS = 5_000` — it bumps `rotationIndex` even when there is exactly one
message and rotation is a no-op.

How long "while at least one message exists" lasts in practice: the installed
plugins keep the list non-empty most of the time —
`plugins/at-capacity-retry/main.js:184` refreshes its ticker every 5 s
(`tickerIntervalMs: 5 * 1000`), `plugins/build-cleaner/main.js:608` sets one per
poll, and the built-in claude-usage ticker is referenced as a permanent resident
(`StatusBar.tsx:272`, `TickerArea.tsx:39`). So the 1 Hz churn should be assumed
always-on, not occasional.

Fix is local and cheap: return `prev` unchanged when nothing was filtered out,
and skip `rotate()` when `activeMessages().length < 2`. Estimated cost is small
per tick — this is P3 because of its permanence, not its amplitude; no
measurement was taken.

## Clean, worth recording

`StatusBar.tsx:63-88` is the pattern the rest of the codebase should copy: a
**single** shared 1 s timer, started only when `needsTicking()` (a merged PR or
an active rate limit), self-stopping inside its own callback the moment the
condition clears, plus `onCleanup`. It is the counter-example that makes F50 a
finding rather than an accepted cost.

Plugin poll cadences were inventoried and are sane: `build-cleaner` 1 h
(`main.js:63`), `claude-wakeup` 5 s (`main.js:32`, a cheap in-memory check),
`at-capacity-retry` 5 s ticker refresh, `cache-keepalive` interval-driven. None
of them poll the filesystem or IPC at a rate worth flagging.

## Not covered

Chunk 6 was a time-boxed pass alongside four parallel chunks. Left open:

- **`host.openPanel` / dashboard iframe path** — `srcdoc` payload size, whether
  updating a panel re-serializes the whole HTML, `postMessage` frequency between
  the SDK inside the sandbox and the host.
- **Tier 3b/3d/3i host APIs** (git read, panel UI, file tail): fan-out and
  payload size per call not analysed.
- **`plugin_fs` watch registration** (`plugin_unwatch` at `pluginRegistry.ts:564`)
  — one watcher per plugin per path vs a shared watcher, not checked.
- **Plugin load cost at startup** — `register_loaded_plugin` per plugin
  (`pluginRegistry.ts:733`), module evaluation, and whether disabled plugins
  still pay anything.
- **Activity Center item churn**: `addItem`/`updateItem` frequency from the
  installed plugins and whether the Activity Center re-renders per item.

## Open questions

- Is the claude-usage ticker message genuinely permanent, or only present while a
  Claude agent tab is active? `StatusBar.tsx:272` filters it by
  `agentType() === "claude"`, which suggests it is registered regardless of the
  active tab — but the plugin that publishes it was not read. This determines
  whether F50's 1 Hz churn is always-on or session-dependent.
