import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
	recordFocus: vi.fn(),
	recordTerminalRepo: vi.fn(),
	getLastGlobal: vi.fn(),
	getForRepo: vi.fn(),
	isRepoScoped: vi.fn((target: { kind: string }) => target.kind.startsWith("git-")),
}));
const repositories = vi.hoisted(() => ({
	state: { activeRepoPath: null as string | null },
	getRepoPathForTerminal: vi.fn(),
	get: vi.fn(),
}));
const terminals = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../stores/focusRegistry", () => registry);
vi.mock("../../stores/repositories", () => ({ repositoriesStore: repositories }));
vi.mock("../../stores/terminals", () => ({ terminalsStore: terminals }));

import { useFocusTracker } from "../../hooks/useFocusTracker";

describe("useFocusTracker", () => {
	let dispose: () => void;
	beforeEach(() => {
		document.body.replaceChildren();
		for (const fn of Object.values(registry)) if ("mockReset" in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
		registry.isRepoScoped.mockImplementation((target: { kind: string }) => target.kind.startsWith("git-"));
		repositories.getRepoPathForTerminal.mockReset();
		terminals.get.mockReset();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		createRoot((d) => {
			dispose = d;
			useFocusTracker();
		});
	});
	afterEach(() => {
		dispose();
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	it("records a terminal focus and its repository association", () => {
		const terminal = document.createElement("div");
		terminal.dataset.focusTarget = "terminal";
		terminal.dataset.terminalId = "t1";
		document.body.append(terminal);
		repositories.getRepoPathForTerminal.mockReturnValue("/repo");
		terminal.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(registry.recordFocus).toHaveBeenCalledWith({ kind: "terminal", terminalId: "t1" });
		expect(registry.recordTerminalRepo).toHaveBeenCalledWith("t1", "/repo");
	});

	it("restores only when window focus has fallen back to body", () => {
		const input = document.createElement("input");
		document.body.append(input);
		const target = document.createElement("button");
		target.dataset.focusTarget = "notes";
		document.body.append(target);
		const focus = vi.spyOn(target, "focus");
		registry.getLastGlobal.mockReturnValue({ kind: "notes" });
		window.dispatchEvent(new FocusEvent("focus"));
		expect(focus).toHaveBeenCalledOnce();
		input.focus();
		focus.mockClear();
		window.dispatchEvent(new FocusEvent("focus"));
		expect(focus).not.toHaveBeenCalled();
	});

	it("removes focus listeners on cleanup", () => {
		dispose();
		const notes = document.createElement("div");
		notes.dataset.focusTarget = "notes";
		document.body.append(notes);
		notes.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
		expect(registry.recordFocus).not.toHaveBeenCalled();
		dispose = () => {};
	});
});
