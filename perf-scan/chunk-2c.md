# Chunk 2c — AI conversation engine, agent tools, knowledge write path, diff triage engine

Scope: the areas chunk 2b declared "Not covered" — `run_conversation` itself,
`ai_agent/tools.rs` dispatch + implementations, the `knowledge.rs` **write**
path (F6 owns the read/startup path), and `diff_triage.rs` beyond its 6 emit
sites. Same methodology, severity scale and verification ladder as
`performance_scan.md`. Finding ids F110-F119. Read-only pass; no code was
modified and no AI conversation was started on the live instance.

---

## Files evaluated

| File | Chunk | Date | Verdict |
|---|---|---|---|
| `src-tauri/src/ai_agent/conversation_engine.rs` (`run_conversation` 618-1029) | 2c | 2026-08-16 | F112, F114 |
| `src-tauri/src/ai_agent/conversation_engine.rs` (`drain_stream` 556-613) | 2c | 2026-08-16 | clean (50 ms cancel poll, no per-chunk alloc beyond the event) |
| `src-tauri/src/ai_agent/conversation_engine.rs` (`assemble_context` 252-259, `build_base_system_prompt` 201-246) | 2c | 2026-08-16 | F114 |
| `src-tauri/src/ai_agent/context.rs` (`build_knowledge_section`, `build_cross_session_section`) | 2c | 2026-08-16 | F114; F6 owns `summarize_for_repo` |
| `src-tauri/src/ai_chat.rs` (`assemble_terminal_context` 606-672, `assemble_terminal_context_for_engine` 173-194) | 2c | 2026-08-16 | F114 |
| `src-tauri/src/ai_chat.rs` (`assemble_block_context` 542-574, `format_command_block` 576-603) | 2c | 2026-08-16 | F119 |
| `src-tauri/src/ai_agent/knowledge.rs` (`flush_dirty` 577-597, `persist` 453-460, `spawn_persist_task` 551-567) | 2c | 2026-08-16 | F110 |
| `src-tauri/src/ai_agent/knowledge.rs` (`record` 133-185, `sanitize_snippet` 25-48) | 2c | 2026-08-16 | F111 |
| `src-tauri/src/config.rs` (`persist_atomic` 211-246) | 2c | 2026-08-16 | contributes to F110 (fsync per write — correct, but per-write) |
| `src-tauri/src/state.rs` (`record_outcome` 2580-2620) | 2c | 2026-08-16 | contributes to F110 |
| `src-tauri/src/pty.rs` (`record_inferred_outcome_if_no_osc133` 3146-3188, call site 3472) | 2c | 2026-08-16 | F110, F119 |
| `src-tauri/src/ai_agent/tools.rs` (`dispatch`/`dispatch_inner` 2396-2483) | 2c | 2026-08-16 | F115, F118 |
| `src-tauri/src/ai_agent/tools.rs` (`redact_secrets` 461-545) | 2c | 2026-08-16 | F111 |
| `src-tauri/src/ai_agent/tools.rs` (`exec_search_files` 1678-1810, `exec_list_files` 1596-1675) | 2c | 2026-08-16 | F115 |
| `src-tauri/src/ai_agent/tools.rs` (`exec_read_file` 1284-1373, `exec_run_command_inner` 2015-2176) | 2c | 2026-08-16 | F111, F115 |
| `src-tauri/src/ai_agent/tools.rs` (`exec_search_code` 1817-1863, `extract_bm25_snippet` 1866-1891) | 2c | 2026-08-16 | F118 |
| `src-tauri/src/ai_agent/tools.rs` (`exec_get_command_history`/`explain_last_failure`/`get_error_fixes` 963-1041) | 2c | 2026-08-16 | clean (bounded, lock held briefly) |
| `src-tauri/src/ai_agent/tools.rs` (`tool_definitions` 69-450) | 2c | 2026-08-16 | contributes to F112 |
| `src-tauri/src/ai_agent/sandbox.rs` (`is_binary` 144-155) | 2c | 2026-08-16 | contributes to F115 |
| `src-tauri/src/diff_triage.rs` (`build_chat_request` 1025-1055, `do_turn` 1208-1262) | 2c | 2026-08-16 | F113 |
| `src-tauri/src/diff_triage.rs` (`classify_multi_turn` 1336-1472) | 2c | 2026-08-16 | F113; per-file cache itself is sound |
| `src-tauri/src/diff_triage.rs` (`TriageSession` 31-65, `run_diff_triage` 1530-1740, `run_pr_review_impl` 1752-1923) | 2c | 2026-08-16 | F117 |
| `src-tauri/src/diff_triage.rs` (`analyze_diff` 671-772, `fallback_classification` 807-888) | 2c | 2026-08-16 | F116 |
| `src-tauri/src/diff_triage.rs` (`split_unified_diff` 959-1020, `build_file_msg` 946-957) | 2c | 2026-08-16 | F116 |
| `src-tauri/src/diff_triage.rs` (`heuristic_classify` 390-501, `read_file_impl` 1127-1179) | 2c | 2026-08-16 | clean (pure string matching / one bounded read per tool call) |
| `src-tauri/src/state.rs` (`LogLine::text` 3525-3530, `VtLogBuffer::lines` 3721-3723) | 2c | 2026-08-16 | contributes to F114 |
| `genai-0.6.5` (`ChatRequest` `chat_request.rs:11-33`, `exec_chat_stream` `client_impl.rs:161-166`) | 2c | 2026-08-16 | contributes to F112/F113 (owned-by-value API) |

---

## Measurements taken (disk artifacts, this machine, 2026-08-16)

Stated up front so every number below is traceable. Method: `find`/`stat -f %z`
on `~/Library/Application Support/com.tuic.commander/ai-sessions`, and a
`python3 json.load` pass over all 1918 files counting `commands[]` entries by
`classification.kind`.

| Quantity | Value |
|---|---|
| Session-knowledge files | 1918 |
| Total bytes | 6,975,987 (6.65 MiB) |
| Size min / median / p90 / max | 557 / 1,960 / 6,051 / 167,229 bytes |
| Total `CommandOutcome` records | 8,093 |
| …by class | `inferred` 7,606 (94.0 %) · `success` 319 · `error` 168 |
| Largest file (`76d854af-…`) | 210 records, **all** `inferred`, **all** with `command == ""`, 103,904 bytes of `output_snippet` |
| Repo scale (for F115) | 1,787 tracked files, ~84 MB |

Everything else in this document is code-derived and labelled as an estimate.

---

## Findings

### F110 — every recorded command rewrites the session's entire knowledge file, with an fsync (P2)

The write path is: `record_outcome` (`state.rs:2604-2609`) appends one outcome
and sets a dirty flag; the 2 s ticker (`knowledge.rs:557-565`) calls
`flush_dirty`, which for each dirty session does

```rust
let snapshot = entry.lock().clone();          // knowledge.rs:591
if let Err(e) = persist(&sid, &snapshot) { …  // knowledge.rs:592
```

`persist` (`:453-460`) then runs `serde_json::to_string_pretty` over the **whole**
`SessionKnowledge` and hands it to `config::persist_atomic`, which writes a temp
file, `set_permissions`, **`file.sync_all()`** (`config.rs:235`) and renames.

So a single new command costs: a deep clone of up to `MAX_COMMANDS = 2000`
outcomes (each with an `output_snippet` up to `SNIPPET_MAX_LEN = 2000` chars),
a full pretty-JSON serialization of the same, one file create, one full write,
one **fsync**, one rename. There is no append log and no incremental write.

Amplitude, **measured** on this machine: the largest live file is 167,229 bytes,
so a session in that state re-serialises and re-fsyncs ~167 KB per recorded
command. The median session is 1,960 bytes, so the *typical* case is cheap — the
cost is concentrated in long-lived sessions, which are exactly the ones that keep
recording.

Frequency is not "per user command". `record_inferred_outcome_if_no_osc133`
(`pty.rs:3146`) fires on **every busy→idle transition** for any session without
OSC 133 (`pty.rs:3472`), i.e. once per agent turn on every agent tab. Measured:
one session accumulated 210 such records.

Two mitigations already in place, so this is P2 and not P1: the flush runs on
`spawn_blocking` (`knowledge.rs:564`), so the fsync never parks an async worker;
and the 2 s debounce coalesces bursts. What it does not bound is the *size* of
each write — that grows monotonically with session age, and the per-write cost is
O(entire history) for a delta of one record.

The dirty-flag ordering (clear-before-snapshot, re-insert on failure,
`:583-595`) is correct and well-tested; nothing here suggests changing it.

### F111 — `redact_secrets` makes 20 full copies of its input and scans it with 19 regexes, unconditionally, and it runs before truncation (P2)

`tools.rs:540-544`:

```rust
let mut result = text.to_owned();                                   // copy 1
for (pattern, replacement) in PATTERNS.iter() {                     // 19 patterns
    result = pattern.replace_all(&result, *replacement).to_string();// copies 2..20
}
```

`replace_all` returns a `Cow`; on the overwhelmingly common no-match path it is
`Cow::Borrowed`, and `.to_string()` allocates a **full copy anyway**. So the cost
is 20 allocations + 20 memcpys + 19 regex scans of the whole input, whether or
not a single secret is present. (19 `Regex::new` calls counted at
`tools.rs:465-537`; one of them, the PEM block at `:476`, is a `[\s\S]*?` scan.)

`sanitize_snippet` (`knowledge.rs:39-42`) has the identical shape with 5
patterns — 6 copies, 5 scans — and runs on every recorded outcome
(`knowledge.rs:174`), immediately followed by two `redact_secrets` calls
(`:175-176`).

The worst call site is `run_command`:

```rust
let raw_stdout = String::from_utf8_lossy(&stdout_buf).into_owned();   // tools.rs:2130
let (stdout, stdout_truncated) = truncate_output(&redact_secrets(&raw_stdout));  // :2132
```

The child's stdout is read with `read_to_end` (`:2109`) — **unbounded** — then
`redact_secrets` processes the entire raw buffer, and only then does
`truncate_output` cut it to `RUN_COMMAND_OUTPUT_CAP = 30_000` (`:1574`).
An agent running `cargo build` on this repo gets megabytes of stderr; **estimate,
derived from the code**: a 5 MB build log costs ~100 MB of copying and ~95 MB of
regex scanning to produce a 30 KB result. Redacting the head+tail *after*
truncation would be ~330× cheaper and preserve the same guarantee for what
actually reaches the LLM.

Other hot sites: `exec_read_file` (`:1373`) redacts the whole formatted output
(up to `READ_FILE_MAX_LINES = 2000` numbered lines), and `exec_search_files`
calls it once per matched line **and** once per context line (`:1782`, `:1786`,
`:1791`) — up to 50 matches × (2·`context_lines`+1) short strings, each paying 20
allocations.

The single-pass fix is mechanical: `RegexSet` to test first, or keep the `Cow`
and only materialise on `Cow::Owned`. Neither changes redaction semantics.

### F112 — the whole `ChatRequest` — system prompt, 31 tool schemas and full history — is deep-cloned on every LLM iteration and every retry attempt (P3)

`conversation_engine.rs:807-818`:

```rust
let mut attempt: u32 = 0;
let (text_buf, captured, usage) = loop {
    let outcome = match client
        .exec_chat_stream(model, chat_req.clone(), Some(&chat_options))
        .await
```

`ChatRequest` is fully owned (`genai-0.6.5/src/chat/chat_request.rs:11-33`:
`system: Option<String>`, `messages: Vec<ChatMessage>`, `tools: Option<Vec<Tool>>`),
and `exec_chat_stream` takes it **by value** (`client_impl.rs:164`), so the clone
is imposed by the library, not by this code. What is *not* imposed is how much
rides in it and how often:

- `tools`: 31 definitions (`tools.rs` test `definitions_returns_31_tools:2503`),
  each a `Tool { name, description: Option<String>, schema: Option<Value> }`.
  The `json!` literal spans `tools.rs:70-449`; **measured on the source text**
  with indentation stripped, ~16 KB of JSON, i.e. several hundred small heap
  allocations per clone (each `Value` map/string node is its own allocation).
  These are byte-identical on every iteration of every conversation.
- `system`: base prompt + up to `DEFAULT_CONTEXT_BUDGET = 16_000` chars of
  terminal context + the knowledge section + up to 8 KB of cross-session memory.
- `messages`: grows by one assistant message + one `ToolResponse` **per tool
  call**, and tool outputs are large by construction (`read_file` up to 2000
  numbered lines, `run_command` up to 30 KB).

Over `MAX_ITERATIONS = 20` (`engine.rs:20`) the clone volume is quadratic in the
history. `MAX_LLM_RETRIES = 4` (`engine.rs:32`) multiplies it on a flaky
connection — a retry re-clones everything including the 16 KB of tool schemas
that provoked no part of the failure.

P3 because the frequency is per-LLM-turn (seconds apart), not per chunk. Filed
because it is structural: the tool block is immutable for the process lifetime
and could be an `Arc`-shared or once-built value if the request were assembled
per call instead of mutated in place — and because the retry path is the one
place where the re-clone buys nothing at all.

### F113 — `diff_triage` rebuilds the entire multi-turn conversation from scratch on every file turn, then clones it again per LLM attempt (P2)

`do_turn` (`diff_triage.rs:1220`):

```rust
let mut req = build_chat_request(session, &user_msg, system_prompt).with_tools(tools.to_vec());
for _ in 0..=MAX_TOOL_CALLS_PER_TURN {
    … client.exec_chat(model, req.clone(), Some(&chat_options)) …
```

`build_chat_request` (`:1025-1055`) walks `session.messages` and constructs a
fresh `ChatMessage` per entry — `ChatMessage::user(&msg.content)` takes `&str`
and **owns a copy**, so every turn re-allocates the full accumulated
conversation. `req.clone()` at `:1225` then copies it a second time, per attempt
inside the tool loop.

`classify_multi_turn` (`:1390-1466`) calls `do_turn` once per file, up to
`MAX_FILES_TO_LLM = 30` (`:503`), and each turn pushes 2 messages
(`:1237-1246`). Each file message carries the diff truncated to
`MAX_LINES_PER_FILE = 300` (`build_file_msg:948`).

**Estimate, derived from the constants — not profiled:** at ~60 chars/line a
file message is ~18 KB; by file *k* the session holds ~2*k* messages, so a
30-file review rebuilds Σ ≈ 30²/2 × 18 KB ≈ **8 MB** of strings, and clones the
same again for `req.clone()` — ~16 MB of pure copying for one PR review.

Note this is *local* cost only. The wire cost is already handled correctly: the
code places `CacheControl::Ephemeral` on the system message, a midpoint
breakpoint above 40 messages, and the final user message (`:1033-1053`), so the
provider re-reads a cached prefix. The local rebuild is what the cache-control
design does not cover. Reusing one `ChatRequest` across turns and appending to
it — the shape `run_conversation` already uses — removes the rebuild entirely
and leaves only the library-imposed clone of F112.

### F114 — the terminal context is assembled in full every iteration purely to discover it is unchanged, under the PTY buffer lock (P3)

`conversation_engine.rs:748-756`:

```rust
if iteration > 0 {
    let current_context = assemble_context(&state, &session_id);
    let current_knowledge = super::context::build_knowledge_section(&state, &session_id);
    if current_context != last_context || current_knowledge != last_knowledge {
```

The guard is the right idea — it avoids rebuilding the composed system prompt —
but it is applied *after* the expensive part. `assemble_context` →
`ai_chat::assemble_terminal_context_for_engine` (`ai_chat.rs:173`) →
`assemble_terminal_context` (`:606`) does, per iteration:

- `buf.lock()` on the session's `VtLogBuffer` — **the same lock the PTY reader
  takes to append** (the F14 lock, held here for the whole block `:629-669`);
- 150 × `LogLine::text()`, each of which allocates a fresh `String` by
  concatenating the line's spans (`state.rs:3525-3530`);
- `buf.screen_rows()` (`:644`), i.e. `prev_rows.clone()` — the exact clone F19
  documents and `pty.rs:4336-4340` deliberately avoids via `screen_rows_ref()`.
  It is built **unconditionally** but consumed only in two conditional branches
  (`:645` empty-output fallback, `:658-668` TUI app-hint enrichment);
- `truncate_terminal_output` over up to `DEFAULT_CONTEXT_BUDGET = 16_000` chars
  (`:654`), which does its own `lines()` collect plus a rebuild;
- then `assemble_block_context` (`ai_chat.rs:183`) takes the session-knowledge
  mutex and formats command blocks up to another 16 KB.

`build_knowledge_section` (`context.rs:23-27`) additionally takes the
session-knowledge mutex again and rebuilds the markdown summary.

Per LLM turn, so P3 on frequency — but it is lock contention on the hottest lock
in the app, and the result is discarded by a string comparison most of the time
(shell state and cwd rarely change mid-turn). A cheap revision counter on the
`VtLogBuffer` would let the comparison happen before the work rather than after.

### F115 — every filesystem tool runs synchronously on a tokio worker, and `search_files` opens each candidate file twice (P2)

`run_conversation` awaits `tools::dispatch(…)` directly on its spawned task
(`conversation_engine.rs:926`), and `dispatch_inner` (`tools.rs:2449-2482`)
calls the `exec_*` functions inline. There is **no** `spawn_blocking` anywhere in
`ai_agent/tools.rs` (grep over `ai_agent/` finds it only in
`conversation_engine.rs:369`, `commands.rs:232,366`, `knowledge.rs:537`,
`watcher.rs:994`).

The contrast inside the same module is the argument: `build_config`
(`conversation_engine.rs:366-373`) wraps a *single small config-file read* in
`spawn_blocking` with the comment *"do it on the blocking pool so we never stall
an async worker thread"* — while `exec_search_files` walks an entire repository
on the async worker.

`exec_search_files` (`tools.rs:1731-1799`) per candidate file:

1. `path.canonicalize()` (`:1740`) — resolves the whole path chain;
2. `FileSandbox::is_binary(&canon)` (`:1747`) — **opens the file and reads 8 KB**
   (`sandbox.rs:146-150`);
3. `std::fs::metadata(&canon)` (`:1750`) — a second stat;
4. `std::fs::read_to_string(&canon)` (`:1757`) — **opens it again** and reads the
   whole thing (up to `MAX_FILE_BYTES = 10 MB`);
5. `content.lines().collect()` into a `Vec<&str>`, then `re.is_match` per line,
   then `redact_secrets` per match/context line (F111).

That is two opens and two stats per file, with the first 8 KB read twice. The
walk is single-threaded (`walk_builder.build()`, not `build_parallel()`), and
after the 50-match cap it keeps walking (`:1774-1776`) until
`total_matches > SEARCH_MAX_MATCHES * 4` (`:1795`).

Scale, **measured on this repo**: 1,787 tracked files, ~84 MB. One
`search_files` call with a non-matching pattern therefore reads roughly the whole
tree on one worker thread.

`exec_list_files` (`:1633-1665`) has the same shape at lower amplitude — a
`canonicalize()` syscall per glob hit, plus `is_dir()`/`is_file()` (two more
stats) per emitted entry, for up to `LIST_FILES_MAX = 500` entries. `exec_read_file`
does `metadata` + `is_binary` (8 KB read) + `read_to_string` — the same double
open, on one file.

Honest bound on the stall: the default multi-thread runtime sizes itself to the
CPU count (14 here), and tokio work-steals from a blocked worker's queue, so this
parks 1/14 of the pool rather than freezing the app. That is why it is P2, not
P1. The *wasted* work — the duplicate opens and the duplicate 8 KB read — is
unconditional and independent of the threading question.

### F116 — `analyze_diff` allocates two full copies of every changed diff line to run six `starts_with` checks (P3)

`diff_triage.rs:749-769`, inside the per-line loop:

```rust
let upper = trimmed.to_ascii_uppercase();      // allocation 1
if upper.starts_with("CREATE TABLE") || … { s.schema_signals += 1; }
let lower = trimmed.to_ascii_lowercase();      // allocation 2
if lower.contains("password") || … { s.auth_signals += 1; }
```

Both allocations happen for **every** added or removed line of every diff, in
every language — a Rust source diff pays the SQL uppercase pass in full. Neither
result outlives the two `if`s. `eq_ignore_ascii_case` on the prefix, or a
case-insensitive `regex`/`aho-corasick` set, removes both.

Amplitude is bounded by the caller: `analyze_diff` runs only from
`fallback_classification` (`:838`), which is the no-LLM / LLM-failed path —
per-file at `:1435`/`:1440`, and over every overflow file beyond
`MAX_FILES_TO_LLM` at `:1723`/`:1811`. So it is a burst on a fallback, not a
steady cost; hence P3.

Same file, same class: `split_unified_diff` (`:959-1020`) pushes
`line.to_string()` into `current_lines: Vec<String>` for **every** line of the
diff (`:1009`), then `current_lines.join("\n")` (`:974`) — the full diff is
materialised twice, once as N small `String`s and once as one large one, where
slicing the input by byte range would allocate once per file.

### F117 — the triage session's message log is never trimmed, so crossing 100 messages silently throws away the per-file classification cache too (P3)

`TriageSession::is_valid` (`:60-64`) requires
`self.messages.len() < MAX_SESSION_MESSAGES` (100, `:16`). Nothing ever trims
`messages`: `do_turn` only pushes (`:1237`, `:1242`, `:1257`), and the explicit
pruning after a run touches `file_hashes` and `classifications` only
(`:1710-1715`, `:1886-1891`).

When the count crosses 100, the lookup takes the `else` branch
(`:1638-1641` / `:1848-1851`), `sessions.remove(&key)` drops the session, and a
fresh `TriageSession::new` is installed. That discards `file_hashes` and
`classifications` — the very cache that makes `classify_multi_turn` skip
unchanged files (`:1393-1409`). The next run re-sends **every** file to the LLM.

So the efficiency mechanism has a cliff: it works well for a while, then resets
in full, and the reset is invisible from the call site. A single run cannot reach
the cliff (30 files × 2 messages = 60), but repeated runs on a changing worktree
accumulate — each newly-changed file adds 2 more messages, cached files add none.
Trimming the oldest messages while keeping the caches would make the reuse
monotone instead of sawtoothed.

This is recorded as an efficiency consequence, not a leak: the map itself is
bounded (one entry per repo / per open PR), and the keying rationale documented
at `:72-84` is sound.

### F118 — `search_code` re-acquires the index lock per result and re-reads plus lowercases every result file line by line (P3)

`exec_search_code` (`tools.rs:1849-1860`):

```rust
let out: Vec<Value> = results.into_iter().map(|ranked| {
    let abs = index_arc.read().absolute_path(&ranked.rel_path);   // :1852 — per result
    let snippet = extract_bm25_snippet(&abs, &query_words);
```

`index_arc.read()` is taken **inside** the closure, so up to
`SEARCH_CODE_MAX_RESULTS = 20` (`:1815`) separate `RwLock` acquisitions where one
hoisted guard would serve — on the same lock the background index builder writes
to.

`extract_bm25_snippet` (`:1866-1891`) then, per result file: `read_to_string`
the whole file, `lines().collect()`, and `line.to_lowercase()` — **one String
allocation per line of the file** — to count query-word hits, in order to return
a 3-line window. For 20 results over source files of a few thousand lines each
that is tens of thousands of transient allocations per `search_code` call.
`contains` on a pre-lowercased haystack built once, or a case-insensitive
matcher, avoids all of them.

Minor, same path: `dispatch_inner` clones the args `Value` on **all three**
branches (`tools.rs:2425`, `:2429`, `:2432`), including the case where no alias
rewrite happens; and `state.resolve_alias` (`state.rs:2571-2576`) linearly scans
the `term_aliases` map per dispatch.

### F119 — 94 % of stored command outcomes are empty-command screen tails, and they crowd the real command history out of the 16 KB LLM context (P2)

`record_inferred_outcome_if_no_osc133` (`pty.rs:3146-3188`) fires on every
busy→idle transition for a session with no OSC 133 integration — which is every
agent tab. It records a `CommandOutcome` with `command: String::new()`
(`:3179`), `exit_code: None`, and an `output_snippet` that is the **last 500
chars of the current screen** (`:3160-3172`).

**Measured** across all 1918 persisted files: 7,606 of 8,093 outcomes (94.0 %)
are `inferred`; in the largest file all 210 are `inferred` and all 210 have an
empty `command`, carrying 103,904 bytes of snippet between them.

These are not inert. `assemble_terminal_context_for_engine`
(`ai_chat.rs:181-191`) prefers block context when it exists and **replaces** the
VtLogBuffer "Recent Terminal Output" section with it:

```rust
if let Some(pos) = section.find("\n### Recent Terminal Output\n") {
    section.truncate(pos);            // ai_chat.rs:186
```

`assemble_block_context` (`:554`) then walks outcomes newest-first until
`DEFAULT_CONTEXT_BUDGET = 16_000` chars are used, and `format_command_block`
(`:576-603`) renders each as

```
[cmd: ] [cwd: /path] [exit: ?] [duration: 0ms]
```

followed by the 500-char screen tail in a fenced block. So for an agent session
the entire 16 KB context slot — rebuilt every turn (F114), cloned into every
request (F112) — is filled with ~30 successive, heavily overlapping snapshots of
the same screen, each labelled with an empty command, in place of the terminal
output the section is documented to carry.

Downstream, the same records dominate `exec_get_command_history` (`tools.rs:975-991`,
which returns `"command": ""` rows), sit inside `FIX_CORRELATION_WINDOW`'s
3-command lookback (`knowledge.rs:156-165`) diluting error→fix correlation, and
drive the whole-file rewrite of F110.

The read consumers *are* real, so this is not dead data — which is why the fix is
a judgement call rather than a deletion. The efficiency observation is narrower
and safe to state: storing one 500-char screen tail per idle transition, keeping
2000 of them, and letting them fill a 16 KB context budget with duplicated
content is a poor ratio of bytes to signal. A dedup on snippet content, or a
lower cap for `Inferred` records, would cut all three costs at once.

---

## Not covered

- **`ai_agent/watcher.rs`, `scheduler.rs`, `triggers.rs`, `safety.rs`** — the
  watch/trigger engines behind `watch_for`/`schedule_task`. `trigger_classifier.evaluate`
  is called on every `record_outcome` (`state.rs:2598`) and was not read; it sits
  directly on F110's path.
- **`engine.rs::compact_history` / `estimate_tokens`** (`conversation_engine.rs:1007-1025`).
  Compaction is invoked at most once per iteration and only above 100 K tokens; the
  elision algorithm itself was not read.
- **MCP-bridge tools** (`exec_search_tools`, `exec_call_tool`) and the
  orchestration tools (`spawn_session`, `drive_agent`, `get_agent_status`) —
  inventoried in `dispatch_inner`, implementations not read. `drive_agent` is an
  async send→wait→read loop and deserves its own pass.
- **`content_index.rs` build/rebuild path** — F44/F45 own it; read only far
  enough to confirm `ensure_index` (`:323-353`) is a check-and-spawn and does not
  build inline.
- **`improvement_scan.rs`, `conflict_assist.rs`** — chunk 2b's F17 covers the
  improvement-scan emit; the scan bodies were not read.
- **`ai_agent/conversation.rs` persistence** (chat transcript files in
  `ai-chat-conversations/`) — only `redact_secrets` at `:104` was noted. The
  on-disk growth of that directory was not measured.
- **The frontend side of any of this.** F110/F119 stop at the Rust boundary.
- **No profiling was run.** Every quantity is either measured on disk / in the
  repo (the table above) or an explicitly-labelled estimate whose derivation is
  stated inline.

---

## Open questions

- **Is the `Inferred` outcome stream intentional or an accident of scope?**
  F119's 94 % figure is measured, but `record_inferred_outcome_if_no_osc133`'s
  doc comment (`pty.rs:3141-3145`) says it exists so that "cwd + snippet still
  populate context summary and cwd history" — and `cwd_history` dedups adjacent
  entries, so after the first record per directory the *stated* purpose is
  already satisfied. Whether the snippets are wanted in `assemble_block_context`
  or merely reach it because the same `commands` deque serves both is a design
  question I could not settle from the code.
- **How large does a single session's file get in practice over weeks?** The
  measured max is 167 KB against a theoretical cap of 2000 × ~2 KB ≈ 4 MB. I did
  not determine whether sessions are simply retired before filling, or whether
  something else bounds them — it decides whether F110's per-write cost has a
  much worse tail than observed.
- **Does `search_files` actually get called on a whole repo in practice?** F115's
  84 MB figure is the worst case (no `path`/`glob` narrowing). I did not sample
  real agent tool-call arguments to see how often the LLM narrows the search
  first. If it usually passes a `glob`, the finding's amplitude drops sharply
  while the double-open waste stays.
- **F113's 8 MB estimate assumes 30 LLM files.** I did not measure a real PR
  review; the derivation is `MAX_FILES_TO_LLM` × `MAX_LINES_PER_FILE` × an
  assumed 60 chars/line. A run against a real PR with timing around
  `build_chat_request` would confirm or shrink it by an order of magnitude.
- **Is `truncate_output`-before-`redact_secrets` safe to reorder?** F111 proposes
  redacting the 30 KB head+tail rather than the raw megabytes. A secret that
  straddles the truncation boundary would then survive into the marker text. The
  head/tail split at `tools.rs:2005-2007` cuts on byte offsets, not lines, so the
  reorder needs an overlap margin — cheap, but it must be deliberate.
