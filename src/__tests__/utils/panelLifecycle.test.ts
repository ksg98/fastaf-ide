import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockEmitTo } = vi.hoisted(() => ({
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockEmitTo: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
	emitTo: mockEmitTo,
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
}));

vi.mock("../../transport", () => ({
	isTauri: () => true,
}));

import { createMarkdownDocumentPanelAdapter } from "../../panelAdapters/markdownDocument";
import type { PanelAdapter } from "../../panelRouter";
import { panelRegistry, registerPanel } from "../../panelRouter";
import { mdTabsStore } from "../../stores/mdTabs";
import { uiStore } from "../../stores/ui";

function makeAdapter(overrides: Partial<PanelAdapter> = {}): PanelAdapter {
	return {
		id: "test-panel",
		title: "Test Panel",
		defaultSize: { width: 600, height: 400 },
		Component: (() => null) as unknown as PanelAdapter["Component"],
		...overrides,
	};
}

describe("panelLifecycle", () => {
	let detachPanel: typeof import("../../panelRouter").detachPanel;
	let togglePanel: typeof import("../../panelRouter").togglePanel;
	let reattachPanel: typeof import("../../panelRouter").reattachPanel;

	beforeEach(async () => {
		mdTabsStore.clearAll();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		mockEmitTo.mockReset().mockResolvedValue(undefined);

		for (const key of Object.keys(panelRegistry)) {
			delete panelRegistry[key];
		}

		if (uiStore.isDetached("test-panel")) {
			uiStore.clearDetached("test-panel");
		}
		uiStore._testCancelPendingSave();

		const mod = await import("../../panelRouter");
		detachPanel = mod.detachPanel;
		togglePanel = mod.togglePanel;
		reattachPanel = mod.reattachPanel;
	});

	afterEach(() => {
		uiStore._testCancelPendingSave();
	});

	describe("togglePanel", () => {
		it("calls adapter.toggle when panel is not detached", () => {
			const toggle = vi.fn();
			registerPanel(makeAdapter({ toggle }));

			togglePanel("test-panel");

			expect(toggle).toHaveBeenCalledOnce();
			expect(mockInvoke).not.toHaveBeenCalledWith("focus_panel_window", expect.anything());
		});

		it("focuses detached window when panel is detached", () => {
			const toggle = vi.fn();
			registerPanel(makeAdapter({ toggle }));
			uiStore.setDetached("test-panel", "panel-test-panel");

			togglePanel("test-panel");

			expect(toggle).not.toHaveBeenCalled();
			expect(mockInvoke).toHaveBeenCalledWith("focus_panel_window", {
				panelId: "test-panel",
			});
		});

		it("returns false for unregistered panel", () => {
			const result = togglePanel("nonexistent");
			expect(result).toBe(false);
		});

		it("returns false when adapter has no toggle", () => {
			registerPanel(makeAdapter({ toggle: undefined }));
			const result = togglePanel("test-panel");
			expect(result).toBe(false);
		});

		it("returns true on successful toggle", () => {
			registerPanel(makeAdapter({ toggle: vi.fn() }));
			const result = togglePanel("test-panel");
			expect(result).toBe(true);
		});
	});

	describe("detachPanel", () => {
		it("opens a tuic://open Markdown document in a resizable panel window with its file path", async () => {
			const tabId = mdTabsStore.addMcpFile("digest-1", "", "/Users/boss/report.md", false, false);
			const adapter = createMarkdownDocumentPanelAdapter(tabId);
			registerPanel(adapter);
			await detachPanel(adapter.id);
			expect(mockInvoke).toHaveBeenCalledWith("open_panel_window", {
				panelId: adapter.id,
				title: "report.md",
				params: {
					tabId,
					filePath: "/Users/boss/report.md",
					fileName: "report.md",
					repoPath: "",
					fsRoot: "",
				},
				width: 900,
				height: 750,
			});
			expect(uiStore.isDetached(adapter.id)).toBe(true);
		});

		it("invokes open_panel_window with adapter config", async () => {
			registerPanel(makeAdapter());

			await detachPanel("test-panel");

			expect(mockInvoke).toHaveBeenCalledWith("open_panel_window", {
				panelId: "test-panel",
				title: "Test Panel",
				params: {},
				width: 600,
				height: 400,
			});
		});

		it("sets detached state in uiStore", async () => {
			registerPanel(makeAdapter());

			await detachPanel("test-panel");

			expect(uiStore.isDetached("test-panel")).toBe(true);
		});

		it("passes detachParams to open_panel_window", async () => {
			registerPanel(
				makeAdapter({
					detachParams: () => ({ chatId: "abc-123" }),
				}),
			);

			await detachPanel("test-panel");

			expect(mockInvoke).toHaveBeenCalledWith("open_panel_window", {
				panelId: "test-panel",
				title: "Test Panel",
				params: { chatId: "abc-123" },
				width: 600,
				height: 400,
			});
		});

		it("calls onDetach callback after opening window", async () => {
			const onDetach = vi.fn();
			registerPanel(makeAdapter({ onDetach }));

			await detachPanel("test-panel");

			expect(onDetach).toHaveBeenCalledOnce();
		});

		it("is no-op for unregistered panel", async () => {
			await detachPanel("nonexistent");
			expect(mockInvoke).not.toHaveBeenCalledWith("open_panel_window", expect.anything());
		});
	});

	describe("reattachPanel", () => {
		it("emits reattach action to main window", async () => {
			await reattachPanel("test-panel");

			expect(mockEmitTo).toHaveBeenCalledWith("main", "panel-action", {
				panelId: "test-panel",
				action: "reattach",
				data: {},
			});
		});

		it("invokes close_panel_window", async () => {
			await reattachPanel("test-panel");

			expect(mockInvoke).toHaveBeenCalledWith("close_panel_window", {
				panelId: "test-panel",
			});
		});
	});
});
