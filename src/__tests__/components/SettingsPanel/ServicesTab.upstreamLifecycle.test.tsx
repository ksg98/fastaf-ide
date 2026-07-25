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
});
