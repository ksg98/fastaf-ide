/** Pure visibility predicate for a Terminal instance. The same terminal id is
 *  mounted in up to three places (flat list in TerminalArea, pane-tree copy in
 *  PaneTree, floating-window copy) but each PTY session supports exactly ONE
 *  live grid-channel subscriber — subscribing replaces the previous channel.
 *  The hidden→visible transition of this predicate is the only sanctioned
 *  resubscribe trigger (Terminal.tsx recovery effect), so it must truthfully
 *  match which instance is actually displayed. */
export interface TerminalVisibilityInputs {
	/** Floating-window copy — always the displayed instance in its window. */
	alwaysVisible: boolean;
	/** True for the pane-tree copy rendered by PaneTree, false for the flat copy. */
	inPaneTree: boolean;
	multiviewOpen: boolean;
	/** multiviewStore.isTileVisible(id) — renders as a grid tile. */
	multiviewTile: boolean;
	isActiveTab: boolean;
	detached: boolean;
	split: boolean;
	inPaneGroup: boolean;
	isGroupActiveTab: boolean;
}

export function isTerminalVisible(v: TerminalVisibilityInputs): boolean {
	if (v.alwaysVisible) return true;
	// Multiview: only FLAT copies show as tiles; pane-tree copies hide. Both
	// directions of the toggle then produce hidden→visible transitions, which
	// hand the grid channel to the displayed instance.
	if (v.multiviewOpen) return !v.inPaneTree && v.multiviewTile;
	if (v.inPaneTree) return v.split && v.inPaneGroup && v.isGroupActiveTab;
	// Flat copy: mirrors TerminalArea's CSS — a terminal docked in an active
	// split is displayed by its pane-tree copy, not the flat copy.
	if (v.detached || !v.isActiveTab) return false;
	return !v.split || !v.inPaneGroup;
}
