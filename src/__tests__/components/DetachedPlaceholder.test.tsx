import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

vi.mock("../../transport", () => ({
	isTauri: () => true,
}));

describe("DetachedPlaceholder", () => {
	let DetachedPlaceholder: typeof import("../../components/DetachedPlaceholder").DetachedPlaceholder;
	let uiStore: typeof import("../../stores/ui").uiStore;

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);

		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: mockInvoke,
		}));
		vi.doMock("../../transport", () => ({
			isTauri: () => true,
		}));

		const uiMod = await import("../../stores/ui");
		uiStore = uiMod.uiStore;

		const mod = await import("../../components/DetachedPlaceholder");
		DetachedPlaceholder = mod.DetachedPlaceholder;
	});

	it("renders panel name in message", () => {
		const { getByText } = render(() => <DetachedPlaceholder panel="Activity Dashboard" panelId="activity" />);
		expect(getByText("Activity Dashboard is in a separate window")).toBeTruthy();
	});

	it("bring back button calls close_panel_window", async () => {
		const { getByText } = render(() => <DetachedPlaceholder panel="AI Chat" panelId="ai-chat" />);
		await fireEvent.click(getByText("Bring back"));
		expect(mockInvoke).toHaveBeenCalledWith("close_panel_window", { panelId: "ai-chat" });
	});

	it("bring back button clears detached state", async () => {
		uiStore.setDetached("ai-chat", "panel-ai-chat");
		expect(uiStore.isDetached("ai-chat")).toBe(true);

		const { getByText } = render(() => <DetachedPlaceholder panel="AI Chat" panelId="ai-chat" />);
		await fireEvent.click(getByText("Bring back"));
		expect(uiStore.isDetached("ai-chat")).toBe(false);
	});
});
