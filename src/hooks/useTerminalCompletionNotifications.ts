import { onCleanup } from "solid-js";
import { getCompletionSuppression } from "../components/Terminal/completionDecision";
import { getAgentIconSvg } from "../components/ui/AgentIcon";
import { listen } from "../invoke";
import { activityStore } from "../stores/activityStore";
import { appLogger } from "../stores/appLogger";
import { notificationsStore } from "../stores/notifications";
import { repositoriesStore } from "../stores/repositories";
import { terminalsStore } from "../stores/terminals";
import { pathBasename } from "../utils/pathUtils";

const BUSY_COMPLETION_THRESHOLD_MS = 5_000;
const DEFERRED_COMPLETION_MS = 10_000;
const SHELL_COMPLETION_SETTLE_MS = 800;
const WAKE_GRACE_MS = 15_000;

const DEFAULT_TERMINAL_ICON =
	'<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v10.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm1.75-.25a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25V2.75a.25.25 0 0 0-.25-.25ZM7.25 8a.749.749 0 0 1-.22.53l-2.25 2.25a.749.749 0 1 1-1.06-1.06L5.44 8 3.72 6.28a.749.749 0 1 1 1.06-1.06l2.25 2.25c.141.14.22.331.22.53Zm1.5 1.5h3a.75.75 0 0 1 0 1.5h-3a.75.75 0 0 1 0-1.5Z"/></svg>';

interface TerminalCompletionNotificationsOptions {
	navigateToTerminal: (id: string) => void;
}

/** Owns busy/idle completion sounds, activity items, wake suppression, and deferral timers. */
export function useTerminalCompletionNotifications(options: TerminalCompletionNotificationsOptions): void {
	let lastWakeAt = 0;
	const deferredCompletionTimers = new Map<string, ReturnType<typeof setTimeout>>();
	const busyStartExecAt = new Map<string, number | null | undefined>();

	let unlistenWake: (() => void) | undefined;
	listen<number>("system-wake", () => {
		lastWakeAt = Date.now();
		appLogger.debug("terminal", "[Notify] system-wake — suppressing completions for grace window");
	}).then((unlisten) => {
		unlistenWake = unlisten;
	});
	onCleanup(() => unlistenWake?.());

	const unsubscribeBusyToIdle = terminalsStore.onBusyToIdle((id, durationMs) => {
		if (durationMs < BUSY_COMPLETION_THRESHOLD_MS) return;
		if (terminalsStore.state.activeId === id) return;
		if (Date.now() - lastWakeAt < WAKE_GRACE_MS) {
			appLogger.debug("terminal", `[Notify] ${id} completion SUPPRESSED — within wake grace window`);
			return;
		}

		const fireCompletion = () => {
			deferredCompletionTimers.delete(id);
			const terminal = terminalsStore.get(id);
			if (!terminal) return;

			const startExec = busyStartExecAt.get(id);
			const reason = getCompletionSuppression({
				isActiveTerminal: terminalsStore.state.activeId === id,
				isDebouncedBusy: !!terminalsStore.state.debouncedBusy[id],
				activeSubTasks: terminal.activeSubTasks,
				awaitingInput: terminal.awaitingInput,
				durationMs,
				thresholdMs: BUSY_COMPLETION_THRESHOLD_MS,
				usesShellIntegration: !terminal.agentType && terminal.lastCommandExecAt != null,
				ranCommandDuringBusy: startExec === undefined || terminal.lastCommandExecAt !== startExec,
			});
			if (reason) {
				appLogger.debug("terminal", `[Notify] ${id} completion SUPPRESSED — ${reason}`);
				return;
			}

			appLogger.info("terminal", `[Notify] ${id} completion — busy for ${Math.round(durationMs / 1000)}s then idle`);
			terminalsStore.update(id, { activity: true, unseen: true });
			notificationsStore.playCompletion(id);
			const agentLabel = terminal.agentType ? terminal.agentType[0].toUpperCase() + terminal.agentType.slice(1) : null;
			const repoPath = repositoriesStore.getRepoPathForTerminal(id);
			const repoName = repoPath ? pathBasename(repoPath) : null;
			const subtitleParts: string[] = [];
			if (repoName) subtitleParts.push(repoName);
			subtitleParts.push(`ran for ${Math.round(durationMs / 1000)}s`);
			if (terminal.agentIntent) subtitleParts.push(terminal.agentIntent);

			activityStore.addItem({
				id: `terminal-done-${id}`,
				pluginId: "core",
				sectionId: "terminals",
				title: `${agentLabel ?? terminal.name} finished`,
				subtitle: subtitleParts.join(" · "),
				icon: (terminal.agentType && getAgentIconSvg(terminal.agentType, 14)) || DEFAULT_TERMINAL_ICON,
				repoPath: repoPath ?? undefined,
				dismissible: true,
				onClick: () => options.navigateToTerminal(id),
			});
		};

		const terminal = terminalsStore.get(id);
		if (terminal && terminal.activeSubTasks > 0) {
			appLogger.debug("terminal", `[Notify] ${id} completion SUPPRESSED — ${terminal.activeSubTasks} active sub-tasks`);
			return;
		}

		clearTimeout(deferredCompletionTimers.get(id));
		const delay = terminal?.agentType ? DEFERRED_COMPLETION_MS : SHELL_COMPLETION_SETTLE_MS;
		deferredCompletionTimers.set(id, setTimeout(fireCompletion, delay));
	});

	const unsubscribeIdleToBusy = terminalsStore.onIdleToBusy((id) => {
		busyStartExecAt.set(id, terminalsStore.get(id)?.lastCommandExecAt ?? null);
		const timer = deferredCompletionTimers.get(id);
		if (!timer) return;
		clearTimeout(timer);
		deferredCompletionTimers.delete(id);
		appLogger.debug("terminal", `[Notify] ${id} deferred completion CANCELLED — terminal went busy`);
	});

	onCleanup(() => {
		unsubscribeBusyToIdle();
		unsubscribeIdleToBusy();
		for (const timer of deferredCompletionTimers.values()) clearTimeout(timer);
		deferredCompletionTimers.clear();
	});
}
