import { batch } from "solid-js";
import { pathStartsWith } from "../utils/pathUtils";
import { appLogger } from "./appLogger";
import { globalWorkspaceStore, MANUAL_SCOPE } from "./globalWorkspace";
import { placementWorkspaceFor, repositoriesStore, resolveRepoOwner } from "./repositories";
import { terminalsStore } from "./terminals";

/** A validated declaration owns display placement, never cwd or removal authority. */
export function getDeclaredTerminalWorkspace(terminalId: string): { repoPath: string; workspaceId: string } | null {
	const peer = terminalsStore.get(terminalId)?.tuicSession;
	if (!peer) return null;
	// Reconnect initially derives repoPath from actual cwd, which may now be in
	// another repo or unregistered. The stable declaration owns its containing repo.
	for (const repoPath of repositoriesStore.getPaths()) {
		const repo = repositoriesStore.get(repoPath);
		const declaration = repo?.declaredWorktrees?.[peer];
		if (!declaration) continue;
		const workspace = repo?.workspaces[declaration.workspaceId];
		// Removed or replaced checkouts retract the association before a refresh saves it.
		if (!workspace || workspace.worktreePath !== declaration.worktreePath || workspace.worktreePath === repoPath) {
			continue;
		}
		return { repoPath, workspaceId: declaration.workspaceId };
	}
	return null;
}

/**
 * Re-home terminals from an explicit declaration, otherwise their own cwd.
 *
 * A terminal whose cwd matched no registered repo is parked in the Global
 * Workspace, with `repoPath: null` recording that it has no owner yet. Nothing
 * used to undo that: registering the real repo afterwards left the tab stranded,
 * which is one half of the tabs showing up in the wrong place. (Until 2026-09-10
 * the parking spot was the ACTIVE repo, which was worse than stranded — two
 * sessions from one unregistered repo landed under two different repos depending
 * on where the user was standing.) The other half is a placement that was correct
 * once and went stale — a repo removed, a worktree added, a branch renamed.
 *
 * Both are the same question asked again: given this cwd and the repos we know
 * about NOW, who owns this terminal? Call it whenever that answer can change —
 * after repositories load, after one is added or removed, and after a terminal
 * reports a new cwd.
 *
 * Pass `terminalId` when only one terminal's answer can have changed. A `cd`
 * fires OSC 7 on every directory change, and walking every terminal against
 * every repo on each of those is work nobody asked for.
 */
export function reconcileTerminalOwnership(terminalId?: string): void {
	let moved = 0;

	const scope = terminalId === undefined ? terminalsStore.getIds() : [terminalId];
	for (const terminalId of scope) {
		const terminal = terminalsStore.get(terminalId);
		if (!terminal) continue;

		const declared = getDeclaredTerminalWorkspace(terminalId);
		const owner = declared ?? resolveRepoOwner(terminal.cwd);
		// Still unclaimed. Leave the parked tab where it is — moving it nowhere
		// would only make it invisible.
		if (!owner) continue;

		const workspaceId = placementWorkspaceFor(owner);
		if (!workspaceId) {
			// A selected linked checkout is not a substitute for an undiscovered root row.
			const current = repositoriesStore.findOwnerForTerminal(terminalId);
			if (current) repositoriesStore.removeTerminalFromWorkspace(current.repoPath, current.workspaceId, terminalId);
			terminalsStore.setRepoPath(terminalId, null);
			globalWorkspaceStore.promote(terminalId, MANUAL_SCOPE);
			continue;
		}

		// A null `repoPath` is the parked marker: this tab sits in the Global
		// Workspace because nothing claimed its cwd. Now something does, so it
		// leaves. The check has to happen BEFORE the placement below overwrites
		// the field — and it must be this field rather than "is it promoted",
		// because a tab the user promoted BY HAND is also promoted and owned, and
		// yanking that out from under them on every reconcile would be a second
		// bug wearing the first one's clothes.
		const wasParked = terminal.repoPath == null;

		const current = repositoriesStore.findOwnerForTerminal(terminalId);
		if (current?.repoPath === owner.repoPath && current.workspaceId === workspaceId) {
			// Placement already correct; the record may still be stale if the repo was
			// registered after the terminal was parked here.
			if (terminal.repoPath !== owner.repoPath) {
				terminalsStore.setRepoPath(terminalId, owner.repoPath);
				if (wasParked) globalWorkspaceStore.unpromote(terminalId);
			}
			continue;
		}

		appLogger.info(
			"terminal",
			`[Reconcile] ${terminalId} ${current ? `${current.repoPath}:${current.workspaceId}` : "(unplaced)"} → ${owner.repoPath}:${workspaceId} (cwd=${terminal.cwd})`,
		);
		batch(() => {
			if (current) repositoriesStore.removeTerminalFromWorkspace(current.repoPath, current.workspaceId, terminalId);
			terminalsStore.setRepoPath(terminalId, owner.repoPath);
			repositoriesStore.addTerminalToWorkspace(owner.repoPath, workspaceId, terminalId);
			if (wasParked) globalWorkspaceStore.unpromote(terminalId);
		});
		moved++;
	}

	if (moved > 0) appLogger.info("terminal", `[Reconcile] re-homed ${moved} terminal(s)`);
}

/**
 * What a terminal's new cwd is allowed to change about its placement: nothing,
 * unless nobody had claimed it yet.
 *
 * A `cd` is navigation, not a misplacement. The tab belongs to the repo it was
 * opened in — every deliberate placement records that owner in `repoPath` — and
 * the directory the shell happens to sit in does not revoke it. Calling the full
 * reconcile here instead moved the tab out from under the user, because the three
 * states that describe "where am I" are updated by different code and only this
 * one moved: `activeRepoPath` stayed on the old repo, so the sidebar and the tab
 * bar (which filters on it) kept showing it while the tab itself vanished from
 * the strip, and TerminalArea renders on `activeId` alone — so the pane went on
 * drawing a terminal that now belonged to a repo the user was not looking at.
 * Agents `cd` across repos constantly, which is why it read as the app switching
 * repo on its own.
 *
 * `repoPath === null` is the one case worth acting on. That tab is parked in
 * whatever repo was active because no registered repo claimed its cwd, and the
 * null records that the placement is a guess. A cd into a repo we do know answers
 * the open question, so the parked tab finally goes home.
 */
export function reclaimParkedTerminal(terminalId: string): void {
	if (terminalsStore.get(terminalId)?.repoPath != null) return;
	reconcileTerminalOwnership(terminalId);
}

/** Removal authority comes from current cwd, never sidebar membership or a declaration.
 * Re-read each terminal after every await: another tab may cd while a close is pending. */
export async function closeWorktreeTerminals(
	worktreePath: string,
	closeTerminal: (id: string, skipConfirm?: boolean) => Promise<void>,
): Promise<void> {
	if (!worktreePath) return;
	const failures: unknown[] = [];
	for (const id of terminalsStore.getIds()) {
		const cwd = terminalsStore.get(id)?.cwd;
		if (!cwd || !pathStartsWith(cwd, worktreePath)) continue;
		try {
			await closeTerminal(id, true);
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length > 0) {
		throw new AggregateError(failures, `${failures.length} terminal(s) could not be closed`);
	}
}

/** Drop a removed checkout's index without losing unrelated tabs filed under it. */
export function removeWorktreeWorkspace(repoPath: string, workspaceId: string): void {
	const survivors = [...(repositoriesStore.get(repoPath)?.workspaces[workspaceId]?.terminals ?? [])];
	batch(() => {
		repositoriesStore.removeWorkspace(repoPath, workspaceId);
		for (const id of survivors) {
			if (!terminalsStore.get(id)) continue;
			reconcileTerminalOwnership(id);
			if (!repositoriesStore.findOwnerForTerminal(id)) {
				terminalsStore.setRepoPath(id, null);
				globalWorkspaceStore.promote(id, MANUAL_SCOPE);
			}
		}
	});
}
