import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../../../transport", () => ({ rpc: vi.fn() }));

import { UpstreamMcpPanel } from "../../../components/SettingsPanel/tabs/services/UpstreamMcpPanel";
import { rpc } from "../../../transport";

describe("UpstreamMcpPanel lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(rpc).mockImplementation((command: string) => {
			if (command === "load_mcp_upstreams") return Promise.resolve({ servers: [] });
			if (command === "get_mcp_upstream_status") return Promise.resolve({ upstreams: [] });
			return Promise.resolve(undefined);
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("owns the existing three-second status poll and clears it on unmount", async () => {
		const view = render(() => <UpstreamMcpPanel />);
		const statusCalls = () =>
			vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_mcp_upstream_status").length;

		expect(rpc).toHaveBeenCalledWith("load_mcp_upstreams");
		expect(statusCalls()).toBe(1);

		await vi.advanceTimersByTimeAsync(3000);
		expect(statusCalls()).toBe(2);

		view.unmount();
		await vi.advanceTimersByTimeAsync(6000);
		expect(statusCalls()).toBe(2);
	});

	// Remote MCP servers overwhelmingly speak OAuth; a pasted bearer token is the
	// fallback. Opening the add form on "Bearer token" made the common case a
	// two-step and hid the client-id/scopes fields behind a dropdown change.
	it("opens the add form on OAuth 2.1 and shows the OAuth fields, not the API-key field", async () => {
		const view = render(() => <UpstreamMcpPanel />);
		await vi.advanceTimersByTimeAsync(0);

		const toggle = view.getByTitle("Add upstream server");
		toggle.click();
		await vi.advanceTimersByTimeAsync(0);

		const authSelect = view.getByDisplayValue("OAuth 2.1") as HTMLSelectElement;
		expect(authSelect.value).toBe("oauth2");
		expect(view.queryByPlaceholderText("Client ID (leave blank to auto-register)")).not.toBeNull();
		expect(view.queryByPlaceholderText("API key for remote MCP servers (optional, stored in OS keychain)")).toBeNull();

		view.unmount();
	});

	// The Add/Cancel pair used to share the timeout row, which squeezed them and
	// clipped "Cancel"; they must sit on their own row like the edit form's Save/Cancel.
	it("renders Add and Cancel on a dedicated right-aligned row", async () => {
		const view = render(() => <UpstreamMcpPanel />);
		await vi.advanceTimersByTimeAsync(0);

		view.getByTitle("Add upstream server").click();
		await vi.advanceTimersByTimeAsync(0);

		const addBtn = view.getByText("Add");
		const cancelBtn = view.getByText("Cancel");
		expect(addBtn.parentElement).toBe(cancelBtn.parentElement);
		const row = addBtn.parentElement as HTMLElement;
		expect(row.style.justifyContent).toBe("flex-end");
		// The timeout input must NOT share the row any more.
		expect(row.querySelector('input[type="number"]')).toBeNull();

		view.unmount();
	});
});
