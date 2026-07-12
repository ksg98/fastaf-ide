import { type Component, onMount } from "solid-js";
import { OutlinePanel } from "../components/OutlinePanel";
import { initPanelWindow } from "../hooks/initPanelWindow";
import type { PanelAdapter } from "../panelRouter";
import { uiStore } from "../stores/ui";

const DetachedOutlinePanel: Component<{ params: URLSearchParams }> = () => {
	onMount(() => {
		void initPanelWindow();
	});

	return <OutlinePanel visible={true} onClose={() => window.close()} />;
};

export const outlinePanelAdapter: PanelAdapter = {
	id: "outline",
	title: "Outline",
	defaultSize: { width: 300, height: 600 },
	toggle: () => uiStore.toggleOutlinePanel(),
	onDetach: () => uiStore.setOutlinePanelVisible(false),
	Component: DetachedOutlinePanel,
};
