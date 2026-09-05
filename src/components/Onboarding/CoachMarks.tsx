import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { dictationStore } from "../../stores/dictation";
import { multiviewStore } from "../../stores/multiview";
import { type HintId, onboardingStore } from "../../stores/onboarding";
import { paneLayoutStore } from "../../stores/paneLayout";
import { terminalsStore } from "../../stores/terminals";
import { uiStore } from "../../stores/ui";
import { keyFor } from "../../utils/hotkey";
import { CoachMark } from "./CoachMark";

/**
 * Decides which one-time hint (if any) is on screen, and ticks milestones off
 * as the user reaches them. Never more than one callout at a time, never
 * before the user has a terminal in front of them, and each one steps aside
 * the moment the user does the thing it describes.
 *
 * Order: the chat first (it is the most powerful thing here and the least
 * obvious), then dictation once that is out of the way. The third idea —
 * many terminals — is taught by the empty well itself (WelcomeWell).
 */
export interface CoachMarksProps {
	onOpenChat?: () => void;
	onOpenSettings?: (tab?: string) => void;
}

const SETTLE_MS = 1500;

export function CoachMarks(props: CoachMarksProps) {
	// A hint that appears the instant a terminal opens competes with the
	// terminal; give the user a moment to look at what they opened.
	const [settled, setSettled] = createSignal(false);
	createEffect(() => {
		if (!terminalsStore.state.activeId) {
			setSettled(false);
			return;
		}
		const timer = setTimeout(() => setSettled(true), SETTLE_MS);
		onCleanup(() => clearTimeout(timer));
	});

	// ── Milestones ───────────────────────────────────────────────────────
	createEffect(() => {
		if (paneLayoutStore.isSplit() || multiviewStore.state.isOpen || terminalsStore.getIds().length >= 2) {
			onboardingStore.markDone("multi");
		}
	});
	createEffect(() => {
		if (uiStore.state.aiChatPanelVisible) {
			onboardingStore.markDone("chat");
			onboardingStore.dismiss("chat");
		}
	});
	createEffect(() => {
		if (dictationStore.state.recording) {
			onboardingStore.markDone("dictation");
			onboardingStore.dismiss("dictation");
		}
	});

	const current = createMemo<HintId | null>(() => {
		if (!settled()) return null;
		if (!onboardingStore.isDismissed("chat")) return "chat";
		if (!onboardingStore.isDismissed("dictation")) return "dictation";
		return null;
	});

	return (
		<>
			<Show when={current() === "chat"}>
				<CoachMark
					anchor="ai-chat"
					title="Ask about any terminal"
					body="The chat reads whichever terminal you focus and can run commands in it. Switch it to Agent and it works through a task on its own."
					kbd={keyFor("toggle-ai-chat")}
					actionLabel="Open chat"
					onAction={() => props.onOpenChat?.()}
					onDismiss={() => onboardingStore.dismiss("chat")}
				/>
			</Show>
			<Show when={current() === "dictation"}>
				<Show
					when={dictationStore.state.enabled}
					fallback={
						<CoachMark
							anchor="settings"
							title="Talk instead of typing"
							body="Turn on dictation and you can speak into any terminal — it runs locally, no network needed."
							actionLabel="Set up"
							onAction={() => props.onOpenSettings?.("voice")}
							onDismiss={() => onboardingStore.dismiss("dictation")}
						/>
					}
				>
					<CoachMark
						anchor="dictation"
						title="Talk instead of typing"
						body="Hold the key (or this button) and speak. The words land in the focused terminal when you let go."
						kbd={dictationStore.state.hotkey}
						onDismiss={() => onboardingStore.dismiss("dictation")}
					/>
				</Show>
			</Show>
		</>
	);
}

export default CoachMarks;
