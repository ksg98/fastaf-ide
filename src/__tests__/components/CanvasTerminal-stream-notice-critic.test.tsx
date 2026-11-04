import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { subscribe, streamError, visibility } = vi.hoisted(() => ({
	subscribe: vi.fn<() => Promise<void>>(),
	visibility: { callback: undefined as IntersectionObserverCallback | undefined },
	streamError: { handler: undefined as ((error: unknown) => void) | undefined },
}));

// These lifecycle warnings are independent of opt-in frame-burst diagnostics.
vi.mock("../../utils/perfDebug", () => ({ isPerfDebug: () => false }));

vi.mock("../../components/Terminal/canvasTerminalTransport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/canvasTerminalTransport")>()),
	createTransport: () => ({
		onStreamError: (handler: (error: unknown) => void) => {
			streamError.handler = handler;
		},
		onEvent: async () => {},
		ackFrame: () => {},
		subscribe,
		unsubscribe: () => {
			streamError.handler = undefined;
		},
		invoke: async () => undefined,
	}),
}));
vi.mock("../../components/Terminal/gridRenderer", () => ({
	createGridRenderer: () => ({ setTheme: vi.fn(), invalidateCaches: vi.fn(), paintGrid: vi.fn(), paintRow: vi.fn() }),
}));

import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { ToastContainer } from "../../components/ToastContainer/ToastContainer";
import { appLogger } from "../../stores/appLogger";
import { toastsStore } from "../../stores/toasts";

beforeEach(() => {
	visibility.callback = undefined;
	subscribe.mockReset().mockResolvedValue(undefined);
	vi.spyOn(appLogger, "warn").mockImplementation(() => {});
	vi.spyOn(appLogger, "error").mockImplementation(() => {});
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		clearRect: vi.fn(),
		setTransform: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: IntersectionObserverCallback) {
				visibility.callback = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => {
	for (const [, message] of vi.mocked(appLogger.warn).mock.calls) {
		expect(message).toMatch(/^Pane stayed unsized for 120 frames/);
	}
	for (const [, message] of vi.mocked(appLogger.error).mock.calls) {
		expect(message).toBe("Failed to subscribe to terminal grid channel");
	}
	for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const openTerminal = () => render(() => <CanvasTerminal sessionId="closed-stream" terminalId="closed-tab" />);

describe("stream notice ownership on terminal disposal", () => {
	// Catches: an orphan reconnect banner survives closing and reopening a healthy terminal.
	it("closing a reconnecting terminal removes its notice and preserves unrelated errors", async () => {
		const notices = render(() => <ToastContainer />);
		const terminal = openTerminal();
		try {
			await waitFor(() => expect(subscribe).toHaveBeenCalled());
			toastsStore.add(
				"Unrelated failure",
				"Keep this error",
				"error",
				false,
				undefined,
				0,
				undefined,
				undefined,
				false,
			);
			streamError.handler?.(new Error("Terminal stream disconnected"));
			expect(notices.container.textContent).toContain("Terminal stream reconnecting");
			terminal.unmount();
			expect(notices.container.textContent).not.toContain("Terminal stream reconnecting");
			expect(notices.container.textContent).toContain("Keep this error");
		} finally {
			terminal.unmount();
			notices.unmount();
		}
	});

	// Catches: a pending attach rejection recreates a banner after the terminal has been closed.
	it("a subscription rejection after terminal closure cannot publish a stale failure notice", async () => {
		let rejectAttach!: (error: Error) => void;
		subscribe.mockImplementationOnce(
			() =>
				new Promise<void>((_, reject) => {
					rejectAttach = reject;
				}),
		);
		const notices = render(() => <ToastContainer />);
		const terminal = openTerminal();
		try {
			await waitFor(() => expect(subscribe).toHaveBeenCalled());
			terminal.unmount();
			rejectAttach(new Error("Closed socket attach failed"));
			await Promise.resolve();
			await Promise.resolve();
			expect(notices.container.textContent).not.toContain("Closed socket attach failed");
		} finally {
			terminal.unmount();
			notices.unmount();
		}
	});
});

// Catches: hidden mounts consume the sizing budget and pollute the warning log.
describe("unsized pane warning visibility 2439", () => {
	let frames: Map<number, FrameRequestCallback>;
	beforeEach(() => {
		frames = new Map();
		let next = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			frames.set(++next, callback);
			return next;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	});
	const setVisible = (visible: boolean) =>
		visibility.callback?.(
			[{ isIntersecting: visible, time: performance.now() } as IntersectionObserverEntry],
			{} as IntersectionObserver,
		);
	const advanceFrames = (count: number) => {
		for (let frame = 0; frame < count; frame++) {
			const callbacks = [...frames.values()];
			frames.clear();
			for (const callback of callbacks) callback(frame * 16);
		}
	};

	it.each([false, true])("warns only when the unsized pane is visible: %s", async (visible) => {
		const terminal = openTerminal();
		try {
			await waitFor(() => expect(visibility.callback).toBeDefined());
			setVisible(visible);
			advanceFrames(125);
			expect(appLogger.warn).toHaveBeenCalledTimes(visible ? 1 : 0);
		} finally {
			terminal.unmount();
		}
	});

	// Catches: a pending visible retry warns after the pane leaves the layout.
	it.each(["hidden", "detached", "unmounted"])("does not warn after the pane becomes %s", async (state) => {
		const terminal = openTerminal();
		try {
			await waitFor(() => expect(visibility.callback).toBeDefined());
			setVisible(true);
			advanceFrames(60);
			if (state === "hidden") setVisible(false);
			else if (state === "detached") terminal.container.remove();
			else terminal.unmount();
			advanceFrames(125);
			expect(appLogger.warn).not.toHaveBeenCalled();
		} finally {
			terminal.unmount();
		}
	});
});
