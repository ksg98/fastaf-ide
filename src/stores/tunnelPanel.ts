import { createStore } from "solid-js/store";

interface TunnelPanelState {
	isOpen: boolean;
}

function createTunnelPanelStore() {
	const [state, setState] = createStore<TunnelPanelState>({
		isOpen: false,
	});

	return {
		state,

		open(): void {
			setState("isOpen", true);
		},

		close(): void {
			setState("isOpen", false);
		},

		toggle(): void {
			setState("isOpen", (v) => !v);
		},
	};
}

export const tunnelPanelStore = createTunnelPanelStore();
