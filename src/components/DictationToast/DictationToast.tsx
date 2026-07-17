import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { dictationStore } from "../../stores/dictation";
import styles from "./DictationToast.module.css";

/**
 * Floating toast that shows partial transcription results during streaming
 * dictation. Positioned above the status bar, auto-shows when partials arrive
 * and hides when recording stops.
 */
export function DictationToast() {
	const [visible, setVisible] = createSignal(false);
	const [exiting, setExiting] = createSignal(false);

	// Show toast when partialText becomes non-empty or an AI rewrite starts
	createEffect(() => {
		if (dictationStore.state.partialText || dictationStore.state.rewriting) {
			setExiting(false);
			setVisible(true);
		}
	});

	// Auto-hide when recording stops (but stay visible while rewriting)
	createEffect(() => {
		if (!dictationStore.state.recording && !dictationStore.state.rewriting && visible()) {
			setExiting(true);
			const timer = setTimeout(() => {
				setVisible(false);
				setExiting(false);
			}, 150); // match fadeOut duration
			onCleanup(() => clearTimeout(timer));
		}
	});

	return (
		<Show when={visible()}>
			<div class={styles.toast} data-exiting={exiting()}>
				<span class={styles.indicator} />
				<span class={styles.text}>
					{dictationStore.state.rewriting ? "Rewriting with AI" : dictationStore.state.partialText || "Listening"}
					<span class={styles.dots} />
				</span>
			</div>
		</Show>
	);
}
