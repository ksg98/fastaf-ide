import { createStore } from "solid-js/store";

interface WorktreeManagerState {
	isOpen: boolean;
	selectedIds: Set<string>;
	repoFilter: string | null;
	textFilter: string;
}

function createWorktreeManagerStore() {
	const [state, setState] = createStore<WorktreeManagerState>({
		isOpen: false,
		selectedIds: new Set<string>(),
		repoFilter: null,
		textFilter: "",
	});

	function open(): void {
		setState("isOpen", true);
	}

	function close(): void {
		setState({
			isOpen: false,
			selectedIds: new Set<string>(),
			repoFilter: null,
			textFilter: "",
		});
	}

	function toggle(): void {
		if (state.isOpen) {
			close();
		} else {
			open();
		}
	}

	// `toggle` is handed around as a bare reference (keyboard handler map), which
	// would strip a `this` binding — so it calls the closures directly.
	return {
		state,
		open,
		close,
		toggle,

		toggleSelect(id: string): void {
			const next = new Set(state.selectedIds);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			setState("selectedIds", next);
		},

		selectAll(ids: string[]): void {
			setState("selectedIds", new Set(ids));
		},

		clearSelection(): void {
			setState("selectedIds", new Set<string>());
		},

		setRepoFilter(repoPath: string | null): void {
			setState("repoFilter", repoPath);
		},

		setTextFilter(text: string): void {
			setState("textFilter", text);
		},
	};
}

export const worktreeManagerStore = createWorktreeManagerStore();
