import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { useActiveTerminalSync } from "../../hooks/useActiveTerminalSync";
import { activityStore } from "../../stores/activityStore";
import { conversationStore } from "../../stores/conversationStore";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

const flushEffects = () => Promise.resolve();

describe("useActiveTerminalSync", () => {
	let dispose: (() => void) | undefined;
	let setActiveTerminal: ReturnType<typeof vi.spyOn>;
	let initFromDisk: ReturnType<typeof vi.spyOn>;
	let onTerminalClose: ReturnType<typeof vi.spyOn>;
	let dismissItem: ReturnType<typeof vi.spyOn>;

	const addTerminal = (tuicSession: string | null = "agent-session") =>
		terminalsStore.add({
			sessionId: null,
			fontSize: 14,
			name: "Test terminal",
			cwd: "/repo",
			awaitingInput: null,
			tuicSession,
		});

	const startSync = async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useActiveTerminalSync();
		});
		await flushEffects();
	};

	beforeEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		repositoriesStore._testCancelPendingSave();
		setActiveTerminal = vi.spyOn(conversationStore, "setActiveTerminal").mockImplementation(() => {});
		initFromDisk = vi.spyOn(conversationStore, "initFromDisk").mockResolvedValue(undefined);
		onTerminalClose = vi.spyOn(conversationStore, "onTerminalClose").mockResolvedValue(undefined);
		dismissItem = vi.spyOn(activityStore, "dismissItem").mockImplementation(() => {});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		setActiveTerminal.mockRestore();
		initFromDisk.mockRestore();
		onTerminalClose.mockRestore();
		dismissItem.mockRestore();
		repositoriesStore._testCancelPendingSave();
	});

	it("switches conversation context and dismisses completion activity on activation", async () => {
		const id = addTerminal();
		await startSync();

		terminalsStore.setActive(id);

		expect(setActiveTerminal).toHaveBeenCalledWith("agent-session");
		expect(initFromDisk).toHaveBeenCalledWith("agent-session");
		expect(dismissItem).toHaveBeenCalledWith(`terminal-done-${id}`);
	});

	it("falls back to the terminal id when no TUIC session exists", async () => {
		const id = addTerminal(null);
		await startSync();

		terminalsStore.setActive(id);

		expect(setActiveTerminal).toHaveBeenCalledWith(id);
		expect(initFromDisk).toHaveBeenCalledWith(undefined);
	});

	it("cleans up the matching conversation before a terminal is removed", async () => {
		const id = addTerminal();
		await startSync();

		terminalsStore.remove(id);

		expect(onTerminalClose).toHaveBeenCalledWith("agent-session");
	});

	it("persists the last active terminal on its owning branch", async () => {
		const id = addTerminal();
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setBranch("/repo", "main", { worktreePath: "/repo" });
		repositoriesStore.addTerminalToBranch("/repo", "main", id);
		await startSync();

		terminalsStore.setActive(id);

		expect(repositoriesStore.state.repositories["/repo"].branches.main.lastActiveTerminal).toBe(id);
	});

	it("does not process the terminal that was active before registration", async () => {
		const id = addTerminal();
		terminalsStore.setActive(id);

		await startSync();

		expect(setActiveTerminal).not.toHaveBeenCalled();
		expect(initFromDisk).not.toHaveBeenCalled();
		expect(dismissItem).not.toHaveBeenCalled();
	});

	it("stops reacting and unregisters removal cleanup after disposal", async () => {
		const id = addTerminal();
		await startSync();
		dispose?.();
		dispose = undefined;

		terminalsStore.setActive(id);
		terminalsStore.remove(id);

		expect(setActiveTerminal).not.toHaveBeenCalled();
		expect(onTerminalClose).not.toHaveBeenCalled();
	});
});
