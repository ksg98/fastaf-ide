import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockOnCloseRequested, mockEmitTo } = vi.hoisted(() => ({
	mockOnCloseRequested: vi.fn(),
	mockEmitTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
	emitTo: mockEmitTo,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		setTitle: vi.fn().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		onCloseRequested: mockOnCloseRequested,
	}),
}));

vi.mock("../stores/settings", () => ({
	settingsStore: {
		hydrate: vi.fn().mockResolvedValue(undefined),
		state: { defaultFontSize: 13, theme: "dark", font: "mono" },
	},
}));

vi.mock("../stores/terminals", () => ({
	terminalsStore: {
		register: vi.fn(),
		setActive: vi.fn(),
		get: vi.fn(() => undefined),
		isBusy: vi.fn(() => false),
		setFontSize: vi.fn(),
	},
}));

vi.mock("../themes", () => ({
	applyAppTheme: vi.fn(),
	applyFontFamily: vi.fn(),
	listenForThemeChanges: vi.fn().mockResolvedValue(undefined),
	loadThemes: vi.fn().mockResolvedValue(undefined),
	themesLoaded: () => false,
}));

vi.mock("../platform", () => ({ isMacOS: () => false }));

vi.mock("../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../components/Terminal", () => ({ Terminal: () => null }));
vi.mock("../components/ui/PanelWindowControls", () => ({ IconReattach: () => null }));

import { FloatingTerminal } from "../FloatingTerminal";

describe("FloatingTerminal onCloseRequested dispose", () => {
	beforeEach(() => {
		mockEmitTo.mockClear();
		window.location.hash = "#/floating?sessionId=s1&tabId=t1&name=Term";
	});

	afterEach(() => {
		cleanup();
	});

	it("unmounting after a stale unlisten (webview reload already cleared the backend registration) does not surface an unhandled rejection", async () => {
		// getCurrentWebviewWindow().onCloseRequested() is Tauri's raw UnlistenFn —
		// `async () => _unlisten(...)`. If the backend already dropped this window's
		// registration (a webview reload), the single dispose call on unmount still
		// rejects *inside* that async fn — an unhandled rejection unless this caller
		// guards it the way invoke.ts's listen() already does.
		mockOnCloseRequested.mockResolvedValue(() =>
			Promise.reject(new Error("undefined is not an object (evaluating 'listeners[eventId].handlerId')")),
		);

		const { unmount } = render(() => <FloatingTerminal />);
		// Flush the onMount async chain (hydrate -> loadThemes -> setTitle -> onCloseRequested registration).
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const seen: unknown[] = [];
		const onUnhandled = (reason: unknown) => seen.push(reason);
		process.on("unhandledRejection", onUnhandled);

		expect(() => unmount()).not.toThrow();

		await new Promise((r) => setTimeout(r, 20));
		process.off("unhandledRejection", onUnhandled);
		expect(seen).toEqual([]);
	});
});
