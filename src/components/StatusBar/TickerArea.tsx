import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { usagePlacement } from "../../features/agentUsage";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { statusBarTicker, type TickerMessage, URGENT_PRIORITY } from "../../stores/statusBarTicker";
import { terminalsStore } from "../../stores/terminals";
import { cx } from "../../utils/cx";
import { countSideBySide, ROTATING_SLOT_RESERVE_PX } from "../../utils/tickerLayout";
import { IconClose } from "../icons";
import s from "./StatusBar.module.css";

const MessageBody: Component<{
	msg: TickerMessage;
	class?: string;
	/** Probe copies are never clickable. */
	interactive?: boolean;
	onContextMenu?: (e: MouseEvent) => void;
	children?: JSX.Element;
}> = (props) => (
	<span
		class={cx(
			s.tickerMessage,
			props.class,
			props.msg.priority >= URGENT_PRIORITY && s.tickerWarning,
			props.msg.priority >= 80 && props.msg.priority < URGENT_PRIORITY && s.tickerAttention,
			props.interactive && props.msg.onClick && s.tickerClickable,
		)}
		title={props.interactive ? props.msg.text : undefined}
		onContextMenu={props.interactive ? props.onContextMenu : undefined}
		role={props.interactive && props.msg.onClick ? "button" : undefined}
		tabIndex={props.interactive && props.msg.onClick ? 0 : undefined}
		onClick={props.interactive ? () => props.msg.onClick?.() : undefined}
		onKeyDown={
			props.interactive && props.msg.onClick
				? (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							props.msg.onClick?.();
						}
					}
				: undefined
		}
	>
		<Show when={props.msg.icon}>
			<span class={s.tickerIcon} innerHTML={props.msg.icon!} />
		</Show>
		<Show when={props.msg.label}>
			<span class={s.tickerLabel}>{props.msg.label!}</span>
			<span class={s.tickerSep}>{" \u00B7 "}</span>
		</Show>
		<span class={s.tickerText}>{props.msg.text}</span>
		{props.children}
	</span>
);

/**
 * Shared ticker area in the status bar.
 * Displays plugin messages side by side, rotating overflow in the last slot, with source label,
 * counter badge, click-to-cycle, and right-click popover.
 */
export const TickerArea: Component = () => {
	const [popoverOpen, setPopoverOpen] = createSignal(false);
	let areaRef: HTMLSpanElement | undefined;
	let probeRef: HTMLSpanElement | undefined;
	let popoverRef: HTMLDivElement | undefined;

	// Close popover on Escape
	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Escape" && popoverOpen()) {
			setPopoverOpen(false);
		}
	};

	// The ticker itself is inside: right-click on it toggles, so it must not count as an outside press.
	useOutsideDismiss({
		inside: () => [popoverRef, areaRef],
		onClose: () => setPopoverOpen(false),
		enabled: popoverOpen,
	});

	onMount(() => document.addEventListener("keydown", handleKeyDown));
	onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

	// Agent usage is placed by the shared rule (agent badge or nowhere), so it is excluded from
	// the pool itself rather than hidden after selection.
	const hidden = createMemo(() => {
		const active = terminalsStore.getActive();
		return (m: TickerMessage) => usagePlacement(m, active) !== "ticker";
	});
	const pool = createMemo(() => statusBarTicker.getPool(hidden()));

	// Layout: tickers sit side by side while the area has room; the ones that do not fit
	// rotate in the last slot. Natural widths come from a hidden probe row that renders the
	// whole pool, so the decision never depends on what is currently displayed.
	const [areaWidth, setAreaWidth] = createSignal(0);
	const [probeWidths, setProbeWidths] = createSignal<number[]>([]);
	const [gap, setGap] = createSignal(0);

	// offsetWidth rounds to whole pixels. Text is laid out in fractions (158.4px on a
	// 2x display), so a pool sized from rounded widths came out a fraction too narrow
	// and every ticker that should have fitted was cut with an ellipsis. Round up.
	const naturalWidth = (el: HTMLElement) => Math.max(el.offsetWidth, Math.ceil(el.getBoundingClientRect().width));

	const measure = () => {
		if (!areaRef || !probeRef) return;
		const widths = Array.from(probeRef.children, (el) => naturalWidth(el as HTMLElement));
		const gapPx = Number.parseFloat(getComputedStyle(areaRef).columnGap) || 0;
		// The pool's natural width, published before the area is read: the bottom strip
		// uses it as the area's width and the title bar as the most the area may grow to
		// (StatusBar.module.css), so the reading below already includes it. Set through a
		// binding it would land after this measurement and the layout would be decided
		// from the previous pool's width.
		const natural = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * gapPx;
		areaRef.style.setProperty("--ticker-pool-width", `${natural}px`);
		setProbeWidths(widths);
		setGap(gapPx);
		setAreaWidth(areaRef.offsetWidth);
	};

	onMount(() => {
		measure();
		const observer = new ResizeObserver(measure);
		if (areaRef) observer.observe(areaRef);
		if (probeRef) observer.observe(probeRef);
		onCleanup(() => observer.disconnect());
	});
	// The probe row resizes when message text changes, but a swapped pool of equal total width
	// would not trigger the observer.
	createEffect(on(pool, () => measure(), { defer: true }));

	const pinnedCount = createMemo(() =>
		probeWidths().length === pool().length ? countSideBySide(probeWidths(), areaWidth(), gap()) : 0,
	);
	// Measured, but with less room than one rotating slot needs: a ticker cut down to
	// "Ag…" says nothing, so the area shows nothing until there is room again. An
	// unmeasured area (width 0, as in a test without layout) still rotates.
	const collapsed = createMemo(
		() => pinnedCount() < pool().length && areaWidth() > 0 && areaWidth() < ROTATING_SLOT_RESERVE_PX,
	);
	const pinned = () => (collapsed() ? [] : pool().slice(0, pinnedCount()));
	const rotation = () => {
		if (collapsed()) return null;
		const state = statusBarTicker.getRotationState(hidden(), pinnedCount());
		return state.message ? state : null;
	};
	const allMessages = () => statusBarTicker.getActiveMessages();

	const handleBadgeClick = (e: MouseEvent) => {
		e.stopPropagation();
		statusBarTicker.advanceManually();
	};

	const handleContextMenu = (e: MouseEvent) => {
		e.preventDefault();
		setPopoverOpen((prev) => !prev);
	};

	const handlePopoverRowClick = (onClick?: () => void) => {
		onClick?.();
		setPopoverOpen(false);
	};

	return (
		<>
			<span
				ref={areaRef}
				class={cx(
					s.tickerArea,
					pool().length === 0 && s.tickerAreaEmpty,
					// Nothing shown for lack of room: the title bar moves the empty area out of the way.
					(collapsed() || (areaWidth() === 0 && probeWidths().some((width) => width > 0))) && s.tickerAreaCollapsed,
				)}
			>
				<For each={pinned()}>
					{(msg) => <MessageBody msg={msg} class={s.tickerPinned} interactive onContextMenu={handleContextMenu} />}
				</For>
				<Show when={rotation()}>
					{(state) => (
						<MessageBody msg={state().message!} interactive onContextMenu={handleContextMenu}>
							<Show when={state().total > 1}>
								<span class={s.tickerBadge} onClick={handleBadgeClick} title="Click to cycle tickers">
									{state().current}/{state().total} {"\u25B8"}
								</span>
							</Show>
						</MessageBody>
					)}
				</Show>
				<span ref={probeRef} class={s.tickerProbe} aria-hidden="true">
					<For each={pool()}>{(msg) => <MessageBody msg={msg} class={s.tickerPinned} />}</For>
				</span>
			</span>

			{/* Popover listing all active tickers */}
			<Show when={popoverOpen()}>
				<div ref={popoverRef} class={s.tickerPopover}>
					<div class={s.tickerPopoverHeader}>
						Active Tickers
						<button type="button" class={s.tickerPopoverClose} onClick={() => setPopoverOpen(false)} aria-label="Close">
							<IconClose size={12} />
						</button>
					</div>
					<div class={s.tickerPopoverList}>
						<For each={allMessages()} fallback={<div class={s.tickerPopoverEmpty}>No active tickers</div>}>
							{(msg) => (
								<div
									class={cx(
										s.tickerPopoverRow,
										msg.onClick && s.tickerPopoverRowClickable,
										msg.priority >= URGENT_PRIORITY && s.tickerPopoverRowUrgent,
									)}
									onClick={() => handlePopoverRowClick(msg.onClick)}
								>
									<Show when={msg.icon}>
										<span class={s.tickerIcon} innerHTML={msg.icon!} />
									</Show>
									<Show when={msg.label}>
										<span class={s.tickerPopoverLabel}>{msg.label}</span>
									</Show>
									<span class={s.tickerPopoverText}>{msg.text}</span>
									<Show when={msg.priority >= URGENT_PRIORITY}>
										<span class={s.tickerPopoverUrgentBadge}>URGENT</span>
									</Show>
								</div>
							)}
						</For>
					</div>
				</div>
			</Show>
		</>
	);
};
