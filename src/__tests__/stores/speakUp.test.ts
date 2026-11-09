import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentAsk } from "../../stores/agentAsk";
import { notificationsStore } from "../../stores/notifications";
import { repositoriesStore } from "../../stores/repositories";
import { noticeSentence, noticeTarget, speakUp } from "../../stores/speakUp";
import { talkStore } from "../../stores/talk";
import { terminalsStore } from "../../stores/terminals";
import { voiceIsReady, voiceStore } from "../../stores/voice";
import { mockInvoke } from "../mocks/tauri";

const PERMISSION = {
	title: "Do you want to run rm -rf data/cache?",
	options: [
		{ key: "1", label: "Yes", highlighted: true, destructive: false },
		{ key: "2", label: "Yes, and don't ask again", highlighted: false, destructive: false },
		{ key: "3", label: "No", highlighted: false, destructive: false },
	],
};
const VOICE_CONFIG = {
	model: "q8f16",
	voice: "af_heart",
	speed: 1,
	barge_in: true,
	output_device: null,
	speak_up: true,
};
const VOICE_STATUS = {
	engine_state: "ready",
	loaded_model: "q8f16",
	session_active: true,
	muted: false,
	speaking: false,
	audio_level: 0,
	output_level: 0,
};

let config = { ...VOICE_CONFIG };
let downloaded = true;
let stop: (() => void) | undefined;

function addAgent(name: string, patch: Record<string, unknown> = {}): string {
	const id = terminalsStore.add({
		sessionId: `s-${name}`,
		cwd: "/repo/demo",
		name,
		awaitingInput: null,
		fontSize: 14,
	} as Parameters<typeof terminalsStore.add>[0]);
	terminalsStore.update(id, { agentType: "claude", ...patch } as Parameters<typeof terminalsStore.update>[1]);
	return id;
}

const announced = () =>
	mockInvoke.mock.calls.filter(([cmd]) => cmd === "voice_announce").map(([, args]) => (args as { text: string }).text);
const written = () =>
	mockInvoke.mock.calls.filter(([cmd]) => cmd === "write_pty").map(([, args]) => (args as { data: string }).data);

/** Start the notifier and let it read the voice config and what is on disk. */
async function start() {
	stop = speakUp.start();
	await vi.waitFor(() => expect(voiceStore.state.models.length).toBeGreaterThan(0));
	await vi.waitFor(() => expect(voiceStore.state.config.speak_up).toBe(config.speak_up));
}

beforeEach(() => {
	config = { ...VOICE_CONFIG };
	downloaded = true;
	mockInvoke.mockReset().mockImplementation(async (cmd: string) => {
		switch (cmd) {
			case "voice_get_config":
				return config;
			case "voice_model_info":
				return [{ name: "q8f16", display_name: "Kokoro", size_hint_mb: 86, downloaded, actual_size_mb: 86 }];
			case "voice_list_voices":
				return [{ id: "af_heart", display_name: "Heart", downloaded }];
			case "voice_status":
				return VOICE_STATUS;
			default:
				return undefined;
		}
	});
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	// The window is in front, but on another terminal than the one that asks.
	vi.spyOn(document, "hasFocus").mockReturnValue(true);
});

afterEach(async () => {
	stop?.();
	stop = undefined;
	await talkStore.stop();
	agentAsk.clear();
	vi.restoreAllMocks();
	repositoriesStore._testCancelPendingSave();
});

describe("noticeSentence", () => {
	const target = { terminalId: "t1", recipient: "Claude Code", place: "ml-pipeline" };

	it("says who needs you and reads a short question out", () => {
		expect(noticeSentence("question", target, "Do you want to run `rm -rf data/cache`?")).toBe(
			"Claude Code in ml-pipeline needs you. Do you want to run rm -rf data/cache?",
		);
	});

	// Catches: a plan the length of a page being read aloud as a "notice".
	it("leaves a long question on the screen", () => {
		expect(noticeSentence("question", target, "x".repeat(400))).toBe("Claude Code in ml-pipeline needs you.");
	});

	it("says who is done", () => {
		expect(noticeSentence("completion", target)).toBe("Claude Code in ml-pipeline is done.");
	});

	it("names only the agent when the terminal belongs to no repository", () => {
		expect(noticeSentence("completion", { ...target, place: null })).toBe("Claude Code is done.");
	});
});

describe("speakUp", () => {
	it("says so when an agent in another terminal finishes", async () => {
		const done = addAgent("worker");
		terminalsStore.setActive(addAgent("front"));
		await start();

		await notificationsStore.playCompletion(done);

		expect(announced()).toEqual(["Claude Code is done."]);
	});

	it("reads out the question an agent stopped on, and offers it for a yes or a no", async () => {
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(addAgent("front"));
		await start();

		await notificationsStore.playQuestion(asking);

		expect(announced()).toEqual(["Claude Code needs you. Do you want to run rm -rf data/cache?"]);
		expect(agentAsk.pending()).toMatchObject({ title: PERMISSION.title, approveKey: "1", denyKey: "3" });
		expect(agentAsk.pending()?.target.terminalId).toBe(asking);
	});

	// Catches: a voice talking over what you are already reading.
	it("says nothing about the terminal you are looking at", async () => {
		const front = addAgent("front", { awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(front);
		await start();

		await notificationsStore.playQuestion(front);

		expect(announced()).toEqual([]);
		expect(agentAsk.pending()).toBeNull();
	});

	it("speaks about the front terminal too once the window is in the background", async () => {
		const front = addAgent("front");
		terminalsStore.setActive(front);
		vi.spyOn(document, "hasFocus").mockReturnValue(false);
		await start();

		await notificationsStore.playCompletion(front);

		expect(announced()).toEqual(["Claude Code is done."]);
	});

	it("stays quiet when the setting is off, but still offers the question", async () => {
		config = { ...VOICE_CONFIG, speak_up: false };
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(addAgent("front"));
		await start();

		await notificationsStore.playQuestion(asking);

		expect(announced()).toEqual([]);
		expect(agentAsk.pending()?.target.terminalId).toBe(asking);
	});

	// Catches: every notice failing in the backend, and logging so, on a
	// machine where the voice was never downloaded.
	it("does not try to speak before the voice is on disk", async () => {
		downloaded = false;
		const done = addAgent("worker");
		terminalsStore.setActive(addAgent("front"));
		stop = speakUp.start();
		// The store is shared between tests; wait for this one's listing to land.
		await vi.waitFor(() => expect(voiceIsReady()).toBe(false));

		await notificationsStore.playCompletion(done);

		expect(announced()).toEqual([]);
	});

	it("ignores reminders, shells and sounds that are not about an agent's state", async () => {
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: PERMISSION });
		const shell = addAgent("server", { agentType: null });
		terminalsStore.setActive(addAgent("front"));
		await start();

		await notificationsStore.playQuestionReminder(asking);
		await notificationsStore.playCompletion(shell);
		await notificationsStore.playError(asking);

		expect(announced()).toEqual([]);
	});

	// Catches: the first question of a terminal that was only just restored
	// going unsaid. The poll writes "awaiting" and, in a second write, which
	// agent it is; the notice fires between the two.
	it("still speaks when the notice arrives a moment before the agent is identified", async () => {
		const asking = addAgent("worker", { agentType: null, awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(addAgent("front"));
		await start();

		const played = notificationsStore.playQuestion(asking);
		terminalsStore.update(asking, { agentType: "claude" } as Parameters<typeof terminalsStore.update>[1]);
		await played;

		expect(announced()).toEqual(["Claude Code needs you. Do you want to run rm -rf data/cache?"]);
		expect(agentAsk.pending()?.target.terminalId).toBe(asking);
	});

	it("speaks through the conversation, with a caption, when one is running", async () => {
		const done = addAgent("worker");
		terminalsStore.setActive(addAgent("front"));
		await start();
		await talkStore.start();

		await notificationsStore.playCompletion(done);

		expect(announced()).toEqual([]);
		expect(
			mockInvoke.mock.calls.some(
				([cmd, args]) => cmd === "voice_speak" && (args as { text: string }).text === "Claude Code is done.",
			),
		).toBe(true);
		expect(talkStore.caption()).toEqual({ who: "agent", text: "Claude Code is done." });
	});

	it("withdraws the question once it has been answered in the terminal itself", async () => {
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(addAgent("front"));
		await start();
		await notificationsStore.playQuestion(asking);
		expect(agentAsk.pending()).not.toBeNull();

		terminalsStore.update(asking, { awaitingInput: null, choicePrompt: null });

		await vi.waitFor(() => expect(agentAsk.pending()).toBeNull());
	});

	// Catches: a question with no yes and no — which approach, which file —
	// offered with Approve and Deny buttons that would pick blindly.
	it("does not offer an answer for a question that is not a yes-or-no", async () => {
		const plans = {
			title: "Which approach?",
			options: [
				{ key: "1", label: "Rewrite the parser", highlighted: true, destructive: false },
				{ key: "2", label: "Patch the tokenizer", highlighted: false, destructive: false },
			],
		};
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: plans });
		terminalsStore.setActive(addAgent("front"));
		await start();

		await notificationsStore.playQuestion(asking);

		expect(announced()).toEqual(["Claude Code needs you. Which approach?"]);
		expect(agentAsk.pending()).toBeNull();
	});
});

describe("agentAsk.answer", () => {
	async function raise() {
		const asking = addAgent("worker", { awaitingInput: "question", choicePrompt: PERMISSION });
		terminalsStore.setActive(addAgent("front"));
		await start();
		await notificationsStore.playQuestion(asking);
		return asking;
	}

	it("sends the key for yes to the agent that asked", async () => {
		await raise();
		expect(await agentAsk.answer(true)).toBe(true);
		expect(written().join("")).toContain("1");
		expect(mockInvoke.mock.calls.find(([cmd]) => cmd === "write_pty")?.[1]).toMatchObject({ sessionId: "s-worker" });
		expect(agentAsk.pending()).toBeNull();
	});

	it("sends the key for no", async () => {
		await raise();
		expect(await agentAsk.answer(false)).toBe(true);
		expect(written().join("")).toContain("3");
	});

	// Catches: "approve" landing on a different question than the one that was
	// read out — the agent moved on, and the same key now means something else.
	it("refuses to answer a dialog that changed after it was read out", async () => {
		const asking = await raise();
		terminalsStore.update(asking, {
			choicePrompt: { ...PERMISSION, title: "Do you want to push to main?" },
		} as Parameters<typeof terminalsStore.update>[1]);
		// The store's own effect would re-raise for the new prompt; answer the old one first.
		const stale = agentAsk.pending();
		agentAsk.raise({ ...(stale as NonNullable<typeof stale>), title: PERMISSION.title });

		expect(await agentAsk.answer(true)).toBe(false);
		expect(written()).toEqual([]);
	});

	it("does nothing when no question is waiting", async () => {
		expect(await agentAsk.answer(true)).toBe(false);
		expect(written()).toEqual([]);
	});
});

describe("noticeTarget", () => {
	it("names the agent in a terminal, and nothing for a terminal that is gone", () => {
		const id = addAgent("worker");
		expect(noticeTarget(id)).toMatchObject({ terminalId: id, recipient: "Claude Code" });
		expect(noticeTarget("nope")).toBeNull();
	});
});
