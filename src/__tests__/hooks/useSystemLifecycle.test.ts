import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSystemLifecycle } from "../../hooks/useSystemLifecycle";
import { mockInvoke } from "../mocks/tauri";

const stores = vi.hoisted(() => ({ stopPolling: vi.fn(), clearBadge: vi.fn() }));
vi.mock("../../stores/github", () => ({ githubStore: { stopPolling: stores.stopPolling } }));
vi.mock("../../stores/notifications", () => ({ notificationsStore: { clearBadge: stores.clearBadge } }));
vi.mock("../../stores/settings", () => ({ settingsStore: { state: { preventSleepWhenBusy: true } } }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: { isAnyBusy: () => false } }));

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
	vi.clearAllMocks();
});

describe("useSystemLifecycle", () => {
	// Catches: remounting an idle WebView releases a backend background-work assertion.
	it("never changes native sleep ownership when an idle view mounts or unmounts", () => {
		dispose = render(() => {
			useSystemLifecycle();
			return null;
		}, document.createElement("div"));
		window.dispatchEvent(new Event("focus"));
		expect(stores.clearBadge).toHaveBeenCalledOnce();
		dispose();
		dispose = undefined;
		window.dispatchEvent(new Event("focus"));
		expect(stores.clearBadge).toHaveBeenCalledOnce();
		expect(stores.stopPolling).toHaveBeenCalledOnce();
		expect(
			mockInvoke.mock.calls.filter(([command]) => command === "block_sleep" || command === "unblock_sleep"),
		).toEqual([]);
	});
});
