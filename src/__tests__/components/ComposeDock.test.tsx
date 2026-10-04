import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

const ptyMocks = vi.hoisted(() => ({
	sendCommand: vi.fn().mockResolvedValue(undefined),
	enqueueCommand: vi.fn().mockResolvedValue({ queued: 2, id: 7 }),
}));

vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ sendCommand: ptyMocks.sendCommand, enqueueCommand: ptyMocks.enqueueCommand }),
}));

import { ComposeDock } from "../../components/ComposeDock/ComposeDock";
import { buildStartTargets, type StartTarget, startCommandFor } from "../../components/ComposeDock/composeTargets";
import { dictationStore } from "../../stores/dictation";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";

const REPO = "/repo/demo";

function addTerminal(name: string, agentType: "claude" | null, sessionId = `s-${name}`): string {
	const id = terminalsStore.add({ sessionId, cwd: REPO, name, awaitingInput: null, fontSize: 14 } as Parameters<
		typeof terminalsStore.add
	>[0]);
	if (agentType) terminalsStore.update(id, { agentType });
	return id;
}

function input(container: HTMLElement): HTMLTextAreaElement {
	const el = container.querySelector('[data-testid="compose-input"]');
	expect(el, "compose input").toBeTruthy();
	return el as HTMLTextAreaElement;
}

function type(field: HTMLTextAreaElement, value: string): void {
	fireEvent.input(field, { target: { value } });
}

beforeEach(async () => {
	ptyMocks.sendCommand.mockClear();
	ptyMocks.enqueueCommand.mockClear();
	mockInvoke.mockReset().mockResolvedValue(undefined);
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	repositoriesStore.setActive(null);
	// saveConfig updates the store only after the (mocked) backend call resolves.
	await dictationStore.saveConfig({ enabled: true });
});

afterEach(() => {
	cleanup();
	// repositoriesStore debounces its save; drop it so no timer outlives the test.
	repositoriesStore._testCancelPendingSave();
});

describe("composeTargets", () => {
	it("offers only agents that take a starting prompt — never a shell that would run the text", () => {
		const targets = buildStartTargets([
			{ type: "aider", name: "Aider", command: "aider" },
			{ type: "claude", name: "Claude Code", command: "claude --model opus" },
			{ type: "codex", name: "Codex CLI", command: "codex" },
		]);
		expect(targets.map((t) => t.id)).toEqual(["claude", "codex"]);
		expect(targets[0]!.command).toBe("claude --model opus");
	});

	it("passes the text to the agent as one quoted argument, so it is never run as a command", () => {
		const claude: StartTarget = { id: "claude", label: "Claude Code", agentType: "claude", command: "claude" };
		expect(startCommandFor(claude, "fix the user's bug")).toBe("claude 'fix the user'\\''s bug'");
		expect(startCommandFor(claude, "rm -rf build; echo done")).toBe("claude 'rm -rf build; echo done'");
	});

	it("puts a prompt that looks like a flag after --", () => {
		const codex: StartTarget = { id: "codex", label: "Codex CLI", agentType: "codex", command: "codex" };
		expect(startCommandFor(codex, "--help me")).toBe("codex -- '--help me'");
	});
});

describe("ComposeDock (dock)", () => {
	const renderDock = (onDictationStart = vi.fn()) =>
		render(() => <ComposeDock variant="dock" onDictationStart={onDictationStart} onDictationStop={vi.fn()} />);
	const bar = (container: HTMLElement) => container.querySelector('[data-testid="compose-bar"]');
	const click = (container: HTMLElement, testId: string) => {
		const el = container.querySelector(`[data-testid="${testId}"]`);
		expect(el, testId).toBeTruthy();
		fireEvent.click(el as HTMLButtonElement);
	};

	it("rests as one row — Speak, Type, and which terminal they go to — with no second text box", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		expect(bar(container)).not.toBeNull();
		expect(container.querySelector('[data-testid="compose-input"]')).toBeNull();
		expect(container.querySelector('[data-testid="compose-speak"]')?.textContent).toBe("Speak");
		expect(container.querySelector('[data-testid="compose-type"]')?.textContent).toBe("Type");
		expect(container.querySelector('[data-testid="compose-target"]')?.textContent).toContain("Claude Code");
	});

	it("Type opens the card with the field focused and inviting speech", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		expect(document.activeElement).toBe(field);
		expect(field.placeholder).toBe("Speak or type a prompt");
		expect(bar(container)).toBeNull();
	});

	it("drops Speak and the mic, and stops inviting speech, when dictation is off", async () => {
		await dictationStore.saveConfig({ enabled: false });
		terminalsStore.setActive(addTerminal("zsh", null));
		const { container } = renderDock();
		expect(container.querySelector('[data-testid="compose-speak"]')).toBeNull();
		click(container, "compose-type");
		expect(input(container).placeholder).toBe("Type a prompt");
		expect(container.querySelector('[data-testid="compose-mic"]')).toBeNull();
	});

	it("Enter sends to the active terminal with its agent's Enter semantics, then folds back into the bar", async () => {
		const id = addTerminal("Claude Code", "claude", "session-a");
		terminalsStore.setActive(id);
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "run the tests");
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(ptyMocks.sendCommand).toHaveBeenCalledWith("session-a", "run the tests", "claude"));
		await waitFor(() => expect(bar(container)).not.toBeNull());
		expect(ptyMocks.enqueueCommand).not.toHaveBeenCalled();
	});

	it("Shift+Enter is a newline, not a send", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "line one");
		fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
		expect(input(container)).toBe(field);
	});

	it("Option+Enter queues for an agent, shows the count, and stays open for the next one", async () => {
		const id = addTerminal("Claude Code", "claude", "session-q");
		terminalsStore.setActive(id);
		const { container } = renderDock();
		click(container, "compose-type");
		const field = input(container);
		type(field, "then push");
		fireEvent.keyDown(field, { key: "Enter", altKey: true });
		await waitFor(() => expect(ptyMocks.enqueueCommand).toHaveBeenCalledWith("session-q", "then push"));
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
		await waitFor(() =>
			expect(container.querySelector('[data-testid="compose-queued"]')?.textContent).toBe("2 queued"),
		);
		await waitFor(() => expect(field.value).toBe(""));
		expect(bar(container)).toBeNull();
	});

	it("keeps an unsent draft per terminal across tab switches, reopening the card where one waits", async () => {
		const a = addTerminal("Claude Code", "claude");
		const b = addTerminal("zsh", null);
		terminalsStore.setActive(a);
		const { container } = renderDock();
		click(container, "compose-type");
		type(input(container), "half a thought");
		terminalsStore.setActive(b);
		await waitFor(() => expect(bar(container)).not.toBeNull());
		terminalsStore.setActive(a);
		await waitFor(() => expect(input(container).value).toBe("half a thought"));
	});

	it("Speak opens the card and focuses the field before dictation starts, so the transcript lands here", async () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const seen: { focusedAtStart: Element | null } = { focusedAtStart: null };
		const onStart = vi.fn(() => {
			seen.focusedAtStart = document.activeElement;
		});
		const { container } = renderDock(onStart);
		click(container, "compose-speak");
		await waitFor(() => expect(onStart).toHaveBeenCalled());
		expect(seen.focusedAtStart?.getAttribute("data-testid")).toBe("compose-input");
		// Nothing started recording (the mock does not), so the empty card folds back.
		await waitFor(() => expect(bar(container)).not.toBeNull());
	});

	it("Escape hands an empty card back to the bar", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude"));
		const { container } = renderDock();
		click(container, "compose-type");
		fireEvent.keyDown(input(container), { key: "Escape" });
		expect(bar(container)).not.toBeNull();
	});

	it("is disabled when the active terminal has no session yet", () => {
		terminalsStore.setActive(addTerminal("Claude Code", "claude", ""));
		terminalsStore.update(terminalsStore.state.activeId!, { sessionId: null });
		const { container } = renderDock();
		expect((container.querySelector('[data-testid="compose-speak"]') as HTMLButtonElement).disabled).toBe(true);
		expect((container.querySelector('[data-testid="compose-type"]') as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("ComposeDock (hero)", () => {
	const targets = () =>
		buildStartTargets([
			{ type: "claude", name: "Claude Code", command: "claude" },
			{ type: "codex", name: "Codex CLI", command: "codex" },
		]);

	it("asks what to build in the active repo and starts the chosen agent on Enter", async () => {
		repositoriesStore.add({ path: REPO, displayName: "demo", initials: "DE" });
		repositoriesStore.setActive(REPO);
		const onStart = vi.fn();
		const { container } = render(() => (
			<ComposeDock
				variant="hero"
				onDictationStart={vi.fn()}
				onDictationStop={vi.fn()}
				startTargets={targets}
				onStart={onStart}
			/>
		));
		expect(container.querySelector("h1")?.textContent).toBe("What should we build in demo?");
		const picker = container.querySelector('[data-testid="compose-start-target"]') as HTMLSelectElement;
		expect(Array.from(picker.options).map((o) => o.value)).toEqual(["claude", "codex"]);
		fireEvent.change(picker, { target: { value: "codex" } });

		const field = input(container);
		expect(field.placeholder).toBe("Speak or type what to build");
		type(field, "add a health route");
		fireEvent.keyDown(field, { key: "Enter" });
		await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
		const [target, text] = onStart.mock.calls[0]!;
		expect((target as StartTarget).id).toBe("codex");
		expect(text).toBe("add a health route");
		expect(ptyMocks.sendCommand).not.toHaveBeenCalled();
	});

	it("is disabled, and says why, when no prompt-taking agent is installed", () => {
		repositoriesStore.add({ path: REPO, displayName: "demo", initials: "DE" });
		repositoriesStore.setActive(REPO);
		const { container } = render(() => (
			<ComposeDock variant="hero" onDictationStart={vi.fn()} onDictationStop={vi.fn()} startTargets={() => []} />
		));
		expect(input(container).disabled).toBe(true);
		expect(input(container).placeholder).toBe("Install Claude Code or Codex CLI to start an agent from here");
		expect(container.querySelector('[data-testid="compose-start-target"]')).toBeNull();
	});

	it("is disabled until a repository exists", () => {
		const { container } = render(() => (
			<ComposeDock variant="hero" onDictationStart={vi.fn()} onDictationStop={vi.fn()} startTargets={targets} />
		));
		expect(container.querySelector("h1")?.textContent).toBe("What should we build?");
		expect(input(container).disabled).toBe(true);
		expect(input(container).placeholder).toBe("Add a repository to start");
	});
});
