import { type Component, onMount } from "solid-js";
import { IdeasPanel } from "../components/IdeasPanel";
import { initPanelWindow } from "../hooks/initPanelWindow";
import { invoke } from "../invoke";
import type { PanelAdapter } from "../panelRouter";
import { repositoriesStore } from "../stores/repositories";
import { uiStore } from "../stores/ui";
import { createPanelSyncReceiver } from "../utils/panelSync";
import { queueTextToActiveTerminal, sendTextToActiveTerminal } from "../utils/sendToActiveTerminal";

const DetachedIdeasPanel: Component<{ params: URLSearchParams }> = (props) => {
	const repoPath = props.params.get("repoPath");
	const { emitAction } = createPanelSyncReceiver<null>("notes");

	onMount(() => {
		void initPanelWindow();
	});

	return (
		<IdeasPanel
			visible={true}
			repoPath={repoPath}
			mode="detached"
			onClose={() => window.close()}
			onSendToTerminal={(text) => {
				void emitAction("sendToTerminal", { text });
				void invoke("focus_main_window");
			}}
			// A detached window keeps its own empty terminals store, so it cannot
			// tell whether the active tab runs an agent. It always offers the queue
			// action; the main window reports a refusal through its own toast.
			onQueueToTerminal={(text) => void emitAction("queueToTerminal", { text })}
		/>
	);
};

export const ideasPanelAdapter: PanelAdapter = {
	id: "notes",
	title: "Notes",
	defaultSize: { width: 450, height: 600 },
	toggle: () => uiStore.toggleIdeasPanel(),
	onDetach: () => uiStore.setIdeasPanelVisible(false),
	detachParams: (): Record<string, string> => {
		const repoPath = repositoriesStore.state.activeRepoPath;
		return repoPath ? { repoPath } : {};
	},
	async handleAction(action: string, data: unknown) {
		if (action === "sendToTerminal" && data) {
			const d = data as Record<string, unknown>;
			await sendTextToActiveTerminal(d.text as string);
			void invoke("focus_main_window");
		}
		// Queueing deliberately does not steal focus: the point of leaving work
		// for the next idle window is that the user keeps doing something else.
		if (action === "queueToTerminal" && data) {
			const d = data as Record<string, unknown>;
			await queueTextToActiveTerminal(d.text as string);
		}
	},
	Component: DetachedIdeasPanel,
};
