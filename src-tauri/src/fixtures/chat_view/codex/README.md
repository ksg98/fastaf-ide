# Codex rollout recording

`completed.jsonl` records representative rows from Codex CLI 0.162.1:
`rollout-2026-10-12T13-35-27-01a12fe5-6e73-7103-910a-b9c6e9dd6a97.jsonl`.
Recorded locally on 2026-10-13. Original location: the default Codex sessions store.

Kept: JSON envelopes, item types, content discriminants, statuses and tool result
shape. Scrubbed: prompts, replies, reasoning, tool names/arguments/output, working
directory, timestamps and identifiers. Reasoning summary text replaces an empty
recorded array to cover the documented string-array field without personal text.
The `response_item` row carries the same scrubbed reply to catch duplicate rendering.
This fixture proves the rollout format; it does not prove native hook identity.

`session-start.json` and `session-meta.json` were recorded from a live Codex
0.162.1 native SessionStart hook on 2026-10-13. The hook inherited TUIC_SESSION,
returned `continue: false`, and a local guard server recorded zero requests.
Paths were normalized; session_meta retains only identity/version/source/time
fields. Binding tests substitute IDs, cwd and paths to model independent tabs.
Raw evidence: ~/Gits/.tmp/chat-codex4-native-start/{hook-capture,result}.json.
