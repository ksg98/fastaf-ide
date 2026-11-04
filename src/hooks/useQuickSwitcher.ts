import { getVisibleRepoSequence } from "../stores/sidebarLayout";

/** Dependencies injected into useQuickSwitcher */
export interface QuickSwitcherDeps {
	handleBranchSelect: (repoPath: string, branchName: string) => void;
}

/** Quick switcher: resolve shortcut index to repo+branch.
 * Uses the shared visible-repo sequence (named-workspace/filter/search/sort aware)
 * so the numbering always matches Sidebar.repoShortcutStarts. */
export function useQuickSwitcher(deps: QuickSwitcherDeps) {
	const switchToBranchByIndex = (index: number) => {
		let counter = 1;
		for (const repo of getVisibleRepoSequence()) {
			// Sorted for display by branch, selected by KEY: `handleBranchSelect`
			// indexes the workspace map, and passing `branchName` there picked
			// whichever row happened to be keyed by the bare branch.
			const workspaces = Object.entries(repo.workspaces).sort(([, a], [, b]) => {
				if (a.isMain && !b.isMain) return -1;
				if (!a.isMain && b.isMain) return 1;
				return a.branchName.localeCompare(b.branchName);
			});
			for (const [workspaceId] of workspaces) {
				if (counter === index) {
					deps.handleBranchSelect(repo.path, workspaceId);
					return;
				}
				counter++;
			}
		}
	};

	return {
		switchToBranchByIndex,
	};
}
