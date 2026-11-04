import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), diag: { info: vi.fn() } },
}));
vi.mock("../../../hooks/usePty", () => ({
	usePty: () => ({
		sendCommand: vi.fn().mockResolvedValue(undefined),
		enqueueCommand: vi.fn().mockResolvedValue({ queued: 1 }),
		listQueuedCommands: vi.fn().mockResolvedValue([]),
		removeQueuedCommand: vi.fn().mockResolvedValue(false),
		createSession: vi.fn().mockResolvedValue("sess-dock"),
		resize: vi.fn(),
		close: vi.fn(),
		getKittyFlags: vi.fn().mockResolvedValue(0),
	}),
}));
vi.mock("../../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../transport")>()),
	rpc: vi.fn().mockResolvedValue(undefined),
	subscribePty: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: vi.fn(async (cmd: string) => (cmd === "get_session_foreground_process" ? "claude" : undefined)),
}));
vi.mock("../../../stores/agentConfigs", () => ({
	ensureAgentConfigsForRepo: vi.fn().mockResolvedValue({ getEnvFlags: () => ({}) }),
	agentConfigsForRepo: () => ({ getEnvFlags: () => ({}) }),
}));
vi.mock("../../../components/Terminal/glyphCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../components/Terminal/glyphCache")>()),
	getSharedMetrics: () => ({ cellWidth: 8, cellHeight: 16 }),
}));
vi.mock("../../../components/Terminal/CanvasTerminal", () => ({
	default: (props: { onRef?: (ref: { focus: () => void; searchClear: () => void }) => void }) => {
		let input!: HTMLInputElement;
		return (
			<div data-testid="canvas" data-terminal-container>
				<input
					aria-label="Canvas terminal input"
					ref={(element) => {
						input = element;
						props.onRef?.({ focus: () => input.focus({ preventScroll: true }), searchClear: vi.fn() });
					}}
				/>
			</div>
		);
	},
}));
vi.mock("../../../invoke", () => ({
	invoke: vi.fn(async (command: string) => {
		if (command === "get_session_foreground_process") return "claude";
		if (command === "get_shell_state") return "idle";
		if (command !== "chat_view_snapshot") return undefined;
		return { epoch: 0, nextSeq: 0, reset: true, updates: [], unknownRows: 0, malformedRows: 0 };
	}),
	listen: vi.fn(async () => () => {}),
}));

import { composeDockBridge } from "../../../components/ComposeDock/dockBridge";
import { Terminal } from "../../../components/Terminal/Terminal";
import { terminalsStore } from "../../../stores/terminals";

let unregisterDock: (() => void) | undefined;
const dockOpen = vi.fn((_text?: { insert?: string; replace?: string }) => true);

/** Stand in for the compose dock App.tsx mounts under the terminal column. */
function mountDock() {
	unregisterDock = composeDockBridge.register({ open: dockOpen });
}

beforeEach(async () => {
	vi.clearAllMocks();
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	// Chat's own composer is lazy; resolve it up front so its absence is not a pending import.
	await import("../../../components/ComposePanel/ComposePanel");
});

afterEach(async () => {
	cleanup();
	unregisterDock?.();
	unregisterDock = undefined;
	vi.restoreAllMocks();
	await new Promise<void>((done) => setTimeout(done, 20));
});

function addClaude(name = "claude", sessionId = "live-session") {
	const id = terminalsStore.add({
		sessionId,
		cwd: "/repo",
		repoPath: "/repo",
		name,
		fontSize: 13,
		awaitingInput: null,
	});
	terminalsStore.update(id, { agentType: "claude", agentSessionId: "uuid" });
	return id;
}

async function openChat(id: string, onFocus?: (id: string) => void) {
	const view = render(() => <Terminal id={id} cwd="/repo" alwaysVisible onFocus={onFocus} />);
	fireEvent.click(view.getByRole("tab", { name: "Chat" }));
	const transcript = await view.findByLabelText("Chat transcript");
	return { view, transcript };
}

/**
 * FastAF's compose dock is the one input for the active terminal. Chat must not
 * stack upstream's composer above it ("never a second text box under an agent's
 * prompt"); the composer returns only where no dock exists (a detached window).
 */
describe("Chat view in front of the compose dock", () => {
	// Catches: the grey Chat composer stacked directly above the dock's Speak/Type row.
	it("draws no composer of its own while the dock is on screen, and brings it back without one", async () => {
		mountDock();
		const id = addClaude();
		terminalsStore.setActive(id);
		const { view } = await openChat(id);
		await new Promise<void>((done) => setTimeout(done, 0));
		expect(view.container.querySelector("[data-compose-editor]")).toBeNull();
		unregisterDock?.();
		unregisterDock = undefined;
		await waitFor(() => expect(view.container.querySelector("[data-compose-editor]")).not.toBeNull());
	});

	// Catches: switching to Chat leaving the caret on the switch, where typing goes nowhere.
	it("puts keyboard focus on the transcript when Chat opens", async () => {
		mountDock();
		const id = addClaude();
		terminalsStore.setActive(id);
		const { transcript } = await openChat(id);
		await waitFor(() => expect(document.activeElement).toBe(transcript));
	});

	// Catches: Chat typing, the compose shortcut and smart-prompt text losing their target once Chat's composer is gone.
	it("hands transcript typing, the compose shortcut and a smart prompt to the dock", async () => {
		mountDock();
		const id = addClaude();
		terminalsStore.setActive(id);
		const { transcript } = await openChat(id);
		transcript.focus();
		const key = new KeyboardEvent("keydown", { key: "A", shiftKey: true, bubbles: true, cancelable: true });
		transcript.dispatchEvent(key);
		expect(dockOpen).toHaveBeenCalledWith({ insert: "A" });
		expect(key.defaultPrevented).toBe(true);
		terminalsStore.get(id)?.ref?.toggleCompose();
		expect(dockOpen).toHaveBeenCalledTimes(2);
		expect(dockOpen.mock.lastCall?.[0]).toBeUndefined();
		terminalsStore.get(id)?.ref?.openComposeWithText("Review the diff");
		expect(dockOpen).toHaveBeenLastCalledWith({ replace: "Review the diff" });
	});

	// Catches: typing in a background Chat tile landing in the dock of a different terminal.
	it("keeps another terminal's typing out of the dock, and makes a focused Chat tile the dock's target", async () => {
		mountDock();
		const other = addClaude("other", "other-session");
		const id = addClaude();
		terminalsStore.setActive(other);
		const onFocus = vi.fn();
		const { transcript } = await openChat(id, onFocus);
		const key = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
		transcript.dispatchEvent(key);
		expect(dockOpen).not.toHaveBeenCalled();
		expect(key.defaultPrevented).toBe(false);
		fireEvent.focusIn(transcript);
		expect(onFocus).toHaveBeenCalledWith(id);
	});
});

const css = (file: string) => readFileSync(resolve(__dirname, "../../..", file), "utf8");
/** The declarations of the first rule whose selector list is exactly `selector`. */
const rule = (source: string, selector: string) => {
	const start = source.indexOf(`${selector} {`);
	if (start < 0) throw new Error(`no rule ${selector}`);
	return source.slice(start, source.indexOf("}", start));
};

describe("CLI | Chat switch geometry", () => {
	// Catches: the switch reserving a 26px row above every agent terminal and multiview tile.
	it("floats over the terminal instead of taking a row", () => {
		const source = css("components/Terminal/TerminalChatView.module.css");
		expect(rule(source, ".toggle")).toContain("position: absolute");
		expect(source).not.toMatch(/position:\s*static/);
	});

	// Catches: the pill turning opaque the moment the pointer enters the terminal and hiding the agent's top rows.
	it("stays a faint see-through outline until pointed at, focused or in Chat", () => {
		const source = css("components/Terminal/TerminalChatView.module.css");
		const resting = rule(source, ".toggle");
		expect(resting).toContain("opacity: 0;");
		expect(resting).toContain("background: transparent");
		const quiet = rule(source, ":global([data-terminal-id]:hover) > .toggle");
		const opacity = Number(/opacity:\s*([0-9.]+)/.exec(quiet)?.[1]);
		expect(opacity).toBeGreaterThan(0);
		expect(opacity).toBeLessThanOrEqual(0.4);
		expect(quiet).not.toContain("background");
		const solid = rule(
			source,
			':global([data-terminal-id]) > .toggle:is(:hover, :has(:focus-visible), [data-mode="chat"])',
		);
		expect(solid).toContain("opacity: 1");
		expect(solid).toContain("background: var(--bg-primary)");
		// The fade is motion: reduced-motion users get none.
		expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.toggle\s*\{\s*transition: none;/);
	});

	// Catches: the selected segment drawn as an accent ring instead of FastAF's --row-selected fill.
	it("marks the selected segment with --row-selected, never a ring", () => {
		const source = css("components/ui/FormControls.module.css");
		const selected = rule(source, '.segment[aria-selected="true"], .segment[aria-selected="true"]:hover:enabled');
		expect(selected).toContain("background: var(--row-selected)");
		expect(selected).not.toMatch(/box-shadow|outline|--accent/);
	});
});
