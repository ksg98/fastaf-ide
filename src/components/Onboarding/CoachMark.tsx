import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import s from "./CoachMark.module.css";

/**
 * A one-time callout pinned above a control, explaining what it does and
 * how to reach it from the keyboard. Anchors by `data-coach="<name>"` so the
 * control itself needs no wiring beyond the attribute. Dismisses on "Got it",
 * Escape, or when the caller decides the user has done the thing.
 */
export interface CoachMarkProps {
	anchor: string;
	title: string;
	body: string;
	kbd?: string;
	actionLabel?: string;
	onAction?: () => void;
	onDismiss: () => void;
}

const WIDTH = 272;
const GAP = 10;
const EDGE = 8;

export function CoachMark(props: CoachMarkProps) {
	const [pos, setPos] = createSignal<{ left: number; bottom: number; arrow: number } | null>(null);

	const place = () => {
		const el = document.querySelector<HTMLElement>(`[data-coach="${props.anchor}"]`);
		if (!el) {
			setPos(null);
			return;
		}
		const r = el.getBoundingClientRect();
		const centre = r.left + r.width / 2;
		const left = Math.max(EDGE, Math.min(window.innerWidth - WIDTH - EDGE, centre - WIDTH / 2));
		setPos({
			left,
			bottom: window.innerHeight - r.top + GAP,
			arrow: Math.max(14, Math.min(WIDTH - 14, centre - left)),
		});
	};

	onMount(() => {
		place();
		// Anchors move when panels open or the window resizes; a slow poll
		// covers the layout changes no event announces.
		const timer = setInterval(place, 800);
		window.addEventListener("resize", place);
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") props.onDismiss();
		};
		window.addEventListener("keydown", onKey);
		onCleanup(() => {
			clearInterval(timer);
			window.removeEventListener("resize", place);
			window.removeEventListener("keydown", onKey);
		});
	});

	return (
		<Portal>
			<Show when={pos()}>
				{(p) => (
					<div
						class={s.mark}
						role="dialog"
						aria-label={props.title}
						data-testid={`coach-${props.anchor}`}
						style={{
							left: `${p().left}px`,
							bottom: `${p().bottom}px`,
							width: `${WIDTH}px`,
							"--arrow-x": `${p().arrow}px`,
						}}
					>
						<div class={s.title}>{props.title}</div>
						<div class={s.body}>{props.body}</div>
						<div class={s.actions}>
							<Show when={props.kbd}>
								<kbd class={s.kbd}>{props.kbd}</kbd>
							</Show>
							<span class={s.spacer} />
							<button class={s.dismiss} onClick={() => props.onDismiss()}>
								Got it
							</button>
							<Show when={props.actionLabel && props.onAction}>
								<button
									class={s.action}
									onClick={() => {
										props.onAction?.();
										props.onDismiss();
									}}
								>
									{props.actionLabel}
								</button>
							</Show>
						</div>
					</div>
				)}
			</Show>
		</Portal>
	);
}

export default CoachMark;
