# Native plans and stories

## Story backend

Beside the title the header names the story backend with a state dot: **FastAF native**, or an external connector such as **Wiz**. A second word appears only when the backend needs something ("Wiz · needs approval", "Wiz · unavailable"). Click the name for a popover that says how it was chosen and where the connector is installed (Chosen, Connector, Installed at, Fingerprint) and offers **Use FastAF native** and **Use automatic selection**. A detected Wiz project does not fall back to native when its connector is missing or broken. While a connector waits for approval nothing can be read, so the dialog body is the question: "This project keeps its plans and stories in Wiz", the installation path and fingerprint, and one button, **Approve installed Wiz connector**. Approve only after you inspect the displayed path. This one approval applies to every Wiz project on that host; installation updates require new approval. Native plans must be completed or archived before an external backend can take over. Running or paused executions prevent a bound backend change. Refresh and project changes reload both identity and supported controls.

Choose **All plans** in the Plans column to show stories from every non-archived plan together in List or Kanban. Each story row and card shows its plan title. Status, type and archived-story filters apply to the combined view. **Archived plans** switches the combined view to archived plans only, as it does for a single-plan view. Select a specific plan to filter back and enable plan editing or story creation. Story detail, status actions, workflow starts and run history use the selected story’s own plan; dependency choices stay inside that plan.

New story and Edit plan keep the primary action, then Cancel, together at the bottom-left. New story has no permanent manual-prefix hint below acceptance criteria; `[MANUAL]` criteria remain supported. Story Edit stays in the story header. Disabled Add dependency exposes its reason as a native tooltip and accessible description.

The selected plan has **Edit plan** and **Archive plan** actions together in the Plans column. **Archived plans** stays with the plan-list filters. Edit plan and New story each use the main dialog area instead of a narrow list column. In Edit plan, choose a **Repository plan document**, or choose **Other link…** to enter a document path or URL in **Plan document or link**. A repository source path appears once below the picker. **Open** opens a local document in a file tab and leaves the dialog, or opens a URL in the browser. When Save is disabled, its reason is available on hover as a native tooltip and to assistive technology, without an extra line in the form. Save sends only changed fields using the revision captured when editing started. A conflict keeps the draft and requires Cancel and reopening Edit plan to load the latest version; an active-coordinator refusal keeps the source draft and displays the backend remedy. Successful saves refresh the plan list. Plan state appears in the detail pane. Header tabs stay on one scrollable row at narrow widths.

Native plans have a stored `revision`. `update_plan` takes `plan_id`, `expected_revision`, and `patch` with optional `title` and `source`. At least one field is required. The shared service validates both fields and commits them with one revision increment in one transaction; stale revisions leave the plan unchanged. Existing records start at revision 1. A metadata change changes the workflow planning and verification fingerprints, including plans with no stories. Source prose stays in the external document; the update does not move or rewrite that file. Source-changing edits are refused with a user error while a plan coordinator/planner attempt is running, including an unbound attempt or a paused run. Finish the coordinator or cancel its run first. Title-only and unchanged-source edits remain allowed. The same action is available through MCP, HTTP, desktop IPC, and `tuic story`.

Native stories are managed directly in FastAF. Plans, stories, criteria, dependencies, and revisions are stored in its configuration directory. A plan names one project and a source document; its state is derived from its stories.

Open a project, then select **Plans and Stories** in the toolbar. Choose **New plan** to see Markdown plans in the project's `plans/` and `.claude/plans/` directories. Select a plan; its title comes from its front-matter `title` or first Markdown heading. Files in nested directories such as `plans/archive/` are excluded. Choose **Refresh** after an agent creates a plan file. **Add from path or link** remains available for another document; a web link needs a typed title because its document is not read locally. Add stories with acceptance criteria, priority, an optional story type, and optional relative file paths. Select a story to inspect its criteria, dependencies, and status. To work without an agent terminal, choose **Start work**, check criteria as they are met, then **Submit for review**. Approve the story or request changes; blocking and "Won't fix" are explicit manual actions. A dependency can be added while a story is Ready or Backlog. The dialog works in both desktop and browser mode.

Story details show the persisted origin, plan step, revision and claiming session. A live terminal name appears beside the stable session ID; closed or unavailable terminals retain the ID. Transition history shows committed commands, revisions and actors in backend order, with Refresh history and explicit loading, error and empty states. Transition history uses readable command labels and 1-based criterion numbers, with the current criterion text when available. Actors show a live session name or an eight-character session ID; hover the actor to see the complete session ID. The current history API does not return timestamps. New story offers Native or Plan step origin; a plan-step story requires a step label.

The dialog keeps the same viewport-bounded size when you switch tabs or select a story or plan. Long content scrolls inside its columns. On desktop, choose **Open in separate window** in its header to detach it into a resizable window. Choose **Bring back to main window** to return it; closing the detached window also restores the dialog. Browser mode keeps the dialog inline.

Use **Status** to show all, open, or closed stories. Open includes every native status except **Done** and **Won't fix**. Combine it with **Story type**: feature, fix, refactor, chore, task, or untyped. Existing stories and creation requests that omit a type remain untyped; no type is inferred from origin or title. These filters and the **List / Kanban** switch remain selected for the application session, including when the dialog is detached and brought back. Detached windows receive the current controls in their panel parameters and return changes through the shared panel-action channel. The board has one column for each native status and uses the same filtered stories as the list. Select a card to inspect its story. Drag a card to change its phase: dashed outlines show legal destinations and the hovered destination has a solid outline. Release to submit the backend command with the displayed revision. An illegal destination or a backend refusal leaves the card in place and shows the reason. Escape cancels a drag. In List, each row has a keyboard-accessible Phase selector; selecting a destination submits immediately. Story detail groups the labelled Phase selector with Edit below the title. Selectors show only backend-provided legal destinations; automatic QA and dependency-bound destinations come from the same transition evaluator as a committed move. Archived records have no phase moves. A phase-read failure disables that selector and exposes its reason as a tooltip. It follows the Wiz Kanban column and card layout, but is a core Solid view with native story data. The separate Wiz plugin is unchanged.

The close button receives keyboard focus when the dialog opens. If the running backend predates native stories, the dialog asks you to restart FastAF to load the newer backend.

A failed project read shows a plain read error with its path and **Retry**, not internal error codes or empty-project guidance. Retry reloads the project without discarding an open plan draft; a confirmed empty result shows plan creation controls.

Before loading plans, the dialog checks whether the running backend has native story support. A missing capability prompts a restart; a story action error remains visible as that action's error, shown as the plain message (for example `criteria are incomplete: unchecked indexes 1` or `plan document not found: <path>`), not as the raw HTTP response. In the Workflows dialog, **Publish** is disabled until the draft is saved.

"Won't fix" cancels a story without delivering its output. It never satisfies a dependency or releases a dependent story for work. The Rust service marks a story **abandoned** when it or any dependency path reaches a cancelled story; the dialog renders that label. A human can remove a direct cancelled prerequisite from a Backlog story; this changes that story's requirements and makes it Ready only when every remaining prerequisite is Done. A separate Blocked story is never automatically unblocked. A plan remains Active while an unfinished dependent remains. A nonempty plan becomes Done when every story is either Done or Won't fix; an empty plan stays Draft. The service supplies the cancellation count and **All cancelled** flag to the dialog.

A story's detail has a **Delivery workflow** section: its delivery runs as rows (state dot, short run ID, status, and **Resume** on a running run that lost its owner), a refresh icon, **Run delivery workflow** to start one, and **Edit in Designer**. The **Workflows** button in the header opens the Workflows dialog; it replaces the Stories / Run history / Designer pills and **Start story workflow** of earlier versions. Manual story work does not require a run.

The Workflows dialog has four views. **Designer**: on the left Drafts, Templates, Activities and Published; in the middle the steps of the open draft, with one **Add step** menu; on the right the open step (label, configuration, input mappings, and where each outcome leads). **Triggers**: saved trigger bindings and the open one, each with **Enable binding** or **Disable binding**. **Preview**: **Run preview** on sample input, and **Inspect a run** by its ID, which reads a run's saved state and never resumes or changes it. **Definition**: the draft as JSON. **Validate**, **Save draft** and **Publish** act on the open draft; Publish waits until the draft is saved. A published workflow opens read only, with **Customize in a new draft**. Escape closes Workflows before Plans and Stories. The run history, incident list and graph canvas of the legacy workflow engine are gone with it (see [what was removed](../backend/workflows.md#legacy-engine-removed-3034-365e)).

Use `tuic story '<JSON action>' --project /absolute/project` to call the story service. For example:

```sh
tuic story '{"action":"create_plan","title":"Release","source":"plans/release.md"}' --project /absolute/project
tuic story '{"action":"list_plans"}' --project /absolute/project
tuic story '{"action":"list_plan_sources"}' --project /absolute/project
tuic story '{"action":"add_plan_source","source":"plans/release.md"}' --project /absolute/project
```

The result is JSON with a `type` and `value`. Supply the returned plan ID when creating a story:

```sh
tuic story '{"action":"create_story","input":{"planId":"PLAN_ID","title":"Implement","criteria":["Behavior verified"],"priority":1,"origin":{"type":"native"},"fileScope":[]}}' --project /absolute/project
```

Selecting a New plan source that already belongs to an archived plan shows its title and ID with instructions to enable **Archived plans**, select it, and choose **Restore plan**. This does not create a duplicate or restore the plan implicitly; an active source match still selects its existing plan.

## Amend a story

`update_story` takes `story_id`, `expected_revision`, and a camel-case `patch`. Omitted fields stay unchanged. The patch accepts `title`, `priority` (1–3), `fileScope`, `origin` (including a plan step), nullable `storyType` (`feature`, `fix`, `refactor`, `chore`, `task`), optional `problem` and `risk` (`low`, `medium`, `high`), ordered `criteria`, and the final `dependencies` set. Null clears `storyType`, `problem` or `risk`; old story records default both to absent. Unknown fields, invalid values, cross-plan dependencies, duplicates, cycles and stale revisions are rejected without partial story writes. Only unclaimed Backlog/Ready stories without active or paused workflow ownership can be amended. QA, like In progress, is not editable: manual verification must stay bound to its requirements. Unique byte-identical criteria retain their checks after reorder; changed, new or ambiguous duplicate criteria become unchecked. A priority-only patch preserves all checks. Amendments do not rewrite append-only story notes: a note keeps the subject revision recorded when it was added, even after a later amendment. Dependency changes recompute readiness. Planning and execution fingerprints include the amended requirements/revision, so existing evidence cannot certify changed work.

```sh
tuic story '{"action":"update_story","story_id":"STORY_ID","expected_revision":1,"patch":{"priority":3}}' --project /absolute/project
```

In StoriesDialog, select an eligible story and choose **Edit**. Edited titles must contain 1 to 200 Unicode characters after trimming. Invalid titles disable Save without truncating the draft. One form edits the title, priority, type, origin/plan step, problem, risk, ordered criteria, file scope and dependencies. Each criterion has its own textarea, with Add, Remove, Up and Down controls. Editing or moving one entry preserves every other entry exactly, including embedded newlines and indentation. File scope uses one path per line. **Save** sends only changed fields with the revision captured when Edit opened; **Cancel** discards the draft. The form hides lifecycle controls while editing. A revision conflict keeps the draft visible and never retries against a newer revision. Cancel and reopen Edit to load the latest record before preparing a new amendment. Workflow ownership is checked by the backend on Save, even when Edit was available when the form opened.

Read `get_story` first and use its current revision. After a revision conflict, reload the story before preparing another amendment. `criteria` and `dependencies` are final lists, not incremental commands. The existing `remove_dependency` action keeps its narrower cancelled-prerequisite rules; use `update_story` for a full requirement amendment before work starts. Plan ownership cannot be moved by this patch.

Changes to an existing story take its current `revision` as `expected_revision`; a stale request is rejected. The `start_manual` transition moves a Ready story into progress without a PTY claim. A terminal `claim` instead takes `--session-id` with a live PTY ID from the same project. Closing that tab releases its claim. A session-bound agent can perform the same transitions as other trusted callers. `transition_history` shows who performed each committed transition, including approval. Any trusted caller can approve after checking the acceptance criteria. Sessionless local HTTP records `local_api` provenance; a valid token records `human` provenance. These labels describe the transport, not a verified person. The desktop and browser dialogs both offer approval.

To remove a cancelled prerequisite, any trusted caller, including a session-bound agent, can send `{"action":"remove_dependency","story_id":"DEPENDENT_ID","dependency_id":"CANCELLED_ID","expected_revision":2}`. Use the dependent story's current revision as `expected_revision`. The dependent must be in Backlog and must already list the prerequisite as a dependency. The prerequisite must belong to the same plan and be Won't fix. Stale revisions, non-Backlog dependents, missing dependencies, and prerequisites in another plan or any state other than Won't fix are rejected.

Caller identity does not restrict dependency removal. Managed MCP calls, the Plans and Stories dialog, and CLI or HTTP calls use the same state and revision rules within their project scope. A managed caller does not need to omit its session identity to remove a dependency.

The same records are available through desktop IPC, guarded HTTP, and the `story` MCP tool. `Done` records an approval with actor provenance. In a manual plan with no workflow run, approval immediately releases dependents whose other prerequisites are Done. Once a workflow run owns the plan, a dependent remains held until its accepted prerequisite has a current integration receipt: the checked source commit must be merged into the canonical branch and FastAF must pass the published checks on the merge result. A later unrecorded ref or tree change invalidates that proof. Import, export, and bidirectional external sync are not supported. The optional mdkb search projection below is read-only.

API and CLI callers can filter `list_stories` by native `state` (including `qa`), `priority`, and `story_type`. Add `limit` (1–100) to page the results, then send the returned `next_cursor` as `cursor` with the same plan and filters. The `value` field stays an array; no cursor means the final page. Omitting `limit` preserves a complete filtered list. For example: `tuic story '{"action":"list_stories","plan_id":"<id>","state":"ready","priority":1,"story_type":"fix","limit":25}' --project /absolute/project`. Dispatch order is not affected.

## Manual QA

The dialog shows QA in the story list and its own Kanban column. Select **QA only** in the Status filter. In story details, check the manual criteria, then select **QA passed** or **QA failed**. **Submit for QA** is available during development or review; the backend validates its criteria.

Use the **QA** state when development is complete and only human checks remain. Prefix a manual criterion with `[MANUAL]` when you create the story, or send a transition command such as `{"set_criterion_manual":{"index":1,"manual":true}}`. Set `manual` to `false` to remove the marker. Indexes start at zero. The marker is part of the criterion text, not a second checklist.

Starting work, claiming a story, checking or unchecking a criterion, changing its manual marker, and submitting review evaluate QA readiness in the backend. An In progress or Review story enters QA when at least one criterion is unchecked and every unchecked criterion is manual. An open non-manual criterion prevents QA. An all-manual story enters QA when work starts. This automatic transition shares the triggering revision and transaction and releases its terminal claim.

Use `"submit_qa"` to move an In progress or Review story to QA explicitly. It requires at least one manual criterion and no unchecked non-manual criteria. In QA, check each manual criterion after it passes, then send `"approve"` to reach Done. Approval refuses any unchecked criterion. Send `"reject_qa"` after a failed check to return to In progress. Unchecking a non-manual criterion or removing the manual marker from an unchecked criterion also returns the story to In progress. All commands require the current `expected_revision`.

If a workflow starts a Ready story whose checks are all manual, the story enters QA and the run pauses before it reserves an implementer spawn or creates a worktree. While QA remains pending, resuming the run does not launch an implementer. After QA approval, resume settles the unspawned implementation attempt from the durable Done story, including after daemon recovery. The run records native approval instead of an agent report. No spawn, worktree, check receipt or integration receipt is invented; later workflow steps retain their normal requirements. Blocked, Backlog and Won't fix stories pause before implementation. Fail QA back to development when implementation changes are required.

QA is not Done: it keeps a plan Active and does not release dependent stories. Story lists return `status:"qa"`; the project summary reports a separate `qa` count. The **Waiting on you** list at the top of Plans and Stories shows stories that wait for a manual check, including after an agent attempt completes. Existing stored story documents, revisions and checks are retained without a JSON rewrite when the status constraint is upgraded.

## Which caller can do what

| Caller | Scope | Reads | Story actions (claim, check criteria, submit review, add dependency, create, approve) | Administrative actions (reject, block, unblock, won't fix, start manual, remove dependency) |
|---|---|---|---|---|
| `story` MCP tool in a managed session | The session's own registered project only | Yes | Yes | Yes |
| Plans and Stories dialog | The open project | Yes | Yes | Yes |
| `tuic story ... --project /abs/path` (HTTP `POST /stories/action?path=...`, loopback or authenticated) | Any project named by `--project` | Yes | Yes | Yes (actor provenance follows the session or credentials) |

An orchestrating session in another project cannot read or approve this repo's plan through its `story` MCP tool: the tool resolves the project from the calling session, so a plan id of another project is refused with `plan does not belong to project`. It can do both from a shell with `fastaf story '{"action":"plan_view","plan_id":"..."}' --project /abs/path/of/the/repo` and, for review, `{"action":"transition","story_id":"...","expected_revision":N,"command":"approve"}`. That path carries no session identity, so it records local API provenance unless credentials are supplied; as stated above, this is a workflow convention, not a security boundary. No cross-project MCP path exists, and none was added.

## MCP tool schema

Send the service action itself as the tool arguments, for example `{"action":"list_plans"}`. The `story` tool publishes the full `StoryAction` JSON Schema (actions, fields, types, enums, the `origin` tag shape, priority range 1 to 3) in its `inputSchema`. It is generated from the Rust types, so it follows the code. Story fields inside `input` and `patch` are camelCase (`planId`, `fileScope`) while the action fields are snake_case (`story_id`, `expected_revision`). The former `workflow action=story` envelope is refused; there is no alias.

Actor identity is tracking only and never restricts an action. Localhost remains trusted, including local token exchange. Administrative story decisions use the same state and revision rules for human, local API and managed callers.

A workflow plan reaches Done after all stories are approved and their integration checks are current. Moving the canonical branch or committing new work returns the plan to Active until those checks are recertified. Manual plans continue to finish through approval.

## Notes through the API and CLI

Append commentary with `tuic story '{"action":"add_note","story_id":"STORY_ID","expected_revision":1,"text":"Verified the observable effect"}' --project /absolute/project`. Read it with `{"action":"list_notes","story_id":"STORY_ID"}`. The backend records the author provenance, time, and subject revision. Notes cannot be edited or removed, and adding a note does not change the story revision or invalidate its workflow evidence.

An optional `receipts` array holds up to 16 `{runId, commandId}` references to persisted workflow receipts in the same project and plan. These are references, not copied results or proof of current approval. Note text is required and limited to 16,000 characters. The same actions are available through `workflow action=story` MCP, HTTP, and desktop IPC. Select a story and use **Notes and evidence** to read its trail. Each entry shows author provenance, time, the revision it was written against, and any workflow receipt references. Enter text in **Add note** and choose **Append note**. Errors keep the draft; a confirmed append clears it. Use **Refresh notes** to load a note added by an agent or another window. Selecting another story starts a separate empty draft.

### Reversible native record archival

In Plans and Stories, **Archive plan** and **Archive story** move the selected record out of the default list. Use **Archived plans** or **Archived stories** to select archived records, then choose **Restore plan** or **Restore story**. The toggles are independent, so archived stories remain reachable inside active plans. Archived detail stays readable; restore before starting work. Backend refusal messages remain visible when a claim or active run owns the record.

All native story transports share `archive_story`, `unarchive_story`, `archive_plan`, and `unarchive_plan`. Story actions take `story_id`; plan actions take `plan_id`. Each requires `expected_revision` and returns the updated record with its incremented `revision` and `archived` flag. Stale revisions fail without a write. Archival preserves status, criteria, dependencies, and child archive flags; it never deletes records or cascades to children.

`list_plans` and `list_stories` default to `archived: false`. Set `archived: true` to select archived records. The story filter combines with the other filters and is bound into pagination cursors. Direct reads remain available. Default plan views and workflow dispatch omit archived stories; archived plans and stories cannot start manual or workflow work. Restore the parent plan before starting its stories.

Both archive and restore refuse claimed stories and plans that contain a claimed story. Story archival also refuses any prerequisite that is not Done while an open dependent references it, including inside an archived plan. The refusal lists the dependent IDs and leaves the record and history unchanged. WontFix does not satisfy dependencies. Done prerequisites and unresolved stories with only closed dependents remain archivable. Adding a dependency to an archived unresolved story requires restoring it first; both dependency editors enforce this rule. Whole-plan archival does not change dependency readiness. An active or paused plan-root workflow owns the plan's story set. A story-root workflow owns its target and execution stories, not unrelated siblings. Cleanup of an owned story or its parent plan is refused until the run ends. The workflow writer lock remains held through the archive transaction, so a concurrent run cannot start between the ownership check and the write.

`story_archive_history` (`story_id`) and `plan_archive_history` (`plan_id`) return `{type:"archive_history",value:[{revision,archived,actor}]}` in revision order. Events commit atomically with the record and retain caller provenance. Existing status transition history remains separate. Consecutive archive-only revisions preserve accepted-work integration receipts; a work change or a moved canonical Git ref still invalidates them. Example: `tuic story '{"action":"archive_story","story_id":"<id>","expected_revision":1}' --project /absolute/project`.

## Ideas through the planner

Ideas are separate from append-only story notes. They use the Ideas panel's `notes.json`, not the story database. No plan is required.

```sh
tuic story '{"action":"add_idea","text":"Investigate a smaller build","source":"ego"}' --project /absolute/project
tuic story '{"action":"list_ideas"}' --project /absolute/project
tuic story '{"action":"update_idea","idea_id":"note-ID","text":"Investigate the incremental build"}' --project /absolute/project
```

The same inputs work as arguments of the `story` MCP tool. MCP uses the calling session's project. CLI and HTTP use the named project. `add_idea` records the owning repository's registered UI key as `repoPath`. Canonical Windows paths and existing symlink aliases resolve to that same key. Existing Ideas with equivalent canonical paths also use the registered key when loaded; `list_ideas` includes that project's Ideas and global Ideas, just like the panel. `update_idea` can change only text on an Idea owned by that project. It preserves the id, timestamp, source, image list, used state and repository assignment. Global Ideas are visible but cannot be updated through a project-scoped action.

Text is trimmed and must contain 1–16000 characters. Optional `source` must contain 1–256 characters after trimming. Without it, the source is the bound session id, or `local-api` for a sessionless request. Replies are `{type:"idea",value:Idea}` for add/update and `{type:"ideas",value:Idea[]}` for list. Idea records have camelCase fields: `id`, `text`, `createdAt` (Unix milliseconds), `repoPath`, `repoDisplayName`, `usedAt`, `images` and `source`.

All mutations use the backend's locked notes writer. An `ideas-changed` desktop/SSE event reloads the panel without saving the read back. Local edits finish before reload; stale UI snapshots apply only their changed ids and fields to current disk state. They cannot remove unseen agent additions or restore a remotely deleted Idea. Concurrent text edits use the last committed text intent.

## Draft a story from a request

In **New story**, type the request in plain words and choose **Fill with AI**.
The configured ego executable and model run one isolated, unattended turn through
TUIC's existing one-shot path. No new provider client or API key is used.
Title, story type, priority, problem and acceptance criteria fill the editable form.
Nothing is saved by Fill: review and edit the fields, then choose **Create story**.
Manual creation remains available without AI.

A filling status and **Cancel fill** action stay visible during generation.
Cancel stops the owned model turn and waits for connection shutdown when it has
started; cancellation during initialization waits for initialization cleanup before
shutdown, without submitting a prompt. Failed or malformed replies keep the request
and existing form fields. Late cancelled replies never replace the draft.
Generated criteria are one requirement per line; `[MANUAL]` stays a native QA marker.
The reviewed problem is saved atomically with creation through the optional
`problem` field beside `input` in the `create_story` action.

For a remote repository, Fill with AI reserves, generates and cancels on the
repository's owning daemon. Changing the viewed project or closing the dialog
does not move cancellation to a different machine.

## Search native stories with mdkb

When an mdkb daemon with external-ingest support is running on the owning host,
FastAF pushes native stories into its project index under source
`tuic-stories`. Search by a title, acceptance-criterion phrase or note with
`mdkb search "phrase" --root /absolute/project`. Closed and archived stories
remain searchable. The result is read-only: use the native story tools to change
it, not mdkb. Plans remain their existing source documents.

The story database remains authoritative. No story Markdown file is written to
the project, and there is no `.tuic/stories` directory to commit or ignore.
Committed story changes and notes wake a background sync on both desktop and
headless hosts. Network calls never run inside a story mutation. An unavailable
daemon does not prevent creating, editing, checking or closing a story.
FastAF retries every 30 seconds and compares story IDs and ingest revisions
on each connection, sending only missing or newer records. It does not start or
restart the daemon for this integration. The project must be admitted by mdkb's
root whitelist.

The persisted ingest revision also advances for notes, without changing the
story revision used by workflow proof. A deletion retains an ingest tombstone;
archiving is not deletion. Another isolated FastAF instance can index the
same project, so unknown IDs in mdkb are not deleted. Push failures are logged and
retried. A document exceeding mdkb's 4 MiB request limit remains unsynchronized;
its story mutation still succeeds. Restoring an older story database can leave
mdkb with a newer revision: this conflict is logged, not silently overwritten.
The indexed update time begins at migration for existing stories; it does not
claim to reconstruct historical transition times.

Story search synchronization retains its durable ledger when a project directory is removed. Missing paths and paths replaced by files are skipped without RPC attempts or repeated warnings. Synchronization resumes automatically when the project directory exists again; other projects continue syncing.

### Read legal phase moves

`available_transitions` takes `story_id` and `expected_revision` and returns `{type:"available_transitions",value:{revision,moves:[{status,command}]}}`. It does not change the story or transition history. The backend evaluates the same status, criterion, dependency, archival and workflow-start rules as a commit; each destination appears once. Actor-specific approval rules still apply. The reply is a snapshot, not a reservation: submit the chosen command through `transition` with that revision. A stale revision fails without a write; refresh before preparing a new move. This action shares the existing IPC, HTTP, CLI and MCP story envelope.

The Plans and Stories toolbar pill shows active-plan, Ready and In progress counts with distinct glyphs and a tooltip line for each number. Ready comes from the Rust `summary` action, not a frontend subtraction; Done/total remains the progress bar tooltip. Ready-only work therefore remains visible when no story is running.

### Backend continuity and approval identity

Automatic detection retains native while native plans are open or pinned native
executions are active. The backend popover explains **Native retained while …**; this is
not fallback after a failed Wiz connector. Open the popover to choose
**Use FastAF native** or **Use automatic selection**. Explicit Wiz cannot replace
open native work, and selection changes cannot interrupt active executions.
Registry scopes resolve local > project > user for the canonical owning project;
remove duplicate winning-scope installations in the plugin manager if requested.
Approval binds the displayed installation and entry/version identity. Dependencies
are not fingerprinted. A changed entry/version between display and click requires
refresh and a new approval. Active runs pin backend provenance in their existing
snapshot. Runs started before this release keep the backend they used then: the
legacy command binding if one exists, otherwise native. No native or external records are migrated.

### Limited external editing

A backend can offer title, priority and criterion addition without promising the
full editor. Edit remains available for supported fields; unsupported metadata
and editor dependencies are disabled. Save one title, one priority, or one new
criterion at a time. Multiple simultaneous changes cannot be saved. Native and
legacy full-edit backends retain their existing editor behavior.
