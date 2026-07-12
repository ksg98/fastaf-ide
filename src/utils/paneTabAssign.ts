import { type PaneTabType, paneLayoutStore } from "../stores/paneLayout";
import { setOnTabAdded } from "../stores/tabManager";

/** Assign a tab to the active pane group when split mode is on.
 *  No-op when not in split mode. Safe to call unconditionally after tab creation.
 *  New terminals stack with the other terminals when the active group holds
 *  none (e.g. focus sits in a file pane) — a fresh terminal must not bury the
 *  file pane's content. */
export function assignTabToActiveGroup(tabId: string, type: PaneTabType): void {
	if (!paneLayoutStore.isSplit()) return;
	let targetGroupId = paneLayoutStore.state.activeGroupId;
	const tabsOf = (g: string) => paneLayoutStore.state.groups[g]?.tabs ?? [];
	if (type === "terminal" && targetGroupId && !tabsOf(targetGroupId).some((t) => t.type === "terminal")) {
		targetGroupId =
			paneLayoutStore.getAllGroupIds().find((g) => tabsOf(g).some((t) => t.type === "terminal")) ?? targetGroupId;
	}
	if (!targetGroupId) return;
	paneLayoutStore.addTab(targetGroupId, { id: tabId, type });
	if (targetGroupId !== paneLayoutStore.state.activeGroupId) {
		paneLayoutStore.setActiveGroup(targetGroupId);
	}
}

/** Register the global hook so terminal tabs auto-assign to active pane group.
 *  Non-terminal tabs (panels, diff, editor) start unassigned — drag into a
 *  split pane to dock them. Call once during app initialization. */
export function initPaneTabAssignment(): void {
	setOnTabAdded(() => {
		// Only terminals are auto-assigned (handled by pty spawn logic).
		// Non-terminal tabs start as orphans so they render full-page.
	});
}
