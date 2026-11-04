import { render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSession, resize, mockRpc } = vi.hoisted(() => ({
	createSession: vi.fn().mockResolvedValue("fresh-session"),
	resize: vi.fn().mockResolvedValue(undefined),
	mockRpc: vi.fn(),
}));

vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ createSession, resize, close: vi.fn(), getKittyFlags: vi.fn().mockResolvedValue(0) }),
}));
vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: (...args: unknown[]) => mockRpc(...args),
}));
vi.mock("../../stores/agentConfigs", () => ({
	ensureAgentConfigsForRepo: vi.fn().mockResolvedValue({ getEnvFlags: () => ({}) }),
	agentConfigsForRepo: () => ({ getEnvFlags: () => ({}) }),
}));
vi.mock("../../components/Terminal/glyphCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/glyphCache")>()),
	getSharedMetrics: () => ({ cellWidth: 8, cellHeight: 16 }),
}));
vi.mock("../../components/Terminal/CanvasTerminal", () => ({
	default: () => <div data-testid="canvas" />,
}));

import { Terminal } from "../../components/Terminal/Terminal";
import { terminalsStore } from "../../stores/terminals";
import { suspendTerminal } from "../../utils/suspendTerminal";

/** Mount a Terminal that is attached to an already live PTY ("live-session"). */
function openLiveTab() {
	const id = terminalsStore.add({
		sessionId: "live-session",
		cwd: "/Gits/alpha",
		repoPath: "/Gits/alpha",
		name: "shell",
		fontSize: 13,
		awaitingInput: null,
	});
	const oldRaf = globalThis.requestAnimationFrame;
	const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
	const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 800 });
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
	globalThis.requestAnimationFrame = (cb) => {
		cb(0);
		return 1;
	};
	try {
		const view = render(() => <Terminal id={id} cwd="/Gits/alpha" alwaysVisible />);
		return { ...view, id };
	} finally {
		globalThis.requestAnimationFrame = oldRaf;
		if (width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", width);
		if (height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", height);
	}
}

describe("Terminal under Suspend (critic 1358)", () => {
	beforeEach(() => {
		createSession.mockClear().mockResolvedValue("fresh-session");
		resize.mockClear().mockResolvedValue(undefined);
		mockRpc.mockReset().mockResolvedValue(undefined);
	});

	// Catches: close_pty fails, the flag reverts, and the Terminal effect opens a SECOND PTY
	// while the first one is still alive and still owned by the store (orphaned process group).
	it("does not open a second PTY when closing the first one failed", async () => {
		const { id } = openLiveTab();
		await waitFor(() => expect(resize).toHaveBeenCalledWith("live-session", expect.any(Number), expect.any(Number)));
		mockRpc.mockRejectedValueOnce(new Error("close failed"));

		const outcome = await suspendTerminal(id);

		expect(outcome.ok).toBe(false);
		await new Promise((r) => setTimeout(r, 20));
		expect(createSession).not.toHaveBeenCalled();
		expect(terminalsStore.get(id)?.sessionId).toBe("live-session");
	});
});
