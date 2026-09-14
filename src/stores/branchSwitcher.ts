import { createStore } from "solid-js/store";

interface BranchSwitcherState {
	isOpen: boolean;
	query: string;
}

function createBranchSwitcherStore() {
	const [state, setState] = createStore<BranchSwitcherState>({
		isOpen: false,
		query: "",
	});

	function open(): void {
		setState("query", "");
		setState("isOpen", true);
	}

	function close(): void {
		setState("isOpen", false);
		setState("query", "");
	}

	function toggle(): void {
		if (state.isOpen) {
			close();
		} else {
			open();
		}
	}

	function setQuery(query: string): void {
		setState("query", query);
	}

	// Methods are plain closures, never `this`-bound: `toggle` is handed around as
	// a bare reference (keyboard handler map), which would strip a `this` binding.
	return { state, open, close, toggle, setQuery };
}

export const branchSwitcherStore = createBranchSwitcherStore();
