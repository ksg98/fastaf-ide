# Managed reconnect capture (2008-5317)

## Source

Recorded on 2026-10-19 from the real native macOS `tuic-remote` debug binary
built in `fix/2008-reconnect-fixtures` at `e3f23c54f4`. Both captured
`/api/version` replies report that revision and version 2.0.0.

Build: `PATH="$HOME/Library/Application Support/mbx/bin:$PATH"
~/Gits/personal/orchestrator/tools/build/build-slot.sh cargo build
--manifest-path src-tauri/Cargo.toml --bin tuic-remote --no-default-features`.
The build passed in 2m20s. Build log:
`~/Gits/.tmp/fix-2008b-native-build.log`.

The recording used `--instance fixture-2008 --bind 127.0.0.1
--no-agent-configs`, a private TCP port (57248), and an isolated HOME and
TMPDIR under `~/Gits/.tmp/fix-2008b-home`. The debug credential store was
file-backed in that HOME. No production configuration, OS keychain,
installed binary, desktop instance, or Boss-owned session was used.
The driver terminated and waited for both daemon processes; the restored
throwaway PTY was deleted before the final shutdown.

The daemon's remote TCP router does not serve `/mcp`. REST calls used the
private TCP listener; MCP calls used HTTP over this instance's Unix socket,
`<isolated TMPDIR>/tuic-mcp-61698a6497f8f282.sock`. The JSON records retain
request bodies, context headers, response bodies, status, and MCP response
headers. The private authentication cookie is deliberately omitted. JSON
whitespace and HTTP header spelling are not wire-byte evidence; values are
unchanged. No external response was hand-written.

SHA-256 (`managed-reconnect-2008.json`):
`2804115eec1d467396ff5b689df1c18d2253c187efa35bb2e2d4415cc1933da5`.

`managed-reconnect-2008.capture.py` retains the recorder with a checkout-relative
root and a required new scratch HOME argument. Run it only after the native
build above, with a fresh absolute directory under `~/Gits/.tmp`. It starts
and stops only its own headless processes. Setup retries of suspend are allowed
only for the actual `command running` response, for at most 30 seconds.

## Recorded contracts

- A real tab was created and bound automatically, without register/list/register.
  A subscription and self-addressed mail were created before daemon shutdown.
- The tab was durably suspended, the daemon terminated and a new daemon started
  against the same isolated state. Resume preserved stable identity
  `650ef537-ceba-4199-b6f1-537f8f19aedd` while creating PTY
  `bd01b909-4692-4a7c-b52b-0ba63082aff9` (see the JSON for authoritative values).
  `GET /sessions` publishes both identities. Modern inbox reads recovered the
  same pre-restart subscription message ID without registration repair.
- Managed Progress succeeds after restart. A headerless external inbox returns
  `identity_context_required`, `not_started`, `retryable=false`, and
  `repair.max_attempts=1`. Headerless Progress returns `project_required` rather
  than selecting the managed caller's project.
- The orphan replacement reports `mail_migrated=1`, and the replacing caller
  reads that message. Replacing the stable identity of a live restored tab
  reports `mail_migrated=0`, `mail_stranded=1`, and an explicit warning. The live
  owner can still read its own mail (554-9df0).
- The modern discovery requests reuse the committed real ego discovery fixture
  (`ego_server_discover.json`) before and after restart. They remain stateless:
  no `mcp-session-id` response header is introduced. This does not claim that
  the Python recorder is ego or that it exercises ego's stdio child lifetime.
  Ego 346-5a2e's `consecutive_stdio_calls_in_one_run_share_one_server_process`
  remains the consumer lifetime regression, with passing evidence already in
  the story worklog. No ego code or bridge lifecycle behavior changed here.

## Replay scope and limits

The three `managed_reconnect_fixture_` tests replay the captured MCP requests
through real `mcp_post`. The restart replay drops an AppState and its journal
connection, recreates state against the same on-disk directory, and restores
the captured stable-tab/new-PTY relationship through test session support.
The real process shutdown, suspend and resume are proved by this recording,
not simulated by the replay. Scratch cwd and freshly minted message/protocol
IDs are local replay state; payloads and asserted receipts come from the capture.
The replay does not require the captured macOS checkout path on Linux.

Restart-persistent mail is deliberately read through an independent durable
subscription (2004). Legacy un-subscribed inboxes are process-local, and this
fixture does not promise otherwise. Replacement exercises the legacy inbox
contract within one daemon process; subscription cursors are not migrated.

Validation: Linux rb `cargo check --manifest-path src-tauri/Cargo.toml --tests`
passed in 1m23s, `RB_BOX_DIRTY=no`, log `~/Gits/.tmp/fix-2008b-check.log`.
No GREEN test run was performed in this story. The batch integrator must run
`test(managed_reconnect_fixture_)` plus the existing named reconnect,
replacement and ego stdio regressions. Existing RED and GREEN evidence in the
story is retained; this fixture-only change does not redefine those contracts.
