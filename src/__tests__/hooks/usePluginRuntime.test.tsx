import { render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { usePluginRuntime } from "../../hooks/usePluginRuntime";
import { pluginRegistry } from "../../plugins/pluginRegistry";
import type { PluginHost, StateChangeEvent } from "../../plugins/types";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

vi.mock("../../plugins", () => ({ initPlugins: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(() => {}),
}));

afterEach(async () => {
	await pluginRegistry.clear();
	repositoriesStore._testCancelPendingSave();
	terminalsStore._testCancelPendingTimers();
});

it("runtime delivers branch shell and awaiting transitions", () => {
	const path = "/plugin-runtime";
	repositoriesStore.add({ path, displayName: "Runtime" });
	repositoriesStore.setWorkspace(path, "main", { branchName: "main" });
	repositoriesStore.setActiveWorkspace(path, "main");
	repositoriesStore.setActive(path);
	const terminalId = terminalsStore.add({
		sessionId: "runtime-session",
		name: "Runtime",
		cwd: path,
		fontSize: 14,
		awaitingInput: null,
	});
	let host!: PluginHost;
	pluginRegistry.register({
		id: "observer",
		onload(api) {
			host = api;
		},
		onunload() {},
	});
	const events: StateChangeEvent[] = [];
	host.onStateChange((event) => events.push(event));
	const { unmount } = render(() => {
		usePluginRuntime();
		return null;
	});

	repositoriesStore.setWorkspace(path, "main", { branchName: "renamed" });
	terminalsStore.update(terminalId, { shellState: "busy" });
	terminalsStore.update(terminalId, { awaitingInput: "question" });

	expect(events).toEqual([
		{ type: "branch-changed", sessionId: null, terminalId: "", detail: "renamed" },
		{ type: "shell-state-changed", sessionId: "runtime-session", terminalId, detail: "busy" },
		{ type: "awaiting-input-changed", sessionId: "runtime-session", terminalId, detail: "question" },
	]);
	events.length = 0;
	terminalsStore.update(terminalId, { shellState: "busy", name: "Renamed" });
	expect(events).toEqual([]);
	terminalsStore.update(terminalId, { awaitingInput: null, shellState: "idle" });
	expect(events.map((event) => event.type)).toEqual(["shell-state-changed", "awaiting-input-changed"]);
	expect(events[1].detail).toBeUndefined();
	unmount();
	events.length = 0;
	terminalsStore.update(terminalId, { shellState: "busy" });
	expect(events).toEqual([]);
	terminalsStore.remove(terminalId);
	repositoriesStore.remove(path);
});

it("session teardown does not swallow the exited shell-state transition", () => {
	const terminalId = terminalsStore.add({
		sessionId: "exiting-session",
		name: "Exiting",
		cwd: "/plugin-runtime-exit",
		fontSize: 14,
		awaitingInput: null,
	});
	terminalsStore.update(terminalId, { shellState: "busy" });
	const events: StateChangeEvent[] = [];
	pluginRegistry.register({
		id: "exit-observer",
		onload(host) {
			host.onStateChange((event) => events.push(event));
		},
		onunload() {},
	});
	const { unmount } = render(() => {
		usePluginRuntime();
		return null;
	});
	// Terminal.tsx clears the session and marks an agent terminal exited together.
	terminalsStore.update(terminalId, { sessionId: null, shellState: "exited" });
	expect(events.filter((event) => event.type === "shell-state-changed")).toEqual([
		{ type: "shell-state-changed", sessionId: "exiting-session", terminalId, detail: "exited" },
	]);
	events.length = 0;
	terminalsStore.update(terminalId, { sessionId: null, shellState: "exited" });
	expect(events).toEqual([]);
	// A new session is an initial snapshot, not a change in the exited session.
	terminalsStore.update(terminalId, { sessionId: "replacement-session", shellState: "idle" });
	expect(events).toEqual([]);
	terminalsStore.update(terminalId, { shellState: "busy", awaitingInput: "question" });
	expect(events).toEqual([
		{ type: "shell-state-changed", sessionId: "replacement-session", terminalId, detail: "busy" },
		{ type: "awaiting-input-changed", sessionId: "replacement-session", terminalId, detail: "question" },
	]);
	events.length = 0;
	terminalsStore.update(terminalId, { sessionId: null, shellState: "exited", awaitingInput: null });
	expect(events).toEqual([
		{ type: "shell-state-changed", sessionId: "replacement-session", terminalId, detail: "exited" },
		{ type: "awaiting-input-changed", sessionId: "replacement-session", terminalId, detail: undefined },
	]);
	events.length = 0;
	terminalsStore.update(terminalId, { sessionId: "second-session", shellState: "idle" });
	terminalsStore.update(terminalId, { sessionId: "third-session", shellState: "busy", awaitingInput: "question" });
	expect(events).toEqual([]);
	unmount();
	terminalsStore.remove(terminalId);
});
