// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { subscribeEvents } from "../../transport";
import MobileApp from "../MobileApp";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../transport", () => ({
	isTauri: () => false,
	rpc,
	subscribeEvents: vi.fn(async () => () => {}),
}));
vi.mock("../../invoke", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../../stores/ideas", () => ({ ideasStore: { hydrate: vi.fn() } }));
vi.mock("../mobileTheme", () => ({ loadMobileTheme: vi.fn(async () => "commander") }));
vi.mock("../useMobileNotifications", () => ({ useMobileNotifications: vi.fn() }));
vi.mock("../useVersionCheck", () => ({
	useVersionCheck: () => ({ updateAvailable: () => false, applyUpdate: vi.fn() }),
}));
vi.mock("../../components/McpConfirmHost/McpConfirmHost", () => ({ McpConfirmHost: () => <div /> }));
vi.mock("../screens/MobileChatScreen", () => ({ MobileChatScreen: () => <div>Chat conversation</div> }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
beforeEach(() => {
	rpc.mockReset();
	vi.mocked(subscribeEvents).mockClear();
	history.replaceState(null, "", "/mobile");
});
afterEach(() => {
	cleanup();
	history.replaceState(null, "", "/mobile");
});

// Catches: the static mobile tab list offers an unusable Chat without a configured ego.
it("omits AI Chat when ego is not configured", async () => {
	rpc.mockImplementation(async (command: string) => (command === "load_config" ? { ego_executable: "  " } : []));
	history.replaceState(null, "", "/mobile?session=saved-chat");
	const view = render(() => <MobileApp />);
	await waitFor(() => expect(view.getByText("No active sessions")).toBeTruthy());
	expect(view.queryByRole("button", { name: /^Chat$/ })).toBeNull();
	expect(view.getByRole("button", { name: /^Sessions$/ }).getAttribute("aria-current")).toBe("page");
});

// Catches: settings changes leave an unusable active conversation mounted until page reload.
it("shows Chat after configuration and returns to Sessions when ego is removed", async () => {
	let executable = "";
	rpc.mockImplementation(async (command: string) => (command === "load_config" ? { ego_executable: executable } : []));
	const view = render(() => <MobileApp />);
	await waitFor(() => expect(rpc).toHaveBeenCalledWith("load_config"));
	const handlers = vi.mocked(subscribeEvents).mock.calls[0][0];
	executable = "/tools/ego";
	handlers["settings-changed"]({ section: "app" });
	fireEvent.click(await waitFor(() => view.getByRole("button", { name: /^Chat$/ })));
	await waitFor(() => expect(view.getByText("Chat conversation")).toBeTruthy());
	executable = "";
	handlers["settings-changed"]({ section: "app" });
	await waitFor(() => expect(view.queryByRole("button", { name: /^Chat$/ })).toBeNull());
	expect(view.queryByText("Chat conversation")).toBeNull();
	expect(view.getByRole("button", { name: /^Sessions$/ }).getAttribute("aria-current")).toBe("page");
});

// Catches: a disconnected settings stream misses removal of ego while session polling still works.
it("refreshes availability when the shared event stream resynchronizes", async () => {
	let executable = "/tools/ego";
	rpc.mockImplementation(async (command: string) => (command === "load_config" ? { ego_executable: executable } : []));
	const view = render(() => <MobileApp />);
	await waitFor(() => expect(view.getByRole("button", { name: /^Chat$/ })).toBeTruthy());
	executable = "";
	vi.mocked(subscribeEvents).mock.calls[0][1]?.onResync?.("reconnect");
	await waitFor(() => expect(view.queryByRole("button", { name: /^Chat$/ })).toBeNull());
});

// Catches: an older configuration response re-enables Chat after a newer removal.
it("ignores stale configuration reads and fails closed when the host cannot report availability", async () => {
	let finishOld!: (value: { ego_executable: string }) => void;
	const old = new Promise<{ ego_executable: string }>((resolve) => {
		finishOld = resolve;
	});
	rpc.mockImplementation((command: string) => (command === "load_config" ? old : Promise.resolve([])));
	const view = render(() => <MobileApp />);
	const handlers = vi.mocked(subscribeEvents).mock.calls[0][0];
	rpc.mockImplementation(async (command: string) => {
		if (command === "load_config") throw new Error("host unavailable");
		return [];
	});
	handlers["settings-changed"]({ section: "app" });
	await Promise.resolve();
	finishOld({ ego_executable: "/tools/ego" });
	await old;
	await waitFor(() => expect(view.getByText("No active sessions")).toBeTruthy());
	expect(view.queryByRole("button", { name: /^Chat$/ })).toBeNull();
});
