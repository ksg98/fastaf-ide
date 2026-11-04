import { onCleanup } from "solid-js";
import { invoke, listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { conversationStore } from "../stores/conversationStore";
import { settingsStore } from "../stores/settings";
import { toastsStore } from "../stores/toasts";
import { uiStore } from "../stores/ui";
import { switchToTerminalBySession } from "../utils/switchToTerminalBySession";

/** Payload of the backend `ai-suggestion` event (ai_agent::triggers). */
export interface AiSuggestionPayload {
	session_id: string;
	trigger_reason: string;
	proposed_goal: string;
}

/**
 * Open AI Chat on the failing terminal and start the agent on the proposed goal.
 * Exported for tests; the hook wires it to the toast's "Investigate" button.
 */
export function investigateSuggestion(payload: AiSuggestionPayload): void {
	if (!settingsStore.isAiChatEnabled()) {
		toastsStore.add("Enable AI Chat in Settings to investigate", "", "warn", false);
		return;
	}
	uiStore.setAiChatPanelVisible(true);
	switchToTerminalBySession(payload.session_id);
	void conversationStore.startAgent(payload.session_id, payload.proposed_goal);
}

/** Payload of the backend `scheduled-job-completed` event (ai_agent::scheduler). */
export interface ScheduledJobCompletedPayload {
	job_id: string;
	goal: string;
	timed_out: boolean;
}

/** Payload of the backend `scheduled-job-needs-approval` event (ai_agent::scheduler). */
export interface ScheduledJobNeedsApprovalPayload {
	job_id: string;
	goal: string;
	session_id: string;
	command: string;
	reason: string;
	/** Only in the desktop window's copy. The `/events` copy omits it, because
	 * any local process can read that stream. */
	approval_id?: string;
}

/** Answer a scheduled job's pending approval. The run ends at its timeout if nobody does. */
export function answerScheduledApproval(sessionId: string, approved: boolean, approvalId: string): void {
	void invoke("approve_conversation_action", { sessionId, approved, approvalId }).catch((err) =>
		appLogger.warn("conversation", "Failed to answer a scheduled task's approval", err),
	);
}

/**
 * App-wide toasts for FastAF's AI engine events:
 * - `ai-suggestion`: a failed or timed-out command in a terminal whose "Toggle
 *   AI Suggestions" is on, with an "Investigate" action;
 * - `scheduled-job-completed`: an AI Chat scheduled task finished or timed out;
 * - `scheduled-job-needs-approval`: a scheduled task's agent wants to run a
 *   command that needs approval. Scheduled tasks run unattended and their
 *   conversation is not open in the AI Chat panel, so the toast itself carries
 *   Approve and Deny, which quote the request's one-time id. It stays until
 *   answered; unanswered, the run times out. A copy without the id (browser
 *   clients) is a notice with no buttons.
 */
export function useAiEngineEvents(): void {
	const unlisteners: Array<() => void> = [];
	let disposed = false;
	const keep = (promise: Promise<() => void>) =>
		void promise.then((dispose) => {
			if (disposed) dispose();
			else unlisteners.push(dispose);
		});
	keep(
		listen<AiSuggestionPayload>("ai-suggestion", (event) => {
			const payload = event.payload;
			toastsStore.add(payload.trigger_reason, "", "warn", false, {
				label: "Investigate",
				onClick: () => investigateSuggestion(payload),
			});
		}),
	);
	keep(
		listen<ScheduledJobCompletedPayload>("scheduled-job-completed", (event) => {
			const { goal, timed_out } = event.payload;
			if (timed_out) toastsStore.add("Scheduled task timed out", goal, "warn");
			else toastsStore.add("Scheduled task completed", goal, "info");
		}),
	);
	keep(
		listen<ScheduledJobNeedsApprovalPayload>("scheduled-job-needs-approval", (event) => {
			const { session_id, command, reason, goal, approval_id } = event.payload;
			// The body names the task as well as why the command needs approval:
			// with several tasks scheduled, the command alone does not say which
			// one is asking.
			const about = (...parts: string[]) => parts.filter(Boolean).join(" · ");
			// Without the id (a browser on `/events`) there is nothing to answer
			// with: say where the approval can be given instead.
			if (!approval_id) {
				toastsStore.add(
					`Scheduled task wants to run: ${command}`,
					about(goal, "Open FastAF on the computer running it to approve"),
					"warn",
					true,
					undefined,
					undefined,
					undefined,
					session_id,
				);
				return;
			}
			toastsStore.add(
				`Scheduled task wants to run: ${command}`,
				about(goal, reason),
				"warn",
				true,
				{ label: "Approve", onClick: () => answerScheduledApproval(session_id, true, approval_id) },
				0,
				undefined,
				session_id,
				true,
				{ secondaryAction: { label: "Deny", onClick: () => answerScheduledApproval(session_id, false, approval_id) } },
			);
		}),
	);
	onCleanup(() => {
		disposed = true;
		for (const dispose of unlisteners) dispose();
	});
}
