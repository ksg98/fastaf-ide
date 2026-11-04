import { onCleanup } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { isPerfDebug } from "../../utils/perfDebug";

type PressState = { held: boolean; pressTimer: boolean };
type TraceEvent =
	| "pointerdown"
	| "pointermove"
	| "pointerup"
	| "pointerleave"
	| "pointercancel"
	| "touchstart"
	| "touchmove"
	| "touchend"
	| "touchcancel"
	| "click"
	| "queue-open"
	| "send";

let nextPress = 0;
const finite = (value: number | undefined) => (value !== undefined && Number.isFinite(value) ? value : null);

function environment(button: HTMLButtonElement | undefined) {
	const rect = button?.getBoundingClientRect();
	const tag = document.activeElement?.tagName;
	return {
		activeElement: tag && ["BODY", "TEXTAREA", "INPUT", "BUTTON"].includes(tag) ? tag : "OTHER",
		viewportHeight: finite(window.visualViewport?.height),
		viewportOffsetTop: finite(window.visualViewport?.offsetTop),
		sendRect: rect
			? { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width), height: finite(rect.height) }
			: null,
	};
}

// DEFERRED (2026-10-29) — remove this bounded diagnostic after #2462-5839 has a failing iOS trace and closes.
export function createMobileSendTrace(button: () => HTMLButtonElement | undefined, state: () => PressState) {
	type Press = {
		id: number;
		startedAt: number;
		started: number;
		down: ReturnType<typeof environment> | null;
		click: ReturnType<typeof environment> | null;
		events: Array<PressState & { type: TraceEvent; ms: number; x: number | null; y: number | null }>;
		droppedEvents: number;
		sendCalled: boolean;
	};
	let press: Press | undefined;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	let settle: ReturnType<typeof setTimeout> | undefined;

	function finish(reason: "settled" | "deadline" | "next-press" | "unmount") {
		clearTimeout(deadline);
		clearTimeout(settle);
		const completed = press;
		press = undefined;
		if (!completed || !isPerfDebug()) return;
		appLogger.debug("mobile-send", `Mobile Send press: ${completed.startedAt}/${completed.id}`, {
			startedAt: completed.startedAt,
			durationMs: performance.now() - completed.started,
			reason,
			down: completed.down,
			click: completed.click,
			events: completed.events,
			droppedEvents: completed.droppedEvents,
			sendCalled: completed.sendCalled,
		});
	}

	function start(event: Event) {
		finish("next-press");
		if (!isPerfDebug()) return;
		press = {
			id: ++nextPress,
			startedAt: Date.now(),
			started: performance.now(),
			down: environment(button()),
			click: null,
			events: [],
			droppedEvents: 0,
			sendCalled: false,
		};
		deadline = setTimeout(() => finish("deadline"), 5000);
		record("pointerdown", event);
	}

	function record(type: TraceEvent, event?: Event) {
		if (!press || !isPerfDebug()) return;
		const point = event && "clientX" in event ? (event as PointerEvent) : undefined;
		if (press.events.length === 24) {
			// Retain the initial down and the newest events, including release/click.
			press.events.splice(1, 1);
			press.droppedEvents++;
		}
		press.events.push({
			type,
			ms: performance.now() - press.started,
			x: finite(point?.clientX),
			y: finite(point?.clientY),
			...state(),
		});
		if (type === "send") press.sendCalled = true;
		if (type === "click") press.click = environment(button());
		if (["pointerup", "pointercancel", "pointerleave", "touchend", "touchcancel", "click"].includes(type)) {
			clearTimeout(settle);
			// Keep the summary open for a delayed compatibility click after touchend.
			settle = setTimeout(() => finish("settled"), 400);
		}
	}

	onCleanup(() => finish("unmount"));
	return { start, record };
}
