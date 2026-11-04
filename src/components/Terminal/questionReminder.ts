import { createEffect, createRoot, onCleanup } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { notificationsStore } from "../../stores/notifications";
import { terminalsStore } from "../../stores/terminals";

export const QUESTION_REMINDER_MS = 120_000;

/** Terminals whose reminder is already tracked: one tracker per id however many components mount it. */
const trackers = new Set<string>();

/**
 * Re-notify once when a terminal has been awaiting input for QUESTION_REMINDER_MS.
 * The tracker is owned by the terminal's id, not by the calling component, so a remount
 * keeps the original start time and two components mounting one id cannot double-fire.
 * It ends when the terminal leaves the store. The timer starts on the awaiting false->true
 * edge and is cancelled by any clear: user input clears awaitingInput (Terminal.tsx user-input),
 * so answering one sub-question of a wizard and being asked the next restarts it. A question
 * whose text flips while awaiting stays one question. At most one reminder per question.
 * Idempotent: safe to call from every mount of the terminal.
 */
export function trackQuestionReminder(id: string): void {
	if (trackers.has(id)) return;
	trackers.add(id);
	createRoot((dispose) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let pending = false;
		let since = 0;
		const stop = () => {
			clearTimeout(timer);
			timer = undefined;
		};
		onCleanup(stop);
		createEffect(() => {
			const term = terminalsStore.get(id);
			stop();
			if (!term) {
				trackers.delete(id);
				dispose();
				return;
			}
			const awaiting = term.awaitingInput === "question";
			if (awaiting && !pending) since = Date.now();
			pending = awaiting;
			if (!awaiting) return;
			timer = setTimeout(
				() => {
					timer = undefined;
					appLogger.info("terminal", `[Notify] ${id} question — still unanswered, reminding`);
					void notificationsStore.playQuestionReminder(id);
				},
				Math.max(0, since + QUESTION_REMINDER_MS - Date.now()),
			);
		});
	});
}
