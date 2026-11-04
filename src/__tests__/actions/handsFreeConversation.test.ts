import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toggleHandsFreeConversation } from "../../actions/handsFreeConversation";
import { dictationStore } from "../../stores/dictation";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";
import { mockInvoke } from "../mocks/tauri";

const armedStatus = (sessionId: string) => ({
	armed: true,
	phase: "waiting",
	sessionId,
	owner: "desktop",
	generation: 1,
	pendingText: null,
	holdBackMs: 0,
	error: null,
	deliveredTurns: 0,
	droppedTurns: 0,
});

/**
 * One entry point starts and stops the conversation from the Command Palette
 * (and any shortcut bound to it). These pin what it binds — the terminal
 * the user is looking at — because binding any other one sends their speech
 * to an agent they are not watching.
 */
describe("toggleHandsFreeConversation", () => {
	beforeEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		mockInvoke.mockReset().mockResolvedValue(undefined);
	});

	afterEach(async () => {
		// Leave the store disarmed so its status monitor stops.
		mockInvoke.mockResolvedValue({ status: { ...armedStatus(""), armed: false } });
		if (dictationStore.state.handsFree?.armed) await dictationStore.disarmHandsFree();
		vi.restoreAllMocks();
	});

	it("arms the active terminal's session, not another open one", async () => {
		terminalsStore.add(makeTerminal({ name: "Other", sessionId: "sess-other" }));
		const active = terminalsStore.add(makeTerminal({ name: "Active", sessionId: "sess-active" }));
		terminalsStore.setActive(active);
		mockInvoke.mockImplementation(async (cmd: string) =>
			cmd === "arm_hands_free_dictation" ? armedStatus("sess-active") : undefined,
		);

		await toggleHandsFreeConversation();

		const armCalls = mockInvoke.mock.calls.filter(([cmd]) => cmd === "arm_hands_free_dictation");
		expect(armCalls).toHaveLength(1);
		expect(armCalls[0][1]).toMatchObject({ sessionId: "sess-active" });
		expect(dictationStore.state.handsFree?.armed).toBe(true);
	});

	it("disarms instead of re-arming when a conversation is already armed", async () => {
		const active = terminalsStore.add(makeTerminal({ sessionId: "sess-active" }));
		terminalsStore.setActive(active);
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "arm_hands_free_dictation") return armedStatus("sess-active");
			if (cmd === "disarm_hands_free_dictation")
				return { status: { ...armedStatus(""), armed: false, sessionId: null } };
			return undefined;
		});
		await toggleHandsFreeConversation();
		mockInvoke.mockClear();

		await toggleHandsFreeConversation();

		const commands = mockInvoke.mock.calls.map(([cmd]) => cmd);
		expect(commands).toContain("disarm_hands_free_dictation");
		expect(commands).not.toContain("arm_hands_free_dictation");
		expect(dictationStore.state.handsFree?.armed).toBe(false);
	});

	it("does not open the microphone when the active tab has no live session", async () => {
		const active = terminalsStore.add(makeTerminal({ sessionId: null }));
		terminalsStore.setActive(active);

		await toggleHandsFreeConversation();

		expect(mockInvoke.mock.calls.map(([cmd]) => cmd)).not.toContain("arm_hands_free_dictation");
	});
});
