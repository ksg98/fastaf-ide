import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers: Record<string, (payload: unknown) => void> = {};

vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => undefined),
	subscribeEvents: vi.fn(async (h: Record<string, (payload: unknown) => void>) => {
		Object.assign(handlers, h);
		return () => {};
	}),
}));

import { McpConfirmHost } from "../../components/McpConfirmHost/McpConfirmHost";
import { __resetMcpConfirmQueue } from "../../stores/mcpConfirm";
import { rpc } from "../../transport";

const mockRpc = vi.mocked(rpc);

afterEach(cleanup);

function emitRequest(id = "r1") {
	handlers["mcp-confirm"]({ request_id: id, title: "Force push?", message: "to main" });
}

describe("McpConfirmHost", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		__resetMcpConfirmQueue();
	});

	it("renders nothing until an agent asks", () => {
		const { container } = render(() => <McpConfirmHost />);
		expect(container.textContent).toBe("");
	});

	it("shows the agent's question", async () => {
		render(() => <McpConfirmHost />);
		emitRequest();
		expect(await screen.findByText("Force push?")).toBeTruthy();
		expect(await screen.findByText("to main")).toBeTruthy();
	});

	it("sends confirm when the human approves", async () => {
		render(() => <McpConfirmHost />);
		emitRequest();
		(await screen.findByText("Confirm")).click();
		expect(mockRpc).toHaveBeenCalledWith("mcp_confirm_response", { requestId: "r1", confirmed: true });
	});

	it("sends a refusal when the human cancels", async () => {
		render(() => <McpConfirmHost />);
		emitRequest();
		(await screen.findByText("Cancel")).click();
		expect(mockRpc).toHaveBeenCalledWith("mcp_confirm_response", { requestId: "r1", confirmed: false });
	});

	it("lets Enter fall to Cancel, never to the destructive action", async () => {
		// The agent asks before something destructive. An accidental Enter must
		// take the safe path, so the default button is Cancel.
		render(() => <McpConfirmHost />);
		emitRequest();
		await screen.findByText("Force push?");
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(mockRpc).toHaveBeenCalledWith("mcp_confirm_response", { requestId: "r1", confirmed: false });
	});
});
