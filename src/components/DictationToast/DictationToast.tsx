import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { dictationStore } from "../../stores/dictation";
import styles from "./DictationToast.module.css";

// Centered spectrum-style meter: an odd number of bars so one sits dead
// center. Heights taper toward the edges, and outer bars only rise once the
// level clears their distance — so the silhouette visibly widens outward from
// the center as the mic gets louder. It is cosmetic (driven by a single RMS
// level, not a real FFT), so all bars share one source; the shape carries it.
const BAR_COUNT = 15;
const CENTER = (BAR_COUNT - 1) / 2;
const MIN_BAR_PX = 2;
const MAX_BAR_PX = 16;

/** Height fraction (0..1) for a bar `d` (normalized 0..1) from the center. */
function barFraction(d: number, level: number): number {
	const denom = 1 - d * 0.6;
	return Math.max(0, Math.min(1, (level - d * 0.6) / denom));
}

/**
 * Floating toast that shows partial transcription results during streaming
 * dictation. Positioned above the status bar, auto-shows when partials arrive
 * and hides when recording stops.
 */
export function DictationToast() {
	const [visible, setVisible] = createSignal(false);
	const [exiting, setExiting] = createSignal(false);

	// Show the preview as soon as capture starts, so the meter confirms input
	// before Whisper has produced its first partial transcription — and keep it
	// up while an AI rewrite is running.
	createEffect(() => {
		if (dictationStore.state.recording || dictationStore.state.partialText || dictationStore.state.rewriting) {
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
				<span
					class={styles.meter}
					role="meter"
					aria-label={`Microphone level ${Math.round(dictationStore.state.audioLevel * 100)}%`}
					aria-valuemin="0"
					aria-valuemax="100"
					aria-valuenow={Math.round(dictationStore.state.audioLevel * 100)}
				>
					{Array.from({ length: BAR_COUNT }, (_, index) => {
						const d = Math.abs(index - CENTER) / CENTER;
						return (
							<span
								class={styles.bar}
								classList={{ [styles.barActive]: barFraction(d, dictationStore.state.audioLevel) > 0.05 }}
								style={{
									height: `${MIN_BAR_PX + barFraction(d, dictationStore.state.audioLevel) * (MAX_BAR_PX - MIN_BAR_PX)}px`,
								}}
							/>
						);
					})}
				</span>
				<span class={styles.text}>
					{dictationStore.state.rewriting ? "Rewriting with AI" : dictationStore.state.partialText || "Listening"}
					<span class={styles.dots} />
				</span>
			</div>
		</Show>
	);
}
