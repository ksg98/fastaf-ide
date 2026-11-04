import { globalWorkspaceStore } from "../stores/globalWorkspace";
import { paneLayoutStore } from "../stores/paneLayout";

/** Terminal ids in displayed tab order: in split mode the spatial pane layout
 *  (DFS) order, otherwise the order given. Terminals not docked in any pane
 *  group keep their relative order at the end. */
export function orderTerminalsByPaneLayout(ids: string[]): string[] {
	if (!paneLayoutStore.isSplit()) return ids;
	const idSet = new Set(ids);
	const ordered: string[] = [];
	for (const groupId of paneLayoutStore.getAllGroupIds()) {
		const group = paneLayoutStore.state.groups[groupId];
		if (!group) continue;
		for (const tab of group.tabs) {
			if (tab.type === "terminal" && idSet.has(tab.id)) {
				ordered.push(tab.id);
				idSet.delete(tab.id);
			}
		}
	}
	// Append any orphan terminals not assigned to a pane group
	for (const id of ids) {
		if (idSet.has(id)) ordered.push(id);
	}
	return ordered;
}

/** Tab ids shown in the global workspace, in displayed order; null when the
 *  workspace is not active (the tab list is then the active branch's). */
export function globalWorkspaceTabIds(): string[] | null {
	if (!globalWorkspaceStore.isActive()) return null;
	return orderTerminalsByPaneLayout(globalWorkspaceStore.getPromotedIds());
}
