import { appLogger } from "../../stores/appLogger";
import { notificationsStore } from "../../stores/notifications";
import { terminalsStore } from "../../stores/terminals";
import { shouldNotifyAgentExit, shouldPlayCompletionSound } from "./completionDecision";

/** Claim and deliver the exit fallback for an agent completion cycle. */
export function handleAgentExitCompletion(terminalId: string, hadAgent = false): boolean {
	const terminal = terminalsStore.get(terminalId);
	const isBackground = terminalsStore.state.activeId !== terminalId;
	const shouldNotify = shouldNotifyAgentExit({
		hadAgent: hadAgent || terminal?.agentType != null,
		isBackground,
		completionNotified: terminal?.completionNotified ?? false,
	});
	if (!shouldNotify) return false;

	terminalsStore.update(terminalId, { completionNotified: true });
	appLogger.info("terminal", `[Notify] ${terminalId} completion — session exited (background tab)`);
	if (
		shouldPlayCompletionSound({
			isRemoteSession: terminal?.isRemote ?? false,
			silenceRemoteCompletions: notificationsStore.state.config.silence_remote_completions,
		})
	) {
		notificationsStore.playCompletion(terminalId);
	} else {
		appLogger.debug("terminal", `[Notify] ${terminalId} completion chime muted — orchestrated (remote) session`);
	}
	return true;
}
