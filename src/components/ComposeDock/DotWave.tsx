import { createSignal, Index, onCleanup, onMount } from "solid-js";
import s from "./DotWave.module.css";

/** How often a level sample scrolls in (ms); dots × this = the history the row shows. */
const SAMPLE_MS = 60;
/** Pitch of the dots (px); the count adapts to the row's width. */
const PITCH_PX = 9;

const clamp = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Live microphone level as a dotted waveform: the newest sample scrolls in
 * from the right, so the row reads as the last few seconds of speech (the
 * same figure Codex draws in its composer while dictating). Cosmetic — one
 * RMS level per sample, no FFT.
 */
export function DotWave(props: { level: number; class?: string }) {
	let el: HTMLSpanElement | undefined;
	const [levels, setLevels] = createSignal<number[]>(new Array<number>(40).fill(0));

	const resize = (width: number) => {
		const count = Math.max(8, Math.floor(width / PITCH_PX));
		setLevels((prev) => {
			if (prev.length === count) return prev;
			if (prev.length > count) return prev.slice(prev.length - count);
			return [...new Array<number>(count - prev.length).fill(0), ...prev];
		});
	};

	onMount(() => {
		if (el && typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver((entries) => resize(entries[0]?.contentRect.width ?? 0));
			ro.observe(el);
			onCleanup(() => ro.disconnect());
		}
		const timer = setInterval(() => {
			const level = clamp(props.level);
			setLevels((prev) => [...prev.slice(1), level]);
		}, SAMPLE_MS);
		onCleanup(() => clearInterval(timer));
	});

	return (
		<span ref={el} class={`${s.wave} ${props.class ?? ""}`} role="img" aria-label="Microphone level">
			<Index each={levels()}>
				{(level) => (
					<span
						class={s.dot}
						style={{ transform: `scale(${1 + level() * 1.8})`, opacity: `${0.28 + level() * 0.72}` }}
					/>
				)}
			</Index>
		</span>
	);
}
