# Ego steering recordings

`ego-steer-initialize.json` and the three response JSON files are recorded from
`ego__wt/feat-acp-steer/target/debug/ego` on 2026-10-06. No installed binary was
changed. EGO_HOME, workspace and temporary files were isolated under
`~/Gits/.tmp/tuic-steer/`. A local Ollama protocol stub held generation open.

The user-message notification in `steer-accepted.jsonl` is also recorded from
that run, with only the session ID normalized. The recording used an isolated
child HOME to exclude personal ego configuration.

The `steer-*.jsonl` files are deterministic host-ordering scenarios, not recorded
transcripts. They reference the recorded capability and steer results. The transcript projection test separately protects single-bubble rendering.
