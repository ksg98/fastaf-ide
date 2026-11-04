import { beforeEach, describe, expect, it, vi } from "vitest";

const { request, send, nativeInvoke } = vi.hoisted(() => ({ request: vi.fn(), send: vi.fn(), nativeInvoke: vi.fn() }));

vi.mock("@tauri-apps/plugin-notification", () => ({ requestPermission: request, sendNotification: send }));
vi.mock("../transport", () => ({ isTauri: () => true }));
vi.mock("../invoke", () => ({ invoke: nativeInvoke }));
vi.mock("../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));

const target = { kind: "terminal", id: "t1" } as const;

describe("showNativeNotice ignoreFocus — critic round 2", () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		request.mockResolvedValue("granted");
		nativeInvoke.mockResolvedValue(undefined);
	});

	it("ignoreFocus sends while focused, and the next ordinary notice is still blocked while focused", async () => {
		// Catches: ignoreFocus stored in module state, turning off the focus gate for every later notice.
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const { showNativeNotice } = await import("../services/nativeNotifications");
		await showNativeNotice({ title: "q", body: "b", key: "reminder:question:t1", target, ignoreFocus: true });
		expect(send).toHaveBeenCalledTimes(1);
		await showNativeNotice({ title: "q", body: "b", key: "question:t1", target });
		expect(send).toHaveBeenCalledTimes(1);
	});

	it("isCurrent false after the permission await drops an ignoreFocus notice", async () => {
		// Catches: ignoreFocus skipping the isCurrent re-check, so a banner for a tab the user just opened is sent.
		vi.spyOn(document, "hasFocus").mockReturnValue(true);
		const { showNativeNotice } = await import("../services/nativeNotifications");
		await showNativeNotice({
			title: "q",
			body: "b",
			key: "reminder:question:t1",
			target,
			ignoreFocus: true,
			isCurrent: () => false,
		});
		expect(send).not.toHaveBeenCalled();
	});
});
