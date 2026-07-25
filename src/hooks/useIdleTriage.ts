import { onCleanup } from "solid-js";
import { aiTriageStore } from "../stores/aiTriageStore";
import { repositoriesStore } from "../stores/repositories";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { uiStore } from "../stores/ui";

const TRIAGE_BUSY_THRESHOLD_MS = 5_000;

/** Runs AI diff triage after meaningful agent work while its panel is visible. */
export function useIdleTriage(): void {
	const unsubscribe = terminalsStore.onBusyToIdle((id, durationMs) => {
		if (!settingsStore.isAiTriageEnabled()) return;
		if (!uiStore.state.aiTriagePanelVisible) return;
		if (durationMs < TRIAGE_BUSY_THRESHOLD_MS) return;
		const terminal = terminalsStore.get(id);
		if (!terminal?.agentType) return;
		const repoPath = repositoriesStore.getRepoPathForTerminal(id);
		if (!repoPath) return;
		aiTriageStore.runTriage(repoPath);
	});

	onCleanup(unsubscribe);
}
