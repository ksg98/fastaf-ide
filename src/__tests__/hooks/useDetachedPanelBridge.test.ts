import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen, mockProviderStart, mockProviderStop, mockCreateProvider } = vi.hoisted(() => ({
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockListen: vi.fn(),
	mockProviderStart: vi.fn(),
	mockProviderStop: vi.fn(),
	mockCreateProvider: vi.fn(),
}));

vi.mock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));
vi.mock("../../transport", () => ({ isTauri: () => true }));
vi.mock("../../utils/panelSync", () => ({
	createPanelSyncProvider: mockCreateProvider,
}));

import { useDetachedPanelBridge } from "../../hooks/useDetachedPanelBridge";
import type { PanelAdapter } from "../../panelRouter";
import { panelRegistry, registerPanel } from "../../panelRouter";
import { uiStore } from "../../stores/ui";

type EventHandler = (event: { payload: unknown }) => void;

const makeAdapter = (overrides: Partial<PanelAdapter> = {}): PanelAdapter => ({
	id: "test-panel",
	title: "Test Panel",
	defaultSize: { width: 600, height: 400 },
	Component: (() => null) as unknown as PanelAdapter["Component"],
	...overrides,
});

describe("useDetachedPanelBridge", () => {
	let dispose: (() => void) | undefined;
	let handlers: Map<string, EventHandler>;
	let restoreDetachedPanels: (() => void) | undefined;
	const unlisteners: Array<ReturnType<typeof vi.fn>> = [];

	const startBridge = async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			({ restoreDetachedPanels } = useDetachedPanelBridge());
		});
		await Promise.resolve();
	};

	beforeEach(() => {
		for (const key of Object.keys(panelRegistry)) delete panelRegistry[key];
		for (const key of Object.keys(uiStore.state.detachedPanels)) uiStore.clearDetached(key);
		handlers = new Map();
		unlisteners.length = 0;
		mockInvoke.mockReset().mockResolvedValue(undefined);
		mockListen.mockReset().mockImplementation((event: string, handler: EventHandler) => {
			handlers.set(event, handler);
			const unlisten = vi.fn();
			unlisteners.push(unlisten);
			return Promise.resolve(unlisten);
		});
		mockProviderStart.mockClear();
		mockProviderStop.mockClear();
		mockCreateProvider.mockReset().mockReturnValue({ start: mockProviderStart, stop: mockProviderStop });
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("routes close and reattach events through the registered adapter", async () => {
		const toggle = vi.fn();
		registerPanel(makeAdapter({ toggle }));
		uiStore.setDetached("test-panel", "panel-test-panel");
		await startBridge();

		handlers.get("panel-window-closed")?.({ payload: "test-panel" });

		expect(uiStore.isDetached("test-panel")).toBe(false);
		expect(toggle).toHaveBeenCalledOnce();

		uiStore.setDetached("test-panel", "panel-test-panel");
		handlers.get("panel-action")?.({ payload: { panelId: "test-panel", action: "reattach", data: {} } });
		expect(uiStore.isDetached("test-panel")).toBe(false);
		expect(toggle).toHaveBeenCalledTimes(2);
	});

	it("routes non-lifecycle actions to the adapter", async () => {
		const handleAction = vi.fn();
		registerPanel(makeAdapter({ handleAction }));
		await startBridge();

		handlers.get("panel-action")?.({ payload: { panelId: "test-panel", action: "refresh", data: { force: true } } });

		expect(handleAction).toHaveBeenCalledWith("refresh", { force: true });
	});

	it("starts and stops a projection provider with detached state", async () => {
		const serialize = vi.fn(() => ({ value: 1 }));
		registerPanel(makeAdapter({ serialize, syncIntervalMs: 500 }));
		await startBridge();

		uiStore.setDetached("test-panel", "panel-test-panel");
		expect(mockCreateProvider).toHaveBeenCalledWith("test-panel", serialize, 500);
		expect(mockProviderStart).toHaveBeenCalledOnce();

		uiStore.clearDetached("test-panel");
		expect(mockProviderStop).toHaveBeenCalledOnce();
	});

	it("restores known detached panels and clears unknown ones", async () => {
		registerPanel(makeAdapter());
		uiStore.setDetached("test-panel", "panel-test-panel");
		uiStore.setDetached("missing-panel", "panel-missing-panel");
		await startBridge();

		restoreDetachedPanels?.();

		expect(mockInvoke).toHaveBeenCalledWith("open_panel_window", {
			panelId: "test-panel",
			title: "Test Panel",
			params: {},
			width: 600,
			height: 400,
		});
		expect(uiStore.isDetached("missing-panel")).toBe(false);
	});

	it("cleans up both native listeners on disposal", async () => {
		registerPanel(makeAdapter());
		await startBridge();

		dispose?.();
		dispose = undefined;

		expect(unlisteners).toHaveLength(2);
		expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
	});
});
