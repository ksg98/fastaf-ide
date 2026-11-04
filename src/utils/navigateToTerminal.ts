import { globalWorkspaceStore, MANUAL_SCOPE } from "../stores/globalWorkspace";
import { paneLayoutStore } from "../stores/paneLayout";
import { repositoriesStore } from "../stores/repositories";
import { paneLayoutKey } from "../stores/savedPaneLayouts";
import { terminalsStore } from "../stores/terminals";

/**
 * Navigate to a terminal: switch repo/branch context, activate the terminal,
 * deactivate other tab stores, activate the correct pane group, and focus.
 */
export function navigateToTerminal(id: string): void {
	if (!terminalsStore.get(id)) return;

	// Unowned sessions are parked in the manual workspace, not in the selected
	// repo. Open that tab strip before selecting the terminal's content.
	const repoPath = repositoriesStore.getRepoPathForTerminal(id);
	if (!repoPath && globalWorkspaceStore.getScopeMembers(MANUAL_SCOPE).includes(id)) {
		const activeRepo = repositoriesStore.getActive();
		const layoutKey = activeRepo?.activeWorkspaceId
			? paneLayoutKey(activeRepo.path, activeRepo.activeWorkspaceId)
			: undefined;
		if (globalWorkspaceStore.getScope() !== MANUAL_SCOPE) {
			globalWorkspaceStore.deactivate();
			// Leave repo consolidation before opening the repo-independent workspace.
			repositoriesStore.setActive(null);
			globalWorkspaceStore.setScope(MANUAL_SCOPE);
		}
		globalWorkspaceStore.activate(layoutKey);
	} else if (globalWorkspaceStore.isActive() && !globalWorkspaceStore.isPromoted(id)) {
		globalWorkspaceStore.deactivate();
	}
	if (repoPath) {
		const repo = repositoriesStore.state.repositories[repoPath];
		if (repo) {
			for (const [workspaceId, workspace] of Object.entries(repo.workspaces)) {
				if (workspace.terminals.includes(id)) {
					if (repositoriesStore.state.activeRepoPath !== repoPath) {
						repositoriesStore.setActive(repoPath);
					}
					if (repo.activeWorkspaceId !== workspaceId) {
						repositoriesStore.setActiveWorkspace(repoPath, workspaceId);
					}
					break;
				}
			}
		}
	}
	// setActive deactivates the diff/markdown/editor panes itself.
	terminalsStore.setActive(id);

	if (paneLayoutStore.isSplit()) {
		const groupId = paneLayoutStore.getGroupForTab(id);
		if (groupId) {
			paneLayoutStore.setActiveGroup(groupId);
			paneLayoutStore.setActiveTab(groupId, id);
		}
	}

	requestAnimationFrame(() => terminalsStore.get(id)?.ref?.focus());
}
