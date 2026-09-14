import { createStore, produce, type SetStoreFunction } from "solid-js/store";

/**
 * Base constraint for tab data — every tab must have an id.
 */
export interface BaseTab {
	id: string;
	/** When true, tab is visible across all branches (within the same repo if repoPath is set) */
	pinned?: boolean;
	/** Scope key: "repoPath|branchName" — tab only visible in this branch unless pinned */
	branchKey?: string;
	/** Repo scope — when set, tab is only visible when the active branchKey belongs to this repo */
	repoPath?: string;
	/** Per-tab font size override in pixels (used by zoom actions) */
	fontSize?: number;
}

/** Build a branch scope key for tab filtering */
export function makeBranchKey(repoPath: string, branchName: string): string {
	return `${repoPath}|${branchName}`;
}

/**
 * Internal store state shape for all tab managers.
 */
export interface TabStoreState<T extends BaseTab> {
	tabs: Record<string, T>;
	activeId: string | null;
	counter: number;
	/** Explicit display order for drag-reorder. Populated by _addTab; reorderByIds splices it. */
	_order: string[];
}

/**
 * Factory that creates a tab manager with shared CRUD logic.
 *
 * Domain stores call this, then layer on their own add() / custom methods.
 */
/** Global hook called after any tab is added. Set by paneTabAssign to avoid circular deps. */
export let onTabAdded: ((tabId: string, storeName: string) => void) | null = null;

/** Register the global onTabAdded hook (called once during app init) */
export function setOnTabAdded(hook: typeof onTabAdded): void {
	onTabAdded = hook;
}

/**
 * Deactivators for every pane-owning store, keyed by store name.
 *
 * TerminalArea renders terminals, diffs, markdown and editors as four independent
 * `For` lists, each marking its pane `active` from its OWN store's `activeId`. So
 * "only one pane is showing" is a cross-store invariant that no single store owned:
 * each call site had to remember to null the other three, and the ones that forgot
 * (MarkdownTab's Edit button) rendered the viewer and the editor on top of each
 * other. Registering here lets the *activating* store enforce it once.
 *
 * Lives in tabManager because all four stores already import it and it imports
 * none of them — putting the registry in any one store would make them cyclic.
 */
const paneDeactivators = new Map<string, () => void>();

/** Register a store that owns a pane, so activating another pane can deactivate it. */
export function registerPaneDeactivator(storeName: string, deactivate: () => void): void {
	paneDeactivators.set(storeName, deactivate);
}

/**
 * Make `storeName` the only store with an active tab.
 *
 * Call this from the paths that ACTIVATE a tab. Background/silent opens must not
 * call it — they deliberately leave the current pane showing.
 */
export function activatePaneExclusively(storeName: string): void {
	for (const [name, deactivate] of paneDeactivators) {
		if (name !== storeName) deactivate();
	}
}

export function createTabManager<T extends BaseTab>(storeName: string = "unknown") {
	const [state, setState] = createStore<TabStoreState<T>>({
		tabs: {} as Record<string, T>,
		activeId: null,
		counter: 0,
		_order: [],
	});

	registerPaneDeactivator(storeName, () => setState("activeId", null));

	return {
		state,

		/** Internal: expose setState for domain-specific mutations. */
		_setState: setState as SetStoreFunction<TabStoreState<T>>,

		/** Internal: add a tab to the store and set it active. Returns the tab id.
		 *  Activating makes this the ONLY pane showing — see activatePaneExclusively. */
		_addTab(tab: T): string {
			setState("tabs", tab.id, tab);
			setState("activeId", tab.id);
			setState("_order", (o) => [...o, tab.id]);
			activatePaneExclusively(storeName);
			onTabAdded?.(tab.id, storeName);
			return tab.id;
		},

		/** Internal: add a tab without changing activeId (background/silent open). */
		_addTabBackground(tab: T): string {
			setState("tabs", tab.id, tab);
			setState("_order", (o) => [...o, tab.id]);
			return tab.id;
		},

		/** Internal: get next auto-increment id with the given prefix (e.g. "diff-1"). */
		_nextId(prefix: string): string {
			setState("counter", (c) => c + 1);
			return `${prefix}-${state.counter}`;
		},

		/** Remove a tab. Sets activeId to null when removing the active tab — the caller
		 *  is responsible for selecting a visibility-aware replacement (same contract as
		 *  terminalsStore.remove). The store can't filter by branch/repo scope here, so
		 *  auto-promoting an arbitrary remaining tab could activate one hidden from the
		 *  tab bar — a ghost full-screen panel with no visible tab. */
		remove(id: string): void {
			setState(
				produce((s) => {
					delete s.tabs[id];
					s._order = s._order.filter((oid) => oid !== id);
					if (s.activeId === id) {
						s.activeId = null;
					}
				}),
			);
		},

		/** Activate a tab, or clear the active one with `null`.
		 *  Activating deactivates every other pane store: TerminalArea marks each pane
		 *  from its own store's activeId, so two stores holding an activeId render two
		 *  panes on top of each other. `null` only clears this store. */
		setActive(id: string | null): void {
			setState("activeId", id);
			if (id !== null) activatePaneExclusively(storeName);
		},

		clearAll(): void {
			setState({ tabs: {} as Record<string, T>, activeId: null, counter: state.counter, _order: [] });
		},

		get(id: string): T | undefined {
			return state.tabs[id];
		},

		getIds(): string[] {
			return Object.keys(state.tabs);
		},

		getActive(): T | undefined {
			return state.activeId ? state.tabs[state.activeId] : undefined;
		},

		getCount(): number {
			return Object.keys(state.tabs).length;
		},

		/** Toggle pinned state for a tab */
		setPinned(id: string, pinned: boolean): void {
			if (state.tabs[id]) {
				setState(
					"tabs",
					produce((tabs: Record<string, T>) => {
						if (tabs[id]) tabs[id].pinned = pinned;
					}),
				);
			}
		},

		/** Get tab IDs visible for the given branch key (pinned + matching branch + unscoped).
		 *  Respects user-defined drag order (_order array) when present. */
		getVisibleIds(currentBranchKey: string | null): string[] {
			const isVisible = (id: string): boolean => {
				const tab = state.tabs[id];
				if (!tab) return false;
				if (tab.repoPath) {
					if (!currentBranchKey?.startsWith(tab.repoPath + "|")) return false;
				}
				if (tab.pinned) return true;
				if (!tab.branchKey) return true;
				return tab.branchKey === currentBranchKey;
			};
			// Ordered tabs first (those tracked in _order), then any remainder
			const inOrder = state._order.filter(isVisible);
			const inOrderSet = new Set(inOrder);
			const remainder = Object.keys(state.tabs).filter((id) => !inOrderSet.has(id) && isVisible(id));
			return [...inOrder, ...remainder];
		},

		/** Move sourceId immediately before or after targetId in the display order. No-op on bad IDs. */
		reorderByIds(sourceId: string, targetId: string, side: "before" | "after"): void {
			if (sourceId === targetId) return;
			setState(
				produce((s) => {
					const src = s._order.indexOf(sourceId);
					const tgt = s._order.indexOf(targetId);
					if (src === -1 || tgt === -1) return;
					s._order.splice(src, 1);
					const newTgt = s._order.indexOf(targetId);
					s._order.splice(side === "before" ? newTgt : newTgt + 1, 0, sourceId);
				}),
			);
		},

		/** Clear tabs matching a predicate */
		_clearWhere(predicate: (tab: T) => boolean): void {
			setState(
				produce((s) => {
					const idsToRemove = Object.values(s.tabs)
						.filter((tab) => predicate(tab as T))
						.map((tab) => (tab as T).id);

					for (const id of idsToRemove) {
						delete s.tabs[id];
					}

					if (s.activeId && idsToRemove.includes(s.activeId)) {
						s.activeId = null;
					}
				}),
			);
		},
	};
}
