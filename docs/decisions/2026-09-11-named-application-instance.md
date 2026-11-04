# Isolate a Named Application Instance at Process Bootstrap

## Status

Accepted by Boss on 2026-09-11 as the prerequisite for ego Story 094's
production `tuic-remote` host proof.

## Problem

`tuic-remote` currently resolves the platform configuration directory and the
OS-keyring vault from fixed application-wide names. Changing `HOME` is not an
isolation boundary for a release build: the keyring remains global, and the
first configuration load may copy legacy files, import legacy credentials,
persist them into the default vault, and delete their original entries before
the daemon binds its socket.

An external black-box harness therefore cannot launch a production daemon in a
disposable home directory without risking mutation of the operator's real
FastAF state. The identity must cover every persistent namespace and must
be fixed before any persistence code runs.

## Decision

The process owns one immutable `AppInstance`, selected at bootstrap.

- Omitting `--instance` selects the default instance and preserves the existing
  platform config path, keyring service/user tuple, and every existing migration.
- `tuic-remote --instance <id>` selects a named instance before `--set-password`
  or server startup touches configuration, credentials, logging, or sockets.
- A named identifier is one lowercase ASCII DNS label: 1-63 characters,
  alphanumeric at both ends, with internal hyphens allowed. `default` is
  reserved. Empty values, uppercase aliases, separators, traversal syntax,
  controls, whitespace, and any other character are rejected.
- A named instance stores files below
  `<platform-app-config>/instances/<id>/` and stores its credential vault at
  keyring service `tuicommander-instance-<id>`, user `vault`.
- Named instances start from their own empty state when a file or vault entry is
  absent. They never scan, copy, hydrate from, persist into, or delete default or
  legacy config and keyring locations. This includes the dynamic legacy MCP
  credential lookup.
- The release keyring remains mandatory. A named daemon proves that its vault is
  readable before it binds; an unavailable vault is a startup error, never an
  empty-vault interpretation or file-backed fallback.
- Debug builds keep their existing file-backed credential adapter, but its file
  follows the same instance namespace so development and automated tests cannot
  cross named-instance state.
- Runtime instance switching is unsupported. Selecting a different instance
  after any code has observed the process instance is an error.

The ego harness pins and verifies the exact built artifact digest before launch.
That artifact identity is the capability proof for `--instance`; FastAF
does not add a second runtime capability or version endpoint for this purpose.

## Why Existing Mechanisms Are Insufficient

`HOME`, `XDG_CONFIG_HOME`, and a temporary working directory can redirect files
but cannot namespace the native keyring. The existing fixed vault cache also
assumes one identity for the life of the process. Selecting only a config path
would leave credentials shared, while selecting only a vault would still permit
legacy config migration. A late selection inside `run_remote` is unsafe because
argument handling such as `--set-password` also reads configuration.

## Alternatives Considered

1. Run a debug daemon with its file-backed credential store. Rejected because
   the required proof concerns the packaged production artifact.
2. Add independent config-directory and vault overrides. Rejected because two
   knobs can disagree and create a mixed identity whose files and secrets belong
   to different instances.
3. Disable migration globally for remote mode. Rejected because it would change
   default-instance compatibility and still would not namespace new writes.
4. Add a capability-probe CLI command. Rejected because the consuming harness
   already pins the exact artifact digest; a second public contract would add no
   stronger evidence and an old binary could ignore an unknown probe argument.

## Trade-offs

The instance identifier becomes a stable external name and its validation is
intentionally strict. Renaming an instance is a manual move of both file and
keyring state, not an automatic migration. Each named instance has an independent
vault cache and configuration tree, so credentials and settings are not shared
unless the operator copies them explicitly.

In return, every persistent effect is derived from one value and the default
desktop and daemon behavior remains byte-for-byte compatible at its existing
locations.

## Failure Semantics

Invalid, duplicate, or late instance selection terminates before any persistent
read or write. A named daemon whose keyring cannot be opened terminates before
network bind. Missing named state means fresh named state; it never triggers a
fallback. Failed writes retain the existing transactional behavior within that
instance and cannot modify another instance's cache or storage.

## Lifecycle and Ownership

The binary parses and selects the instance. The application-instance module owns
validation, immutability, and namespace derivation. The configuration adapter
owns instance-scoped file paths and default-only file migration. The credential
adapter owns the instance-scoped vault tuple, default-only legacy migration, and
startup vault probe. `run_remote` owns the fail-before-bind ordering. Callers do
not construct paths or keyring names independently.
