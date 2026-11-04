import { createSignal, onCleanup } from "solid-js";
import type { BoardCard } from "./types";

interface Drag {
	card: BoardCard;
	origin: string;
	pointerId: number;
	element: HTMLElement;
	startX: number;
	startY: number;
	started: boolean;
	x: number;
	y: number;
	target: string | null;
}

/** Pointer capture stays on the stable board root while virtualized cards move. */
export function createBoardDrag(
	root: () => HTMLElement | undefined,
	canMove: (card: BoardCard, column: string) => boolean,
	move: (card: BoardCard, column: string) => void,
) {
	const [drag, setDrag] = createSignal<Drag | null>(null);
	const cancel = () => {
		const current = drag();
		setDrag(null);
		if (current?.element.hasPointerCapture?.(current.pointerId))
			current.element.releasePointerCapture(current.pointerId);
	};
	const targetAt = (x: number, y: number): string | null => {
		for (const lane of root()?.querySelectorAll<HTMLElement>("[data-board-column]") ?? []) {
			const rect = lane.getBoundingClientRect();
			if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
				return lane.dataset.boardColumn ?? null;
		}
		return null;
	};
	const start = (event: PointerEvent, card: BoardCard, origin: string) => {
		const element = root();
		if (!element || event.button !== 0 || !event.isPrimary || drag()) return;
		// Native selects and links keep their own pointer/keyboard interaction.
		if (event.target instanceof Element && event.target.closest("select,button,a,input")) return;
		element.setPointerCapture(event.pointerId);
		setDrag({
			card,
			origin,
			pointerId: event.pointerId,
			element,
			startX: event.clientX,
			startY: event.clientY,
			x: event.clientX,
			y: event.clientY,
			started: false,
			target: null,
		});
	};
	const update = (event: PointerEvent) => {
		const current = drag();
		if (!current || event.pointerId !== current.pointerId) return;
		const started =
			current.started || Math.abs(event.clientX - current.startX) + Math.abs(event.clientY - current.startY) >= 5;
		const target = targetAt(event.clientX, event.clientY);
		setDrag({
			...current,
			started,
			x: event.clientX,
			y: event.clientY,
			target: started && target !== current.origin && target && canMove(current.card, target) ? target : null,
		});
		if (started) event.preventDefault();
	};
	const end = (event: PointerEvent) => {
		const current = drag();
		if (!current || event.pointerId !== current.pointerId) return;
		const target = targetAt(event.clientX, event.clientY);
		cancel();
		if (current.started && target && target !== current.origin && canMove(current.card, target))
			move(current.card, target);
	};
	const pointerCancel = (event: PointerEvent) => {
		if (drag()?.pointerId === event.pointerId) cancel();
	};
	onCleanup(cancel);
	return { drag, start, update, end, cancel, pointerCancel };
}
