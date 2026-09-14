import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListen, mockInvoke, mockOpenFileAction } = vi.hoisted(() => ({
	mockListen: vi.fn(),
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	mockOpenFileAction: vi.fn(),
}));

vi.mock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));
vi.mock("../../transport", () => ({ isTauri: () => true, rpc: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../utils/filePreview", () => ({ openFileAction: mockOpenFileAction }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { useFileOpenBridge } from "../../hooks/useFileOpenBridge";
import { useTerminalReattachBridge } from "../../hooks/useTerminalReattachBridge";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

type EventHandler = (event: { payload: unknown }) => void;

describe("native event bridges", () => {
	let dispose: (() => void) | undefined;
	let handlers: Map<string, EventHandler>;
	const unlisteners: Array<ReturnType<typeof vi.fn>> = [];

	beforeEach(() => {
		vi.useFakeTimers();
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		handlers = new Map();
		unlisteners.length = 0;
		mockOpenFileAction.mockReset();
		repositoriesStore._testSetHydrated(true);
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		mockListen.mockReset().mockImplementation((event: string, handler: EventHandler) => {
			handlers.set(event, handler);
			const unlisten = vi.fn();
			unlisteners.push(unlisten);
			return Promise.resolve(unlisten);
		});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		repositoriesStore._testCancelPendingSave();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("relativizes against the worktree of the branch that owns the file", async () => {
		repositoriesStore.add({ path: "/repo", displayName: "repo" });
		repositoriesStore.setBranch("/repo", "feature", { worktreePath: "/repo-worktree" });
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useFileOpenBridge();
		});
		await Promise.resolve();

		handlers.get("file-open")?.({
			payload: ["/repo-worktree/src/main.ts", "/outside/readme.md"],
		});

		expect(mockOpenFileAction).toHaveBeenNthCalledWith(1, "src/main.ts", "/repo", "/repo-worktree");
		expect(mockOpenFileAction).toHaveBeenNthCalledWith(2, "/outside/readme.md", "", undefined);
	});

	it("uses the repository root when the file is owned at the root", async () => {
		repositoriesStore.add({ path: "/repo", displayName: "repo" });
		repositoriesStore.setBranch("/repo", "main", { worktreePath: "/repo" });
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useFileOpenBridge();
		});
		await Promise.resolve();

		handlers.get("file-open")?.({ payload: ["/repo/docs/guide.md"] });

		expect(mockOpenFileAction).toHaveBeenCalledWith("docs/guide.md", "/repo", "/repo");
	});

	it("scopes to the repo that owns the file, not the repo in focus", async () => {
		// The user is on /repo; the double-clicked file lives in /other. It used to
		// open as an absolute, unscoped tab visible under every repo.
		repositoriesStore.add({ path: "/repo", displayName: "repo" });
		repositoriesStore.add({ path: "/other", displayName: "other" });
		repositoriesStore.setActive("/repo");
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useFileOpenBridge();
		});
		await Promise.resolve();

		handlers.get("file-open")?.({ payload: ["/other/docs/guide.md"] });

		expect(mockOpenFileAction).toHaveBeenCalledWith("docs/guide.md", "/other", "/other");
	});

	it("reattaches detached terminals and refreshes their renderer", async () => {
		const refresh = vi.fn();
		const fit = vi.fn();
		terminalsStore.register("tab-1", {
			sessionId: "session-1",
			fontSize: 14,
			name: "Terminal",
			cwd: null,
			awaitingInput: null,
		});
		terminalsStore.update("tab-1", { ref: { refresh, fit } as never });
		terminalsStore.detach("tab-1", "floating-tab-1");
		const reattach = vi.fn(() => terminalsStore.reattach("tab-1"));
		const setStatusInfo = vi.fn();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useTerminalReattachBridge({ reattach, setStatusInfo });
		});
		await Promise.resolve();

		handlers.get("reattach-terminal")?.({ payload: { tabId: "tab-1", sessionId: "session-1" } });

		expect(reattach).toHaveBeenCalledWith("tab-1");
		expect(setStatusInfo).toHaveBeenCalledWith("Tab reattached");
		expect(refresh).not.toHaveBeenCalled();
		vi.advanceTimersByTime(150);
		expect(refresh).toHaveBeenCalledOnce();
		expect(fit).toHaveBeenCalledOnce();
	});

	it("ignores reattach events for attached terminals", async () => {
		terminalsStore.register("tab-1", {
			sessionId: "session-1",
			fontSize: 14,
			name: "Terminal",
			cwd: null,
			awaitingInput: null,
		});
		const reattach = vi.fn();
		const setStatusInfo = vi.fn();
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useTerminalReattachBridge({ reattach, setStatusInfo });
		});
		await Promise.resolve();

		handlers.get("reattach-terminal")?.({ payload: { tabId: "tab-1", sessionId: "session-1" } });

		expect(reattach).not.toHaveBeenCalled();
		expect(setStatusInfo).not.toHaveBeenCalled();
	});

	it("cleans up both listeners", async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useFileOpenBridge();
			useTerminalReattachBridge({ reattach: vi.fn(), setStatusInfo: vi.fn() });
		});
		await Promise.resolve();

		dispose?.();
		dispose = undefined;

		expect(unlisteners).toHaveLength(2);
		expect(unlisteners.every((unlisten) => unlisten.mock.calls.length === 1)).toBe(true);
	});
});
