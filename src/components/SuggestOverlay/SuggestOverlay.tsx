import { type Component, For, onCleanup, onMount } from "solid-js";
import { Button } from "../ui";
import styles from "./SuggestOverlay.module.css";

interface SuggestOverlayProps {
	items: string[];
	onSelect: (text: string) => void;
	onDismiss: () => void;
}

const DISMISS_TIMEOUT_MS = 30_000;

/** Strip leading "N) " or "N. " numbering that duplicates the shortcut badge. */
const stripNumberPrefix = (text: string): string => text.replace(/^\d+[).]\s*/, "");

const SuggestOverlay: Component<SuggestOverlayProps> = (props) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	// Remaining dismiss budget; decrements while window focused, pauses when blurred/hidden.
	let remainingMs = DISMISS_TIMEOUT_MS;
	let startedAt = 0;

	const startTimer = () => {
		if (timer || remainingMs <= 0) return;
		startedAt = Date.now();
		timer = setTimeout(() => props.onDismiss(), remainingMs);
	};
	const pauseTimer = () => {
		if (!timer) return;
		clearTimeout(timer);
		timer = undefined;
		remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
	};
	const onVisibilityChange = () => {
		if (document.hidden) pauseTimer();
		else startTimer();
	};
	const onWindowBlur = () => pauseTimer();
	const onWindowFocus = () => startTimer();

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape") {
			e.preventDefault();
			e.stopPropagation();
			props.onDismiss();
			return;
		}
		// Number keys 1-4 select the corresponding suggestion
		const num = parseInt(e.key, 10);
		if (num >= 1 && num <= 4 && num <= props.items.length) {
			e.preventDefault();
			props.onSelect(props.items[num - 1]);
			return;
		}
		// Any printable key (typing) dismisses the overlay
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
			props.onDismiss();
		}
	};

	onMount(() => {
		document.addEventListener("keydown", handleKeyDown, true);
		document.addEventListener("visibilitychange", onVisibilityChange);
		window.addEventListener("blur", onWindowBlur);
		window.addEventListener("focus", onWindowFocus);
		// Only arm the timer if the window is currently focused/visible; otherwise
		// the user opened the overlay in the background and we'd dismiss it before
		// they ever see it.
		if (!document.hidden && document.hasFocus()) startTimer();
	});

	onCleanup(() => {
		document.removeEventListener("keydown", handleKeyDown, true);
		document.removeEventListener("visibilitychange", onVisibilityChange);
		window.removeEventListener("blur", onWindowBlur);
		window.removeEventListener("focus", onWindowFocus);
		if (timer) clearTimeout(timer);
	});

	return (
		<div class={styles.overlay}>
			<For each={props.items}>
				{(item, index) => {
					const label = stripNumberPrefix(item);
					return (
						<Button class={styles.chip} onClick={() => props.onSelect(item)} title={label}>
							<span class={styles.shortcut} data-shortcut>
								{index() + 1}
							</span>
							<span class={styles.chipLabel}>{label}</span>
						</Button>
					);
				}}
			</For>
			<Button variant="ghost" class={styles.closeBtn} onClick={() => props.onDismiss()} title="Dismiss (Esc)">
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
					<path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z" />
				</svg>
			</Button>
		</div>
	);
};

export default SuggestOverlay;
