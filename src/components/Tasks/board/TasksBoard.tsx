import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { BoardLane } from "./BoardLane";
import s from "./board.module.css";
import { createBoardDrag } from "./pointerDrag";
import { type BoardCard, cardKey, type TasksBoardProps } from "./types";

interface Placement {
	column: string;
	pending: boolean;
	card: BoardCard;
}
export const TasksBoard: Component<TasksBoardProps> = (props) => {
	let root: HTMLDivElement | undefined;
	let generation = 0;
	let mounted = true;
	const scope = createMemo(() => JSON.stringify([props.scopeKey, props.board.id]));
	const [placements, setPlacements] = createSignal<ReadonlyMap<string, Placement>>(new Map());
	const [error, setError] = createSignal("");
	const [announcement, setAnnouncement] = createSignal("");
	const pending = (key: string) => placements().get(key)?.pending ?? false;
	const canMove = (card: BoardCard, column: string) =>
		!pending(cardKey(card.item.reference)) && card.moves.some((move) => move.columnId === column);
	const move = async (card: BoardCard, columnId: string) => {
		const action = card.moves.find((move) => move.columnId === columnId)?.action;
		const column = props.board.columns.find((candidate) => candidate.id === columnId);
		if (!column || !action || !canMove(card, columnId)) return;
		const key = cardKey(card.item.reference);
		const previous = placements().get(key);
		const attempt = generation;
		setError("");
		setPlacements((current) => new Map(current).set(key, { column: columnId, pending: true, card }));
		let accepted = false;
		try {
			const result = await props.onMove(card.item.reference, action);
			if (!mounted || generation !== attempt) return;
			setPlacements((current) =>
				new Map(current).set(key, {
					column: columnId,
					pending: false,
					card: { ...card, moves: [], item: result.kind === "item" ? result.value.item : card.item },
				}),
			);
			accepted = true;
			setAnnouncement(`${card.item.key} moved to ${column.name}`);
			props.onUpdated?.(result);
		} catch (cause) {
			if (!mounted || generation !== attempt) return;
			if (!accepted)
				setPlacements((current) => {
					const next = new Map(current);
					if (previous) next.set(key, previous);
					else next.delete(key);
					return next;
				});
			setError(
				`${accepted ? "Moved, but could not refresh" : "Could not move"} ${card.item.key}: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	};
	const drag = createBoardDrag(
		() => root,
		canMove,
		(card, column) => {
			void move(card, column);
		},
	);
	createEffect(
		on(scope, () => {
			generation += 1;
			setPlacements(new Map());
			setError("");
			setAnnouncement("");
			drag.cancel();
		}),
	);
	createEffect(
		on(
			() => props.lanes,
			(lanes) => {
				setPlacements((current) => {
					const next = new Map(current);
					for (const lane of lanes)
						for (const card of lane.cards) {
							const key = cardKey(card.item.reference);
							const placement = next.get(key);
							if (placement && !placement.pending && placement.column === lane.columnId) next.delete(key);
						}
					return next;
				});
			},
		),
	);
	const lanes = createMemo(() => {
		const result = new Map<string, BoardCard[]>();
		for (const column of props.board.columns) result.set(column.id, []);
		for (const lane of props.lanes)
			for (const card of lane.cards) {
				const override = placements().get(cardKey(card.item.reference));
				result.get(override?.column ?? lane.columnId)?.push(override?.card ?? card);
			}
		return result;
	});
	const cancelOnEscape = (event: KeyboardEvent) => {
		if (event.key === "Escape") drag.cancel();
	};
	onMount(() => {
		window.addEventListener("keydown", cancelOnEscape);
		window.addEventListener("blur", drag.cancel);
		document.addEventListener("visibilitychange", drag.cancel);
	});
	onCleanup(() => {
		mounted = false;
		generation += 1;
		window.removeEventListener("keydown", cancelOnEscape);
		window.removeEventListener("blur", drag.cancel);
		document.removeEventListener("visibilitychange", drag.cancel);
	});
	return (
		<div class={s.container}>
			<header class={s.header}>
				<h2>{props.board.name}</h2>
			</header>
			<Show when={error()}>
				<p role="alert" class={s.error}>
					{error()}
				</p>
			</Show>
			<p aria-live="polite" class={s.announcement}>
				{announcement()}
			</p>
			<div
				ref={root}
				class={s.board}
				aria-label={props.board.name}
				onPointerMove={drag.update}
				onPointerUp={drag.end}
				onPointerCancel={drag.pointerCancel}
				onLostPointerCapture={drag.pointerCancel}
			>
				<For each={props.board.columns}>
					{(column) => (
						<BoardLane
							column={column}
							hasMore={props.hasMore}
							loadingMore={props.loadingMore}
							onMore={props.onMore}
							columns={props.board.columns}
							cards={lanes().get(column.id) ?? []}
							target={drag.drag()?.target === column.id}
							pending={pending}
							canMove={canMove}
							onMove={(card, id) => {
								void move(card, id);
							}}
							onPointerDown={(event, card) => {
								if (!pending(cardKey(card.item.reference))) drag.start(event, card, column.id);
							}}
							onOpen={props.onOpen ? (card) => props.onOpen?.(card.item.reference) : undefined}
							cardActions={props.cardActions}
						/>
					)}
				</For>
			</div>
			<Show when={drag.drag()?.started ? drag.drag() : null}>
				{(active) => (
					<div
						class={s.ghost}
						aria-hidden="true"
						data-board-ghost
						style={{ left: `${active().x + 12}px`, top: `${active().y + 12}px` }}
					>
						<span class={s.key}>{active().card.item.key}</span>
						<p>{active().card.item.title}</p>
					</div>
				)}
			</Show>
		</div>
	);
};
