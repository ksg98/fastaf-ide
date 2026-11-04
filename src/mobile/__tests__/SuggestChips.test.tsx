import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { setToastBellMirrorResolver, toastsStore } from "../../stores/toasts";
import { AGENT_ENTER_GAP_MS } from "../../utils/sendCommand";
import { MobileToastContainer } from "../components/MobileToastContainer";
import { SuggestChips } from "../components/SuggestChips";

vi.mock("../../transport", () => ({
	rpc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));

import { rpc } from "../../transport";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	vi.mocked(rpc).mockReset().mockResolvedValue(undefined);
	for (const toast of toastsStore.toasts) toastsStore.remove(toast.id);
	setToastBellMirrorResolver(() => true);
	vi.useRealTimers();
});

describe("SuggestChips", () => {
	it("renders a chip for each item", () => {
		const { container } = render(() => <SuggestChips sessionId="s1" items={["Run tests", "Review diff", "Deploy"]} />);
		const buttons = container.querySelectorAll("button");
		expect(buttons.length).toBe(3);
		expect(buttons[0].textContent).toBe("Run tests");
		expect(buttons[1].textContent).toBe("Review diff");
		expect(buttons[2].textContent).toBe("Deploy");
	});

	it("sends command via sendCommand (Ctrl-U+text then Enter) on click", async () => {
		// agentType forces the Ctrl-U-prefix branch regardless of host platform
		// detection in the test environment (sendCommand skips Ctrl-U on native
		// Windows shells only when no agent is detected).
		const { container } = render(() => <SuggestChips sessionId="s1" items={["Run tests"]} agentType="claude" />);
		const button = container.querySelector("button")!;
		await fireEvent.click(button);
		// Wait past two AGENT_ENTER_GAP_MS: with an agent attached sendCommand
		// separates Ctrl-U from the text, and the text from the Enter, by a real
		// elapsed gap each so the PTY cannot coalesce them into one read().
		await new Promise((r) => setTimeout(r, 2 * AGENT_ENTER_GAP_MS + 20));
		expect(rpc).toHaveBeenCalledTimes(3);
		expect(rpc).toHaveBeenNthCalledWith(1, "write_pty", { sessionId: "s1", data: "\x15" });
		expect(rpc).toHaveBeenNthCalledWith(2, "write_pty", { sessionId: "s1", data: "Run tests" });
		expect(rpc).toHaveBeenNthCalledWith(3, "write_pty", { sessionId: "s1", data: "\r" });
	});

	it("renders nothing when items is empty", () => {
		const { container } = render(() => <SuggestChips sessionId="s1" items={[]} />);
		const buttons = container.querySelectorAll("button");
		expect(buttons.length).toBe(0);
	});
});

// The mobile boundary receives a fresh items array on every session snapshot.
// Catches: sending a choice without consuming the rendered list, or restoring it
// from an unchanged poll before the shared submitted-line clear reaches the UI.
it("consumes a picked list across stale polls and accepts a later suggestion", async () => {
	const [items, setItems] = createSignal(["Run tests", "Review diff"]);
	const view = render(() => <SuggestChips sessionId="s1" items={items()} agentType="claude" />);
	await fireEvent.click(view.getByRole("button", { name: "Run tests" }));
	try {
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setItems(["Run tests", "Review diff"]);
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setItems(["Inspect results", "Commit changes"]);
		expect(view.getByRole("button", { name: "Inspect results" })).toBeTruthy();
	} finally {
		await new Promise((r) => setTimeout(r, 2 * AGENT_ENTER_GAP_MS + 20));
	}
});

// Catches: permanently suppressing identical choices after the shared backend
// submission clear removes the previous list and the next turn emits it again.
it("shows identical suggestions after the backend clears the picked list", async () => {
	const [items, setItems] = createSignal(["Run tests", "Review diff"]);
	const view = render(() => <SuggestChips sessionId="s1" items={items()} agentType="claude" />);
	await fireEvent.click(view.getByRole("button", { name: "Run tests" }));
	try {
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setItems([]);
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setItems(["Run tests", "Review diff"]);
		expect(view.getByRole("button", { name: "Run tests" })).toBeTruthy();
	} finally {
		await new Promise((r) => setTimeout(r, 2 * AGENT_ENTER_GAP_MS + 20));
	}
});

// Catches: a consumed list in one session hiding the same choices in another.
it("does not carry a picked list into a different session", async () => {
	const [sessionId, setSessionId] = createSignal("s1");
	const view = render(() => <SuggestChips sessionId={sessionId()} items={["Run tests"]} agentType="claude" />);
	await fireEvent.click(view.getByRole("button", { name: "Run tests" }));
	setSessionId("s2");
	try {
		expect(view.getByRole("button", { name: "Run tests" })).toBeTruthy();
	} finally {
		await new Promise((r) => setTimeout(r, 2 * AGENT_ENTER_GAP_MS + 20));
	}
	expect(rpc).toHaveBeenLastCalledWith("write_pty", { sessionId: "s1", data: "\r" });
});

// F1 catches: unrelated semantic activity or an older snapshot reviving the
// selected list before the pending first write and its retries have finished.
it("keeps a picked list consumed when activity snapshots change during submission", async () => {
	let releaseWrite!: () => void;
	const pendingWrite = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	vi.mocked(rpc).mockImplementationOnce(() => pendingWrite);
	const [snapshot, setSnapshot] = createSignal({ items: ["Run tests", "Review diff"], updatedAt: 100 });
	const view = render(() => <SuggestChips sessionId="s1" agentType="claude" {...snapshot()} />);
	await fireEvent.click(view.getByRole("button", { name: "Run tests" }));
	try {
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setSnapshot({ items: ["Run tests", "Review diff"], updatedAt: 101 });
		expect(view.queryAllByRole("button")).toHaveLength(0);
		setSnapshot({ items: ["Run tests", "Review diff"], updatedAt: 99 });
		expect(view.queryAllByRole("button")).toHaveLength(0);
	} finally {
		releaseWrite();
		await new Promise((resolve) => setTimeout(resolve, 2 * AGENT_ENTER_GAP_MS + 20));
	}
});

// F2 catches: exhausted Ctrl-U retries hiding the list without showing that
// neither the prompt nor Enter reached the session.
it("shows a mobile send failure after the first write exhausts retries", async () => {
	// This boundary asserts the real transient card, not desktop bell persistence.
	setToastBellMirrorResolver(() => false);
	vi.useFakeTimers();
	vi.mocked(rpc).mockRejectedValue(new Error("offline"));
	const view = render(() => (
		<>
			<SuggestChips sessionId="s1" items={["Run tests", "Review diff"]} agentType="claude" />
			<MobileToastContainer />
		</>
	));
	await fireEvent.click(view.getByRole("button", { name: "Run tests" }));
	await vi.runAllTimersAsync();
	expect(rpc).toHaveBeenCalledTimes(3);
	for (const call of vi.mocked(rpc).mock.calls) {
		expect(call).toEqual(["write_pty", { sessionId: "s1", data: "\x15" }]);
	}
	expect(appLogger.warn).toHaveBeenCalledWith("network", "Failed to send suggest action: offline");
	expect(view.getByText("Send failed")).toBeTruthy();
	expect(view.getByText("Could not send command: offline")).toBeTruthy();
});
