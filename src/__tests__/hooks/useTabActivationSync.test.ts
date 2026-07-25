import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { useTabActivationSync } from "../../hooks/useTabActivationSync";
import { diffTabsStore } from "../../stores/diffTabs";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { terminalsStore } from "../../stores/terminals";

const flushEffects = () => Promise.resolve();

describe("useTabActivationSync", () => {
	let dispose: (() => void) | undefined;
	const addTerminal = () =>
		terminalsStore.add({
			sessionId: null,
			fontSize: 14,
			name: "Test terminal",
			cwd: null,
			awaitingInput: null,
		});

	const startSync = async () => {
		createRoot((rootDispose) => {
			dispose = rootDispose;
			useTabActivationSync();
		});
		await flushEffects();
	};

	beforeEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		mdTabsStore.clearAll();
		diffTabsStore.clearAll();
		editorTabsStore.clearAll();
	});

	afterEach(() => {
		dispose?.();
		dispose = undefined;
	});

	it("deactivates every competing store when a Markdown tab becomes active", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		diffTabsStore.setActive("diff-1");
		editorTabsStore.setActive("edit-1");
		await startSync();

		mdTabsStore.setActive("md-1");

		expect(mdTabsStore.state.activeId).toBe("md-1");
		expect(terminalsStore.state.activeId).toBeNull();
		expect(diffTabsStore.state.activeId).toBeNull();
		expect(editorTabsStore.state.activeId).toBeNull();
	});

	it("deactivates every competing store when a diff tab becomes active", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		mdTabsStore.setActive("md-1");
		editorTabsStore.setActive("edit-1");
		await startSync();

		diffTabsStore.setActive("diff-1");

		expect(diffTabsStore.state.activeId).toBe("diff-1");
		expect(terminalsStore.state.activeId).toBeNull();
		expect(mdTabsStore.state.activeId).toBeNull();
		expect(editorTabsStore.state.activeId).toBeNull();
	});

	it("deactivates every competing store when an editor tab becomes active", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		mdTabsStore.setActive("md-1");
		diffTabsStore.setActive("diff-1");
		await startSync();

		editorTabsStore.setActive("edit-1");

		expect(editorTabsStore.state.activeId).toBe("edit-1");
		expect(terminalsStore.state.activeId).toBeNull();
		expect(mdTabsStore.state.activeId).toBeNull();
		expect(diffTabsStore.state.activeId).toBeNull();
	});

	it("deactivates every competing store when a terminal becomes active", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(null);
		mdTabsStore.setActive("md-1");
		diffTabsStore.setActive("diff-1");
		editorTabsStore.setActive("edit-1");
		await startSync();

		terminalsStore.setActive(terminalId);

		expect(terminalsStore.state.activeId).toBe(terminalId);
		expect(mdTabsStore.state.activeId).toBeNull();
		expect(diffTabsStore.state.activeId).toBeNull();
		expect(editorTabsStore.state.activeId).toBeNull();
	});

	it("does not normalize existing active stores during registration", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		mdTabsStore.setActive("md-1");
		diffTabsStore.setActive("diff-1");
		editorTabsStore.setActive("edit-1");

		await startSync();

		expect(terminalsStore.state.activeId).toBe(terminalId);
		expect(mdTabsStore.state.activeId).toBe("md-1");
		expect(diffTabsStore.state.activeId).toBe("diff-1");
		expect(editorTabsStore.state.activeId).toBe("edit-1");
	});

	it("does not deactivate another store when an active id is cleared", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		mdTabsStore.setActive("md-1");
		await startSync();

		mdTabsStore.setActive(null);

		expect(terminalsStore.state.activeId).toBe(terminalId);
	});

	it("stops synchronizing after its owner is disposed", async () => {
		const terminalId = addTerminal();
		terminalsStore.setActive(terminalId);
		await startSync();
		dispose?.();
		dispose = undefined;

		mdTabsStore.setActive("md-1");

		expect(terminalsStore.state.activeId).toBe(terminalId);
	});
});
