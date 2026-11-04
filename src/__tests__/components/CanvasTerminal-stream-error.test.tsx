import { render, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const { subscribe, unsubscribe, eventHandlers } = vi.hoisted(() => ({
	eventHandlers: new Map<string, (error?: unknown, maxAttempts?: number) => void>(),
	subscribe: vi.fn().mockRejectedValue(new Error("WebSocket connection failed")),
	unsubscribe: vi.fn(),
}));

vi.mock("../../components/Terminal/canvasTerminalTransport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/canvasTerminalTransport")>()),
	createTransport: () => ({
		onStreamReconnecting: (handler: (attempt: number, maxAttempts: number) => void) =>
			eventHandlers.set("reconnecting", (attempt, max) => handler(Number(attempt), Number(max))),
		onStreamRecovered: (handler: () => void) => eventHandlers.set("recovered", handler),
		onStreamExhausted: (handler: (max: number) => void) =>
			eventHandlers.set("exhausted", (max) => handler(Number(max))),
		onStreamError: (handler: (error: unknown) => void) => eventHandlers.set("stream-error", handler),
		onEvent: vi.fn(async (type: string, handler: (error: unknown) => void) => {
			// Stream failures are WS-local callbacks, never PTY events.
			// Catches reverting the consumer to an orphan Tauri listener.
			if (type !== "stream-error") eventHandlers.set(type, handler);
		}),
		subscribe,
		unsubscribe,
		invoke: vi.fn().mockResolvedValue(undefined),
	}),
}));
vi.mock("../../components/Terminal/gridRenderer", () => ({
	createGridRenderer: () => ({ setTheme: vi.fn(), invalidateCaches: vi.fn(), paintGrid: vi.fn(), paintRow: vi.fn() }),
}));

import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { ToastContainer } from "../../components/ToastContainer/ToastContainer";
import { terminalsStore } from "../../stores/terminals";
import { toastsStore } from "../../stores/toasts";

function openTerminal() {
	vi.clearAllMocks();
	eventHandlers.clear();
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
			observe() {}
			disconnect() {}
		},
	);
	return render(() => (
		<>
			<CanvasTerminal sessionId="remote-stream" terminalId="remote-tab" />
			<ToastContainer />
		</>
	));
}

describe("CanvasTerminal stream errors", () => {
	// Catches: a failed WebSocket grid subscription only reaches the log and leaves a blank terminal.
	it("shows a toast when the grid stream cannot attach", async () => {
		const view = openTerminal();
		try {
			await waitFor(() => expect(subscribe).toHaveBeenCalled());
			await waitFor(() =>
				expect(
					toastsStore.toasts.some(
						(toast) =>
							toast.title === "Terminal stream failed" && toast.message.includes("WebSocket connection failed"),
					),
				).toBe(true),
			);
			expect(unsubscribe).toHaveBeenCalled();
		} finally {
			view.unmount();
			for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});
	// Catches: stream notice titles expose a session UUID instead of the current tab name.
	it("stream notices use the terminal display name instead of the session id", async () => {
		terminalsStore.register("remote-tab", {
			sessionId: "remote-stream",
			name: "Build worker",
			fontSize: 14,
			cwd: null,
			awaitingInput: null,
		});
		const view = openTerminal();
		try {
			await waitFor(() => expect(subscribe).toHaveBeenCalled());
			await waitFor(() => expect(view.container.textContent).toContain("Terminal stream failed — Build worker"));
			expect(view.container.textContent).not.toContain("remote-stream");
			terminalsStore.update("remote-tab", { name: "Renamed worker" });
			eventHandlers.get("reconnecting")?.(1, 10);
			expect(view.container.textContent).toContain("Terminal stream reconnecting — Renamed worker");
		} finally {
			view.unmount();
			terminalsStore.remove("remote-tab");
			for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});
	// Catches: stale sticky errors after recovery, premature final failure, duplicate retries, or clearing another session error.
	it("stream_banner_tracks_retries_and_clears_on_reconnect", async () => {
		subscribe.mockResolvedValueOnce(undefined);
		const view = openTerminal();
		try {
			await waitFor(() => expect(eventHandlers.has("stream-error")).toBe(true));
			vi.useFakeTimers();
			const unrelated = toastsStore.add(
				"Other session error",
				"Keep me",
				"error",
				false,
				undefined,
				0,
				undefined,
				"other-session",
				false,
			);
			eventHandlers.get("stream-error")?.(new Error("Timed out waiting for the initial terminal frame"));
			for (let attempt = 1; attempt <= 10; attempt++) {
				eventHandlers.get("reconnecting")?.(attempt, 10);
				expect(view.container.textContent).toContain(`Reconnecting ${attempt}/10`);
				expect(view.container.textContent).not.toContain("remote-stream");
				expect(view.container.textContent).not.toContain("Terminal stream failed");
				expect(toastsStore.toasts.filter((toast) => toast.sessionId === "remote-stream")).toHaveLength(1);
			}
			eventHandlers.get("exhausted")?.(10);
			expect(view.container.textContent).toContain("Terminal stream failed");
			await vi.advanceTimersByTimeAsync(60_000);
			expect(view.container.textContent).toContain("Terminal stream failed");
			eventHandlers.get("recovered")?.();
			expect(view.container.textContent).not.toContain("Terminal stream failed");
			expect(toastsStore.toasts.some((toast) => toast.id === unrelated)).toBe(true);
		} finally {
			vi.useRealTimers();
			view.unmount();
			eventHandlers.clear();
			for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		}
	});
});
