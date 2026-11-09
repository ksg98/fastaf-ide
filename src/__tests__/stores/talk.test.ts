import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoriesStore } from "../../stores/repositories";
import { agentFleet, describeSession, startTalk, talkStore, toggleTalk } from "../../stores/talk";
import { terminalsStore } from "../../stores/terminals";
import { toastsStore } from "../../stores/toasts";
import { voiceSetup } from "../../stores/voiceSetup";
import { enableAiChat, voiceInstallAnswer } from "../helpers/voiceReady";
import { mockInvoke } from "../mocks/tauri";

function addTerminal(name: string, patch: Record<string, unknown> = {}): string {
	const id = terminalsStore.add({
		sessionId: `s-${name}`,
		cwd: "/repo/demo",
		name,
		awaitingInput: null,
		fontSize: 14,
	} as Parameters<typeof terminalsStore.add>[0]);
	terminalsStore.update(id, patch as Parameters<typeof terminalsStore.update>[1]);
	return id;
}

let disableAiChat: () => void;

beforeEach(() => {
	mockInvoke.mockReset().mockImplementation(async (cmd: string) => voiceInstallAnswer(cmd));
	disableAiChat = enableAiChat();
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
});

afterEach(async () => {
	await talkStore.stop();
	voiceSetup.dismiss();
	disableAiChat();
	repositoriesStore._testCancelPendingSave();
});

describe("describeSession", () => {
	it("names the agent running in the terminal that owns the session", () => {
		const id = addTerminal("upstream-retries 1", { agentType: "claude" });
		expect(describeSession("s-upstream-retries 1")).toMatchObject({ terminalId: id, recipient: "Claude Code" });
	});

	it("falls back to the tab's own name when no agent is running there", () => {
		addTerminal("dev server");
		expect(describeSession("s-dev server")?.recipient).toBe("dev server");
	});

	it("knows nothing about a session no terminal owns", () => {
		expect(describeSession("s-elsewhere")).toBeNull();
	});
});

describe("agentFleet", () => {
	// Catches: a dev server that has been "busy" for an hour counted as an agent
	// at work, and an agent stuck on a question counted as working.
	it("counts agents at work and lists the ones waiting, ignoring plain shells", () => {
		addTerminal("a", { agentType: "claude", shellState: "busy" });
		addTerminal("b", { agentType: "codex", shellState: "busy" });
		const waiting = addTerminal("c", { agentType: "claude", shellState: "idle", awaitingInput: "question" });
		addTerminal("server", { shellState: "busy" });
		addTerminal("idle agent", { agentType: "claude", shellState: "idle" });

		expect(agentFleet()).toEqual({ working: 2, waiting: [waiting] });
	});
});

describe("toggleTalk", () => {
	const voiceStarts = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "voice_start").length;

	it("starts a conversation about the terminal in front, and ends it on the next press", async () => {
		terminalsStore.setActive(addTerminal("Claude Code", { agentType: "claude" }));

		toggleTalk();
		await vi.waitFor(() => expect(talkStore.active()).toBe(true));
		expect(voiceStarts()).toBe(1);

		toggleTalk();
		await vi.waitFor(() => expect(talkStore.active()).toBe(false));
	});

	// Catches: the shortcut opening the microphone with nothing to talk about;
	// the chat then answers every sentence with "No terminal attached".
	it("does nothing when there is no terminal to talk about", async () => {
		toggleTalk();
		await Promise.resolve();
		expect(voiceStarts()).toBe(0);
		expect(talkStore.engaged()).toBe(false);
	});
});

describe("startTalk", () => {
	it("says why when the voice cannot start", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "voice_start") throw new Error("Failed to open an audio output device");
			return voiceInstallAnswer(cmd);
		});
		const added = vi.spyOn(toastsStore, "add").mockImplementation(() => 0);
		try {
			await startTalk();
			expect(added).toHaveBeenCalledWith(
				"Could not start the conversation",
				expect.stringContaining("audio output device"),
				"error",
			);
			expect(talkStore.active()).toBe(false);
		} finally {
			added.mockRestore();
		}
	});

	// Catches: the microphone opening, and then failing, on an install that has
	// nothing to hear or speak with yet.
	it("offers setup instead of starting when voice is not set up", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => voiceInstallAnswer(cmd, { voice: false }));

		await startTalk();

		expect(voiceSetup.state.offered).toBe(true);
		expect(talkStore.engaged()).toBe(false);
		expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "voice_start")).toBe(false);
	});

	it("offers setup when AI Chat, the agent it talks to, is switched off", async () => {
		disableAiChat();

		await startTalk();

		expect(voiceSetup.state.offered).toBe(true);
		expect(talkStore.engaged()).toBe(false);
	});

	// Catches: a second toast on top of the system's own microphone prompt.
	it("stays quiet about a refused microphone, which the voice store already handles", async () => {
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "voice_start") throw new Error("microphone_denied");
			return voiceInstallAnswer(cmd);
		});
		const added = vi.spyOn(toastsStore, "add").mockImplementation(() => 0);
		try {
			await startTalk();
			expect(added).not.toHaveBeenCalled();
		} finally {
			added.mockRestore();
		}
	});
});
