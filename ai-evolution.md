# AI Evolution

**Status:** Proposed
**Created:** 2026-08-18
**Last audited:** 2026-08-18

## Purpose

This document defines how FastAF's AI surface should evolve from the
current partially unified implementation into a dependable terminal-native
copilot.

It records three distinct things:

1. observed behavior in the current codebase;
2. product and architecture decisions for the target system;
3. ordered work with verifiable exit criteria.

The earlier [AI System Unification](plans/ai-system-unification.md) and
[AI Chat Capability Roadmap](plans/ai-chat-capability-roadmap.md) plans remain
useful implementation history. Where their intended behavior conflicts with
the audited implementation or this direction, this document is authoritative.

## Product Thesis

FastAF should not compete as a generic chat client. Its useful and
defensible role is a copilot that understands the exact terminal the user is
looking at, can explain what happened, and can propose or perform the next safe
action.

The primary workflow is:

1. observe the current terminal and structured shell history;
2. explain the relevant state or failure using concrete evidence;
3. propose the smallest useful next action;
4. let the user copy, insert, approve, or run that action;
5. retain enough conversational and execution history for meaningful
   follow-up questions.

Tool count, background automation, and provider breadth are secondary. They do
not compensate for missing conversational memory, ambiguous safety semantics,
or unreliable lifecycle behavior.

## Current-State Baseline

The following is observed in the code as of the audit date.

### Working foundations

- AI Chat is attached to the focused terminal and keeps independent frontend
  state per terminal session.
- The backend assembles live terminal context, including recent output, shell
  state, current working directory, agent state, and structured OSC 133 command
  knowledge when available.
- Chat and agent execution share one Rust conversation engine.
- Responses stream over a Tauri Channel on desktop and a dedicated WebSocket in
  browser mode.
- Markdown, extended reasoning, tool activity, approval controls, cancellation,
  pause, and resume have UI surfaces.
- The provider registry supports a Main model plus phase overrides, although
  not all of that configuration is exposed correctly in the frontend.
- The engine has rate limiting, repetition detection, context compaction,
  filesystem tooling, terminal tooling, watchers, and scheduling infrastructure.
- Desktop chat messages can be stored in per-conversation JSON files.

### Incomplete or misleading behavior

#### No conversation memory at inference time

`conversationStore.sendMessage` sends only the newest text and terminal session
ID. `conversation_engine` creates a new model request containing only that user
message. Previously displayed or loaded messages are not included.

The model receives fresh terminal context on every turn, but it does not receive
the preceding conversation. The transcript is therefore a display history, not
model memory.

#### Panel controls are not wired to execution

The panel exposes a model override and maximum agent steps, and Settings exposes
temperature. These values are not passed by the current send/start paths.

Consequences:

- maximum steps remains `None`, limiting execution to one tool-use round trip;
- temperature falls back to the backend default of `0.7`;
- the visible model selection does not affect the request;
- reasoning effort is the only AI Chat setting with an active backend fallback.

The model picker also reads `slots["Main"]` while slot keys serialize as
lowercase, and it lists model names without preserving their provider identity.
The backend model override replaces only the model name while retaining the
Main provider client and credentials.

#### Safety semantics do not match the UI

Selecting Autonomous mode automatically adds the terminal session to
`unrestricted_sessions`. Approval-required tool calls are then dispatched as
approved. The separate unrestricted lock in the panel does not represent a
meaningful additional escalation.

Scheduled jobs also use Autonomous mode even though their source documentation
states that they run with standard trust. Watcher and suggestion flows that
start an autonomous conversation inherit the same behavior.

Assisted mode receives the complete tool catalog as well. Tools that do not
request approval may execute, so Assisted is not equivalent to passive Q&A.

#### Persistence is a partial frontend projection

- Saved messages are not sent back to the model.
- Agent goals, tool calls, tool results, agent state, and reasoning are not
  persisted by the production frontend path.
- The backend schema supports tool-call records, but the frontend writes schema
  version 1 with plain text messages only.
- Provider and model metadata are read from legacy AI Chat configuration rather
  than the active provider registry.
- In-memory truncation is applied before saving, despite documentation claiming
  full disk history.
- History timestamps are stored in Unix milliseconds but rendered as if they
  were seconds.

#### Browser and detached-window parity is incomplete

Browser streaming exists, and HTTP conversation CRUD routes exist, but the
frontend persistence and history functions return early outside Tauri instead
of using the shared transport wrapper.

Detached AI Chat receives only an initial chat ID. The detached window has its
own empty terminal and conversation stores, so sending, active-session tracking,
stream recovery, and agent controls are not synchronized.

The Rust `ChatRegistry` cannot currently provide that synchronization. It has
subscribers and snapshots but no production producer. The current local
worktree removes the frontend subscription because its empty snapshot erased a
conversation immediately after history loading. That mitigation prevents data
loss; it does not implement cross-window synchronization.

#### Stream and lifecycle correctness are incomplete

- Assisted streaming and autonomous execution have separate frontend busy
  guards but share one backend active-conversation slot per session.
- Starting one mode while the other is active can change frontend routing state
  before the backend rejects the second request.
- Clear and history load do not first cancel or settle a running backend
  conversation.
- Loading history does not reset every conversation-scoped field.
- Tool events have no call identifier, so repeated parallel calls with the same
  tool name can be paired with the wrong result.
- A lagging event bridge may drop text chunks. The terminal `Completed` event
  does not contain the final assembled answer, so the frontend cannot repair a
  truncated stream.
- If the consumer disappears, the backend does not retain a transcript that a
  new consumer can replay.

#### Dead or stranded surfaces

- `ChatRegistry` fan-out and its mutable snapshot setters have no production
  producer.
- Legacy AI Chat pricing and usage helpers have no production data path; the
  conversation engine emits `usage: None`.
- The usage footer is therefore unreachable in normal operation.
- Legacy streaming and agent-event compatibility shims remain for tests but are
  not part of the production path.
- The code block UI implements Copy and Run, not Insert. Run sends multiline
  blocks one line at a time and is unsafe for shell structures such as heredocs.
- The user guide and Tauri command reference describe removed commands and
  unimplemented behavior, including full history, context controls, keyboard
  shortcuts, six-tool agent mode, and approval semantics.

## Product Decisions

### 1. Two modes with explicit capability boundaries

The product should expose two modes:

#### Ask

- Multi-turn conversation with terminal context.
- Read-only tools only.
- No terminal input, file mutation, scheduling, watcher creation, or process
  execution.
- Intended for explanation, diagnosis, search, and planning.

#### Act

- Multi-step tool loop with a visible step limit.
- Read-only tools execute automatically.
- Mutating tools follow standard approval rules.
- Pause, resume, reject, cancel, and approve operate on one authoritative
  backend run.

Unrestricted execution is a separate, explicit escalation. It must never be
implied merely by entering Act mode, and it must not be available to scheduled
or event-triggered work unless a future product decision explicitly introduces
that capability.

### 2. Rust owns conversation truth

The backend must own the durable conversation and active-run state. The
frontend is a projection and interaction surface, not the authority.

A conversation must include at least:

- conversation ID and attached terminal session ID;
- ordered user, assistant, system, and tool messages;
- turn IDs and tool-call IDs;
- selected provider/model and effective generation settings;
- current run state and iteration;
- usage, completion reason, and timestamps;
- the final assembled assistant response for each turn.

The backend must use the retained history when constructing every subsequent
model request. Context-window trimming and summarization happen in Rust and must
not silently alter the persisted source transcript.

### 3. One coherent run state machine

Chat streaming and tool-driven execution are two configurations of the same
run lifecycle, not separate frontend processes.

The minimum state model is:

```text
idle
  -> running
      -> awaiting_approval
      -> paused
      -> completed
      -> cancelled
      -> error
```

Only one run may be active for a conversation. Starting a new turn, loading a
different conversation, clearing history, detaching, or switching attachment
must have an explicit policy: reject, cancel-and-wait, or transfer. It must
never mutate the routing state optimistically and then rely on backend rejection.

### 4. Events are replayable and correlatable

Every stream event should carry:

- `conversation_id`;
- `turn_id`;
- monotonically increasing `sequence`;
- `tool_call_id` when applicable.

The terminal event must carry the authoritative final turn snapshot, including
the complete assistant text and usage. A subscriber must be able to reconnect,
request a snapshot, and continue from the last known sequence without depending
on every transient text chunk having arrived.

### 5. Configuration is effective or hidden

Visible controls must affect the next run and be represented in the effective
run metadata.

- Model selection uses a provider/model reference, never a bare model name
  detached from its provider.
- The default selection is the configured Main model.
- Temperature, reasoning effort, and maximum steps are passed explicitly.
- Phase overrides remain an advanced provider-registry feature. They should not
  get a separate UI until their effective routing can be inspected.
- Unimplemented controls are removed or disabled with an explicit explanation.

### 6. Transport parity is a release requirement

Tauri IPC and HTTP/WS represent the same backend contract. Store code must use
the shared transport abstraction for request/response operations. Dedicated
channels or sockets may carry streams, but their event shapes and recovery
semantics must match.

A desktop-only surface may be declared intentionally unsupported. A visible but
nonfunctional browser or detached-window control is not acceptable parity.

### 7. Capabilities follow core correctness

No additional tools, watchers, scheduling features, or autonomous triggers
should be added until the conversation, safety, persistence, and lifecycle gates
in this document pass.

Existing advanced capabilities may remain behind the experimental AI Chat flag,
but unsafe or misleading entry points should be disabled while their contracts
are repaired.

## Target Architecture

```text
AIChatPanel
    |
    | commands: send / cancel / approve / pause / resume / load / clear
    v
Shared transport abstraction
    |                         |
    | Tauri IPC + Channel     | HTTP + WebSocket
    v                         v
Conversation service in Rust
    |- durable transcript and metadata
    |- one active run state machine
    |- context assembly and history compaction
    |- provider/model resolution
    |- capability policy and approvals
    |- tool dispatch and correlation
    `- replayable event log / final snapshots
              |
              v
       Provider client + tools
```

`ChatRegistry` should either become the conversation service's subscription and
snapshot layer or be removed. It must not remain a second, disconnected source
of chat state.

## Delivery Plan

### Phase 0 — Make the current surface truthful and safe

Goal: prevent the UI and automation surfaces from promising behavior the
backend does not provide.

- Replace Autonomous-implies-unrestricted behavior with explicit standard
  approval policy.
- Ensure scheduler, watcher, and suggestion-triggered runs cannot inherit
  unrestricted execution.
- Define and enforce the read-only tool set for Ask mode.
- Hide or disable detached AI Chat until state projection is implemented.
- Hide usage, model override, maximum steps, and other controls that remain
  disconnected, unless they are wired in the same change.
- Correct the user guide, API reference, `SPEC.md`, feature list, sync matrix,
  and `to-test.md` to describe observed behavior.

Exit criteria:

- entering Act mode does not bypass approval or filesystem restrictions;
- every automatic trigger runs with standard trust;
- Ask cannot mutate the terminal, filesystem, scheduler, or watcher state;
- no visible control is known to be inert;
- exposed documentation matches the running contract.

### Phase 1 — Establish authoritative multi-turn conversations

Goal: make the chat itself correct before expanding capability.

- Introduce a backend conversation service keyed by conversation ID.
- Load or create a conversation before sending a turn.
- Include prior messages in each model request.
- Persist user, assistant, and tool messages using the existing extended
  conversation schema, evolving it only where necessary.
- Persist the final assembled text independently of streaming delivery.
- Add conversation, turn, event sequence, and tool-call identifiers.
- Return a complete snapshot on subscription and after terminal events.
- Aggregate real usage or remove usage from the contract until the provider
  adapters can supply it consistently.

Exit criteria:

- a follow-up can refer unambiguously to an earlier turn;
- reload preserves a usable conversation, including tool activity;
- reconnecting after lost chunks reconstructs the full final response;
- parallel repeated tool calls pair with their own results;
- frontend state can be rebuilt from one backend snapshot.

### Phase 2 — Unify lifecycle and wire configuration

Goal: make every user action deterministic and every visible setting effective.

- Replace the separate assisted/agent frontend busy guards with one run state.
- Lock mode and configuration while a run is active.
- Define cancel-and-wait behavior for clear, load, and attachment changes.
- Reset or restore all conversation-scoped UI fields as one transaction.
- Pass provider/model reference, temperature, reasoning effort, maximum steps,
  and capability mode through both transports.
- Make Act honor multiple tool iterations up to the visible step limit.
- Record the effective configuration with each turn.

Exit criteria:

- a three-step task can execute three correlated tool rounds;
- clear or load during a run cannot contaminate another conversation;
- two concurrent starts cannot reroute events in the frontend;
- inspection of a saved turn shows the settings actually used.

### Phase 3 — Complete persistence and client parity

Goal: provide the same conversation semantics wherever AI Chat is exposed.

- Route browser conversation CRUD through the shared transport wrapper.
- Add backend snapshot and replay support for detached windows.
- Project active terminal attachment changes to detached AI Chat.
- Reattach the main window without losing partial or completed output.
- Apply one retention policy to persisted history and a separate token-budget
  policy to model context.
- Correct provider/model metadata and timestamp rendering.

Exit criteria:

- desktop, browser, and detached clients load the same transcript;
- send, cancel, approve, and resume affect the same backend run;
- closing or reopening a consumer loses no completed content;
- unsupported platform-specific behavior is explicitly hidden.

### Phase 4 — Deliver the terminal failure copilot

Goal: turn the corrected foundation into a high-value workflow.

The first-class actions should be:

- **Explain last failure** — identify the failed command, exit status, relevant
  output, and likely cause with quoted evidence from the terminal context.
- **Suggest safest next step** — propose the smallest command or edit and state
  its expected effect.
- **Investigate** — use read-only tools first, then request approval for any
  mutation.
- **Copy / Insert / Run** — preserve multiline command structure, show the
  exact command, and use the established terminal command injection path.

Exit criteria:

- a non-zero OSC 133 command outcome opens a useful, context-grounded diagnosis
  in one user action;
- suggested actions distinguish evidence, inference, and uncertainty;
- Insert preserves the proposal for editing without execution;
- Run handles multiline shell syntax atomically and requests approval where
  required.

### Phase 5 — Reintroduce advanced automation selectively

Goal: build on a safe, observable conversation system rather than bypass it.

Candidates include scheduled tasks, reactive watchers, notifications, CI
investigation, and phase-specific models.

Each candidate must:

- create or attach to an inspectable conversation;
- use the same capability policy and approval engine;
- retain its transcript and effective configuration;
- expose cancellation and bounded execution;
- prove a recurring user workflow before adding new abstraction.

## Release Gates

AI Chat should remain experimental until all of the following pass:

- [ ] A second user turn can rely on the first turn's content.
- [ ] Ask mode cannot invoke any mutating tool.
- [ ] Act mode requests approval for mutating operations unless the user has
      explicitly enabled unrestricted execution for that run.
- [ ] Scheduled and event-triggered runs cannot use unrestricted execution.
- [ ] A step limit greater than one produces a genuine multi-step tool loop.
- [ ] Provider/model, temperature, reasoning effort, and step limit match the
      effective backend request.
- [ ] Tool calls and results are correlated by stable identifiers.
- [ ] Clear, load, terminal switch, cancel, and reconnect have deterministic
      behavior during an active run.
- [ ] Saved conversations contain assistant text and tool activity and can be
      used for model follow-ups after reload.
- [ ] A lost streaming chunk does not corrupt the final transcript.
- [ ] Browser and detached parity is either implemented or the unsupported
      surface is hidden.
- [ ] Usage shown to the user comes from real provider data.
- [ ] Copy, Insert, and Run preserve multiline command semantics.
- [ ] Documentation and manual-test tracking match the implementation.

## Cleanup and Deletion Candidates

These are not independent refactoring goals. Remove them when the replacement
path is established or when a phase proves they are unnecessary.

- producerless `ChatRegistry` scaffolding, unless adopted by the conversation
  service;
- legacy AI Chat provider/model/base URL fields and pricing helpers;
- frontend registry subscription compatibility code already removed locally;
- old agent/chat event shims with no production callers;
- schema-version paths that are tested but never written by production;
- stale Tauri command documentation and obsolete context-line configuration;
- usage UI until real usage is available;
- detached-window controls until snapshot/replay exists.

## Explicitly Deferred

- More tools solely to increase capability count.
- A context-lines slider; semantic context selection and token budgeting are the
  preferred model.
- A general-purpose autonomous background agent.
- Persistent blanket approval or unrestricted state across restarts.
- Cross-provider bare model overrides.
- A second frontend-owned synchronization protocol.
- New compatibility layers for behavior that has not shipped as a supported
  contract.

## Open Product Questions

These questions affect later detail but do not block Phase 0 or Phase 1.

1. Should a conversation remain permanently terminal-bound, or may it be
   reattached to another terminal with an explicit context boundary? The default
   is terminal-bound with explicit reattachment recorded as a system event.
2. What transcript retention policy is appropriate? The default is durable full
   transcript retention subject to an explicit user clear action, with separate
   compaction for model context.
3. Should provider/model selection remain visible per conversation? The default
   is to use Main and hide overrides until provider/model references are routed
   correctly and the effective selection is inspectable.
4. Which read-only tools belong in Ask mode? Classification must be audited from
   actual side effects; tool names or current approval behavior are not sufficient
   evidence.
5. Should scheduled tasks return after the core release? The default is yes only
   for bounded, inspectable jobs running with standard trust.

## Validation Ownership

Implementation may be performed incrementally by the appropriate engineering
owner. Exact `gpt-5.6-luna` exclusively owns tests, builds, checks, formatting,
linting, static analysis, security scans, release gates, and final green
confirmation, as required by the repository rules.

Every phase must include unit and integration coverage for its failure modes.
Desktop/browser transport parity needs mapping assertions. Visual changes need
screenshots. Rust changes require a fresh `make dev` test instance or release
build before runtime evidence is accepted.
