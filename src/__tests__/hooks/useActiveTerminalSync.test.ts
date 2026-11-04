import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { useActiveTerminalSync } from "../../hooks/useActiveTerminalSync";
import { activityStore } from "../../stores/activityStore";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

const flushEffects = () => Promise.resolve();

describe("useActiveTerminalSync", () => {
	let dispose: (() => void) | undefined;
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
		dismissItem = vi.spyOn(activityStore, "dismissItem").mockImplementation(() => {});
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
		dismissItem.mockRestore();
		repositoriesStore._testCancelPendingSave();
	});

	it("dismisses completion activity on activation", async () => {
		const id = addTerminal();
		await startSync();

		terminalsStore.setActive(id);

		expect(dismissItem).toHaveBeenCalledWith(`terminal-done-${id}`);
	});

	it("persists the last active terminal on its owning branch", async () => {
		const id = addTerminal();
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setWorkspace("/repo", "main", { worktreePath: "/repo" });
		repositoriesStore.addTerminalToWorkspace("/repo", "main", id);
		await startSync();

		terminalsStore.setActive(id);

		expect(repositoriesStore.state.repositories["/repo"].workspaces.main.lastActiveTerminal).toBe(id);
	});

	it("does not process the terminal that was active before registration", async () => {
		const id = addTerminal();
		terminalsStore.setActive(id);

		await startSync();

		expect(dismissItem).not.toHaveBeenCalled();
	});

	it("stops reacting after disposal", async () => {
		const id = addTerminal();
		await startSync();
		dispose?.();
		dispose = undefined;

		terminalsStore.setActive(id);

		expect(dismissItem).not.toHaveBeenCalled();
	});
});
