import { getVisibleRepoSequence } from "../stores/sidebarLayout";

/** Dependencies injected into useQuickSwitcher */
export interface QuickSwitcherDeps {
	handleBranchSelect: (repoPath: string, branchName: string) => void;
}

/** Quick switcher: resolve shortcut index to repo+branch.
 * Uses the shared visible-repo sequence (workspace/filter/search/sort aware)
 * so the numbering always matches Sidebar.repoShortcutStarts. */
export function useQuickSwitcher(deps: QuickSwitcherDeps) {
	const switchToBranchByIndex = (index: number) => {
		let counter = 1;
		for (const repo of getVisibleRepoSequence()) {
			const branches = Object.values(repo.branches).sort((a, b) => {
				if (a.isMain && !b.isMain) return -1;
				if (!a.isMain && b.isMain) return 1;
				return a.name.localeCompare(b.name);
			});
			for (const branch of branches) {
				if (counter === index) {
					deps.handleBranchSelect(repo.path, branch.name);
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
