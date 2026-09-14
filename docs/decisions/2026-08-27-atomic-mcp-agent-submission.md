# Acknowledge MCP Agent Submission in One Call

## Status

Accepted for implementation on 2026-08-27.

## Motivation

`session action=input` can write text and Enter in one request, but its
`{"ok":true}` response proves only that bytes were written to the PTY. A caller
that needs to hand a command to a managed Codex session must then infer whether
the raw-mode composer submitted it. Splitting text and Enter is worse: another
writer can intervene, and Codex can treat the Enter as a composer newline.

## Decision

Add `session action=submit` for one non-empty managed-agent command. The action
claims a confirmed-idle, empty composer; writes the existing Ctrl-U, bracketed
paste, 50 ms gap, and CR sequence; advances the existing input FSM and turn
epoch; then waits internally for bounded post-Enter terminal movement. One MCP
response carries the submission id, write state, acknowledgement state, turn
epoch, composer state, retry safety, and observed output offset.

The action never queues. A pre-existing partial composer, confident interactive
question, unconfirmed/busy agent, older queued injection, missing observation
buffer, or lost claim rejects before the first byte. This preserves drafts,
interactive dialogs, and the existing shared FIFO. A peer arriving after the
claim sees BUSY and queues behind the submitted command; a peer that claims
first makes `submit` reject, so their PTY payloads cannot splice.

`session action=input` remains the raw input/key compatibility surface. It does
not gain receipt semantics. Slash commands, including `/clear`, use `submit` and
the same acknowledgement contract; readiness movement is evidence, not a
special success shortcut.

## Why Existing Mechanisms Are Insufficient

- `ok:true` is write completion, not terminal acknowledgement.
- `turn_epoch` and the cleared `InputLineBuffer` are mutated by FastAF's
  own bookkeeping, so neither can prove that the child terminal reacted.
- `session action=status` and `output` require a second client call and race with
  fast commands.
- The deferred Compose/peer queue acknowledges acceptance into a FIFO, not
  submission of this command during this response.

## Alternatives Considered

- Strengthen `input` when text and Enter are combined. Rejected because `input`
  is an established raw terminal primitive whose callers also prefill composers
  and answer interactive dialogs.
- Return success after advancing `turn_epoch`. Rejected because that epoch is
  caused by local bookkeeping and would reproduce the false positive under a
  new field name.
- Queue when the composer is busy. Rejected because acknowledgement would then
  outlive the bounded MCP request and reorder ownership with existing queued
  messages.
- Require a follow-up `status` or `output` call. Rejected because the objective
  is one authoritative response and fast transitions can occur between calls.

## Trade-offs

The receipt proves a completed PTY write plus independent post-Enter terminal
movement; it does not prove that the application understood the command or that
the requested work succeeded. The bounded wait adds up to three seconds by
default to the MCP call and uses the existing raw-output offset and agent screen
state as evidence. A terminal that reacts before the post-Enter boundary can
produce a conservative timeout rather than a false acknowledgement.

## Failure Semantics

Rejections and writes that provably never start are retry-safe. A partial write,
completed write without acknowledgement before the deadline, session exit, or
superseding turn is `retry_safe:false`: the caller must not replay automatically
because the command may already be active. Timeout reports `write_state:complete`
and `acknowledged:false`; it never reports application acceptance. Optional
`timeout_ms` is clamped to 250–10,000 ms, default 3,000 ms.

## Lifecycle and Ownership

The PTY injection claim owns ordering from readiness check through the split
write. The input FSM owns composer reconstruction, slash mode, prompt capture,
and turn advancement. The raw-output ring and existing screen adapter own
acknowledgement evidence. The MCP handler owns the bounded wait and receipt
serialization. No durable submission registry is created: the receipt lives for
one request, while ordinary per-session lifecycle state continues afterwards.
