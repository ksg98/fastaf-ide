import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { rpc } from "../../transport";
import { CommandInput } from "../components/CommandInput";

const diagnostics = vi.hoisted(() => ({ enabled: true }));
vi.mock("../../utils/perfDebug", () => ({ isPerfDebug: () => diagnostics.enabled }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => ({})),
	HttpRpcError: class extends Error {},
}));

beforeEach(() => {
	vi.useFakeTimers();
	diagnostics.enabled = true;
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

function mount() {
	const view = render(() => <CommandInput sessionId="private-session-name" />);
	const input = view.container.querySelector("textarea")!;
	fireEvent.input(input, { target: { value: "PRIVATE draft text and credential" } });
	return { ...view, input, send: view.getByLabelText("Send") };
}
function summaries() {
	return vi.mocked(appLogger.debug).mock.calls.filter(([source]) => source === "mobile-send");
}

// Catches: serializing a DOM event/element leaks the draft instead of numeric press metadata.
it("records the short-tap sequence and changing viewport without draft or DOM text", async () => {
	const { input, send } = mount();
	const viewport = { height: 500, offsetTop: 12 };
	vi.stubGlobal("visualViewport", viewport);
	vi.spyOn(send, "getBoundingClientRect")
		.mockReturnValueOnce({ x: 347, y: 450, width: 44, height: 44 } as DOMRect)
		.mockReturnValueOnce({ x: 347, y: 804, width: 44, height: 44 } as DOMRect);
	input.focus();
	fireEvent.pointerDown(send, { button: 0, clientX: 353, clientY: 472 });
	fireEvent.touchStart(send);
	await vi.advanceTimersByTimeAsync(70);
	fireEvent.pointerUp(send);
	fireEvent.pointerLeave(send);
	fireEvent.touchEnd(send);
	viewport.height = 852;
	viewport.offsetTop = 0;
	send.focus();
	fireEvent.click(send);
	await vi.advanceTimersByTimeAsync(400);
	expect(summaries()).toHaveLength(1);
	const [source, message, data] = summaries()[0];
	expect(source).toBe("mobile-send");
	expect(message).toMatch(/^Mobile Send press: \d+\/\d+$/);
	expect(data).toMatchObject({
		sendCalled: true,
		down: {
			activeElement: "TEXTAREA",
			viewportHeight: 500,
			viewportOffsetTop: 12,
			sendRect: { x: 347, y: 450, width: 44, height: 44 },
		},
		click: {
			activeElement: "BUTTON",
			viewportHeight: 852,
			viewportOffsetTop: 0,
			sendRect: { x: 347, y: 804, width: 44, height: 44 },
		},
		events: [
			{ type: "pointerdown", ms: 0, held: false, pressTimer: true },
			{ type: "touchstart", ms: 0 },
			{ type: "pointerup", ms: 70, held: false, pressTimer: false },
			{ type: "pointerleave", ms: 70 },
			{ type: "touchend", ms: 70 },
			{ type: "click", ms: 70 },
			{ type: "send", ms: 70 },
		],
	});
	const serialized = JSON.stringify(summaries()[0]);
	expect(serialized).not.toContain("PRIVATE");
	expect(serialized).not.toContain("credential");
	expect(serialized).not.toContain("private-session-name");
	expect(serialized).not.toContain("Type a command");
	expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "private-session-name", data: "\r" });
});

// Catches: a cancellation without click never flushes, or consumes the next press summary.
it("logs a cancelled scroll once and keeps the next short tap independent", async () => {
	const { send } = mount();
	// Recorded Chrome touch sequence: movement cancels without a compatibility click.
	fireEvent.pointerDown(send, { button: 0 });
	fireEvent.touchStart(send);
	fireEvent.pointerMove(send, { clientX: 381, clientY: 838 });
	fireEvent.pointerCancel(send);
	fireEvent.pointerLeave(send);
	fireEvent.touchCancel(send);
	await vi.advanceTimersByTimeAsync(400);
	expect(summaries()).toHaveLength(1);
	expect(summaries()[0][2]).toMatchObject({
		click: null,
		sendCalled: false,
		events: expect.arrayContaining([{ type: "pointercancel", ms: 0, x: 0, y: 0, held: true, pressTimer: false }]),
	});
	fireEvent.pointerDown(send, { button: 0 });
	fireEvent.pointerUp(send);
	fireEvent.click(send);
	await vi.advanceTimersByTimeAsync(400);
	expect(summaries()).toHaveLength(2);
	expect(summaries()[1][2]).toMatchObject({ sendCalled: true });
	expect(summaries()[0][1]).not.toBe(summaries()[1][1]);
});

// Catches: diagnostic handlers change the held flag and submit after the queue shortcut.
it("reports the long-press click suppression without changing Queue behavior", async () => {
	const { send, getByRole } = mount();
	fireEvent.pointerDown(send, { button: 0 });
	await vi.advanceTimersByTimeAsync(500);
	fireEvent.pointerUp(send);
	fireEvent.click(send);
	await vi.advanceTimersByTimeAsync(400);
	expect(getByRole("menuitem").textContent).toBe("Queue");
	expect(summaries()).toHaveLength(1);
	expect(summaries()[0][2]).toMatchObject({
		sendCalled: false,
		events: expect.arrayContaining([
			expect.objectContaining({ type: "queue-open", held: true }),
			expect.objectContaining({ type: "click", held: true, pressTimer: false }),
		]),
	});
	expect(vi.mocked(rpc).mock.calls.some(([, args]) => args?.data === "\r")).toBe(false);
});

// Catches: pointermove floods grow retained data, evict the final click, or log more than once.
it("bounds event retention while keeping the initial down and final send", async () => {
	const { send } = mount();
	fireEvent.pointerDown(send, { button: 0 });
	for (let i = 0; i < 100; i++) fireEvent.pointerMove(send);
	fireEvent.pointerUp(send);
	fireEvent.click(send);
	await vi.advanceTimersByTimeAsync(5000);
	expect(summaries()).toHaveLength(1);
	expect(summaries()[0][2]).toMatchObject({
		droppedEvents: 80,
		events: [
			expect.objectContaining({ type: "pointerdown" }),
			...Array.from({ length: 20 }, () => expect.objectContaining({ type: "pointermove" })),
			expect.objectContaining({ type: "pointerup" }),
			expect.objectContaining({ type: "click" }),
			expect.objectContaining({ type: "send" }),
		],
	});
});

// Catches: an abandoned gesture leaves a timer forever or emits again on unmount.
it("finishes an abandoned press at its diagnostic deadline exactly once", async () => {
	const { send, unmount } = mount();
	fireEvent.pointerDown(send, { button: 0 });
	await vi.advanceTimersByTimeAsync(5000);
	unmount();
	expect(summaries()).toHaveLength(1);
	expect(summaries()[0][2]).toMatchObject({ reason: "deadline", sendCalled: false });
});

// Catches: production builds collect diagnostics or read layout with the master gate off.
it("does no tracing when perfDebug is off while Send still submits", async () => {
	diagnostics.enabled = false;
	const { send } = mount();
	const geometry = vi.spyOn(send, "getBoundingClientRect");
	fireEvent.pointerDown(send, { button: 0 });
	fireEvent.touchStart(send);
	fireEvent.pointerUp(send);
	fireEvent.touchEnd(send);
	fireEvent.click(send);
	await vi.advanceTimersByTimeAsync(5000);
	expect(summaries()).toHaveLength(0);
	expect(geometry).not.toHaveBeenCalled();
	expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "private-session-name", data: "\r" });
});
