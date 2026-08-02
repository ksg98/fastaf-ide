import { For } from "solid-js";
import styles from "./MicMeter.module.css";

// Centered spectrum-style meter: an odd number of bars so one sits dead
// center. Heights taper toward the edges, and outer bars only rise once the
// level clears their distance — so the silhouette visibly widens outward from
// the center as the mic gets louder. It is cosmetic (driven by a single RMS
// level, not a real FFT), so all bars share one source; the shape carries it.
const CENTER_TAPER = 0.6;

/** Height fraction (0..1) for a bar `d` (normalized 0..1) from the center. */
export function barFraction(d: number, level: number): number {
	const denom = 1 - d * CENTER_TAPER;
	return Math.max(0, Math.min(1, (level - d * CENTER_TAPER) / denom));
}

/**
 * Live microphone level as a symmetric bar meter.
 *
 * Shared by the floating dictation toast and the AI chat composer so both read
 * the same silhouette from the same RMS level — the bar math lives here rather
 * than being copied per surface.
 */
export function MicMeter(props: { level: number; barCount?: number; minPx?: number; maxPx?: number; class?: string }) {
	const barCount = () => props.barCount ?? 15;
	const center = () => (barCount() - 1) / 2;
	const minPx = () => props.minPx ?? 2;
	const maxPx = () => props.maxPx ?? 16;
	const percent = () => Math.round(props.level * 100);

	return (
		<span
			class={`${styles.meter} ${props.class ?? ""}`}
			role="meter"
			aria-label={`Microphone level ${percent()}%`}
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={percent()}
		>
			<For each={Array.from({ length: barCount() }, (_, i) => i)}>
				{(index) => {
					const d = () => Math.abs(index - center()) / center();
					const fraction = () => barFraction(d(), props.level);
					return (
						<span
							class={styles.bar}
							classList={{ [styles.barActive]: fraction() > 0.05 }}
							style={{ height: `${minPx() + fraction() * (maxPx() - minPx())}px` }}
						/>
					);
				}}
			</For>
		</span>
	);
}
