Recorded from installed ego 0.1.0 on 2026-10-13, with HOME, EGO_HOME and XDG paths isolated under ~/Gits/.tmp/ego-1775-capabilities. Commands: config ls --profile=alpha --json; models --json (first model retained); doctor --json (credentials section retained); auth status (empty stdout). The stored profile was populated through config set. The Python replay process emulates only these observed argument and JSON contracts; real installed-owner set/readback probes were also run. It never reads credentials.

The populated auth-status capture used a dummy api_key entry in the throwaway EGO_HOME only. Its stdout is `openrouter<TAB>api_key`; the dummy key did not appear. No production store was read.

Replay mutations use Python tomllib to parse the emitted assignment, so a malformed TOML argument fails independently of the adapter encoder. Installed-owner probes confirmed profile set/unset/ls, network, roots, thinking, mode, sandbox, budget, judge, and exec environment vocabulary.

Story 1907-0f9f extends this boundary with installed ego captures on 2026-10-15.
`capabilities.json`, `snapshot-base-auth.json` and `conflict.json` are exact stdout
from the installed `~/.local/bin/ego` under isolated HOME/EGO_HOME beneath
`~/Gits/.tmp/ego-1907`. Commands: `config capabilities`; `config batch --set
'exec_paths=["/fixture/bin"]' --set 'auth.openai.headers={"X-Identity"="fixture-only"}'
--set 'auth.openai.credential_command="/fixture/never-execute"'`; `config snapshot`;
`config batch --if-revision stale --set 'model="ollama/no-write"'` (exit 1).
Auth values in snapshots are owner-redacted strings, not recoverable configuration.
The command path does not exist; snapshot succeeds without invoking it. The owner
rejects Authorization header overrides; the fixture uses an allowed X-Identity header.
The replay models opaque revisions with a content hash only for deterministic race
injection. Production always uses the owner's private revision, never this test hash.
