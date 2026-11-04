/** Which badge set the Cmd+Ctrl hold reveals: tabs in the global workspace, sidebar branches otherwise. */
export function quickSwitcherHints(visible: boolean, globalWorkspaceActive: boolean) {
	return {
		sidebar: visible && !globalWorkspaceActive,
		tabBar: visible && globalWorkspaceActive,
	};
}
