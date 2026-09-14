# Type Pending PTY Deliveries Without Splitting Their FIFO

## Problem

FastAF has two producers for deferred PTY submissions: peer/orchestrator wake delivery and user-composed commands from the Compose panel. The initial Compose implementation stored both as plain strings in `pending_injections`. As a result, the Compose queue count included peer deliveries and clearing the Compose queue deleted peer deliveries whose authoritative inbox entries still expected a later terminal wake.

Delivery order is also observable. A deferred peer message and a deferred user command must be submitted in the order in which the backend accepted them, one item per confirmed idle window. Separating the producers into independently drained queues would require a new priority policy and could reorder an already accepted delivery.

## Decision

Keep one per-session `pending_injections` FIFO, but type each entry as either `PeerMessage` or `UserCommand`. All producers append to the same tail and the idle gate always removes the head. Compose count and clear operations inspect only `UserCommand` entries; clearing retains every `PeerMessage` in its original relative position.

The type is backend-internal. Tauri and HTTP responses continue to expose only the number of queued user commands, so IPC/HTTP parity and the frontend contract remain unchanged.

## Why the Existing Mechanism Is Insufficient

A plain string carries payload but no ownership. Content-prefix inspection is not safe because user commands may begin with the peer framing text and framing formats may evolve. Clearing the whole queue violates the peer-delivery lifecycle, while reporting the whole queue leaks an unrelated transport concern into the Compose UI.

## Alternatives Considered

- Two queues, with peer messages always first: rejected because a later peer message could overtake an earlier user command.
- Two queues, with user commands always first: rejected because a later user command could overtake a peer wake and delay orchestration.
- Two queues selected by enqueue timestamps: rejected because it recreates a merged FIFO with more state and synchronization.
- Infer ownership from payload prefixes: rejected because payload text is not an ownership boundary.

## Trade-offs

The queue element is slightly larger and tests must construct typed entries. In return, ownership is explicit and the existing global FIFO needs no scheduler or compatibility behavior.

## Failure Semantics

If a claimed PTY write provably does not start, the exact typed entry is restored at the front, preserving both ownership and order. An uncertain write is not retried, matching the existing duplicate-avoidance rule. Clearing Compose commands never removes or retries peer messages. Session teardown still drops the entire transient queue; the authoritative peer inbox remains the recovery source.

## Lifecycle and Ownership Boundaries

The backend owns queue classification, ordering, claiming, retry placement, counting, and clearing. The Compose frontend owns only user intent and displays the user-command count returned by the backend. Peer inbox ownership and delivery settlement remain unchanged: a queued peer message is not marked dispatched until the PTY path actually takes ownership.
