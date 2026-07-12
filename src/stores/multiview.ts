import { createStore } from "solid-js/store";
import { MAX_MULTIVIEW_TILES } from "../utils/multiviewGrid";
import { settingsStore } from "./settings";
import { terminalsStore } from "./terminals";

interface MultiviewState {
	isOpen: boolean;
	/** Terminals removed from the grid via the tile's "remove from view"
	 *  button. Cleared when multiview closes, so reopening shows everything. */
	hidden: Record<string, boolean>;
}

/** Multiview: a toggleable mode that tiles every live terminal across all
 *  repos and branches in one grid. Tiles are the ALREADY-MOUNTED flat
 *  terminal instances in TerminalArea — never new Terminal mounts, because
 *  each PTY session supports exactly one live grid-channel subscriber. */
function createMultiviewStore() {
	const [state, setState] = createStore<MultiviewState>({
		isOpen: false,
		hidden: {},
	});

	const open = (): void => {
		if (!settingsStore.state.multiviewEnabled) return;
		setState("isOpen", true);
	};

	const close = (): void => {
		setState({ isOpen: false, hidden: {} });
	};

	/** A terminal is eligible for the grid when attached, not hidden by the
	 *  user, AND it either has a live PTY session or is the active tab — the
	 *  active-tab clause lets a terminal created while multiview is open
	 *  spawn exactly one PTY, the same deferred-spawn discipline as normal
	 *  mode. */
	const isEligible = (id: string): boolean => {
		if (state.hidden[id]) return false;
		if (terminalsStore.isDetached(id)) return false;
		return terminalsStore.get(id)?.sessionId != null || terminalsStore.state.activeId === id;
	};

	/** Grid tiles, capped at MAX_MULTIVIEW_TILES. Over the cap, the most
	 *  recently active terminals win (the active tab is always included);
	 *  stable store order is preserved so tiles don't shuffle. Hiding a
	 *  shown tile rotates the next candidate in. */
	const shownTileIds = (): string[] => {
		const ids = terminalsStore.getAttachedIds().filter(isEligible);
		if (ids.length <= MAX_MULTIVIEW_TILES) return ids;
		const byRecency = [...ids].sort(
			(a, b) => (terminalsStore.get(b)?.lastDataAt ?? 0) - (terminalsStore.get(a)?.lastDataAt ?? 0),
		);
		const shown = new Set(byRecency.slice(0, MAX_MULTIVIEW_TILES));
		const activeId = terminalsStore.state.activeId;
		if (activeId && !shown.has(activeId) && ids.includes(activeId)) {
			shown.delete(byRecency[MAX_MULTIVIEW_TILES - 1]);
			shown.add(activeId);
		}
		return ids.filter((id) => shown.has(id));
	};

	return {
		state,
		open,
		close,
		shownTileIds,

		toggle(): void {
			if (state.isOpen) {
				close();
			} else {
				open();
			}
		},

		/** Remove a terminal from the grid without closing it — it keeps
		 *  running in the background and returns next time multiview opens. */
		hideTile(id: string): void {
			setState("hidden", id, true);
		},

		/** Terminals eligible for the grid but not shown due to the tile cap. */
		overflowCount(): number {
			return terminalsStore.getAttachedIds().filter(isEligible).length - shownTileIds().length;
		},

		/** Whether this terminal renders as a grid tile right now (eligible
		 *  AND within the tile cap). Drives both the CSS tile class and the
		 *  Terminal isVisible() signal — the two must always agree. */
		isTileVisible(id: string): boolean {
			return shownTileIds().includes(id);
		},
	};
}

export const multiviewStore = createMultiviewStore();
