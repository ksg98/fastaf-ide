# Apply Configuration Deltas Under the File Lock

## Status

Accepted by Boss on 2026-08-08.

## Problem

Debug and release FastAF processes intentionally share the same platform
configuration directory. A cross-process advisory lock serializes writes, but
serialization alone does not prevent a stale whole-document save: two processes
can load the same document, change different fields, and then overwrite one
another in sequence. The later write is internally consistent but silently loses
the earlier change.

The same failure exists in `mcp-upstreams.json`. OAuth/DCR updates patch one
server's authentication metadata, while a Settings or popup save historically
replaced the complete server list. A stale UI snapshot can therefore erase newly
persisted authentication even though both writes use the same file lock.

## Decision

Ordinary configuration writes are expressed as deltas and applied to a fresh
on-disk value while the cross-process file lock is held.

- `AppConfig` derives the requested delta from the process cache and the caller's
  requested value. The commit then locks `config.json`, reloads and hydrates the
  latest value, applies only that delta, persists it, and refreshes the process
  cache from the merged result.
- Partial HTTP and MCP `AppConfig` writes remain partial objects. Their merge is
  computed against the process cache only to identify the requested delta; the
  delta itself is applied to the latest locked disk value.
- Upstream MCP saves use a three-way, server-ID-based delta: the caller supplies
  the configuration it loaded and the desired configuration. Additions,
  removals, reordering, and per-server field changes are applied to the latest
  locked document. Fields unchanged by the caller, including OAuth/DCR auth,
  survive concurrent writes.
- Within one process, an async commit sequence spans upstream persistence and
  live-registry application. This preserves the file commit order in the runtime
  registry without holding the blocking config mutex or advisory file lock across
  an async registry update.
- Whole-document replacement remains available only for workflows whose stated
  meaning is replacement or bootstrap, not as the default interactive save path.

## Why Existing Mechanisms Are Insufficient

The in-process mutex cannot coordinate independent processes. The advisory file
lock coordinates them but does not make stale replacement safe. The optimistic
`Stamp` check added around several saves is also ineffective when the stamp is
captured immediately before the write instead of when the user loaded the
document; it covers only a tiny backend window and gives a false impression of
UI-session conflict protection.

## Alternatives Considered

1. Separate debug and release configuration directories. Rejected because the
   product contract is one shared configuration, and isolation hides rather than
   resolves multi-process persistence semantics.
2. Round-trip file stamps through every IPC, HTTP, and frontend store. Rejected
   because it turns independent field edits into user-visible conflicts, adds a
   broad conflict UX, and `(mtime, length)` is not a reliable content identity.
3. Reload on file-change notifications. Rejected as the correctness mechanism:
   watchers can lag or coalesce, and a save can still race before the reload.
4. Keep serialized whole-document writes. Rejected because serialization orders
   lost updates rather than preventing them.

## Trade-offs

Delta computation adds comparison and merge code, including ID-aware handling
for upstream server arrays. In return, independent edits compose without a
conflict UI or a new version token across transports. Concurrent changes to the
same scalar retain last-locked-writer semantics; the system cannot infer user
intent when both writers deliberately change the same field.

## Failure Semantics

The lock is acquired before the authoritative read and held through persistence.
Deserialization, validation, credential, or disk failures abort the commit and
leave the process cache unchanged. Existing credential rollback remains part of
the `AppConfig` transaction. Upstream validation runs on the merged final
configuration, not on a stale requested snapshot. Runtime upstream hot-reload is
computed from the exact locked pre- and post-save values. Concurrent upstream
saves handled by the same process cannot begin their locked persistence until
the preceding save has applied that exact diff to the live registry.

## Lifecycle and Ownership Boundaries

The backend owns delta computation, locking, validation, persistence, secret
hydration, and runtime side-effect decisions. Frontends identify their upstream
base and desired states but do not merge against disk. Each process refreshes its
own `AppConfig` cache after a successful local commit; a separate external-change
watcher is not required for lost-update safety and remains outside this decision.
