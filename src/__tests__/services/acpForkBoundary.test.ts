import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

import { invoke } from "../../invoke";
import { createAcpClient } from "../../services/acpClient";
import { acpStore } from "../../stores/acp";
import { acpTranscript } from "../../stores/acpTranscript";

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	acpStore.reset();
	acpTranscript.reset();
});

// Catches: an intermediate reply fork hiding later actions/answers that the child actually inherited.
// Oracle: ego-core PreparedFork::after_message cuts at the containing TurnCompleted.
// These are TUIC transcript rows, not a fake of ego's wire stream.
it("forking an intermediate reply retains the completed turn and excludes the next turn", async () => {
	acpTranscript.restore("parent", [
		{ id: "prompt", kind: "user", text: "Update the config" },
		{ id: "interim", kind: "agent", text: "I will update it", messageId: "interim-message" },
		{ id: "tool", kind: "tool", call: { toolCallId: "edit", title: "Edit config", status: "completed" } },
		{ id: "final", kind: "agent", text: "The config is updated", messageId: "final-message" },
		{ id: "next-prompt", kind: "user", text: "Now deploy it" },
		{ id: "next-reply", kind: "agent", text: "Deployed", messageId: "next-message" },
	]);
	vi.mocked(invoke).mockImplementation(async (command) => {
		if (command === "acp_session_fork") return { sessionId: "child" };
		if (command === "acp_connection_snapshot")
			return {
				connectionId: "connection",
				generation: 1,
				state: "ready",
				agentInfo: null,
				capabilities: null,
				attachments: [],
				earliestSequence: 1,
				latestSequence: 1,
				settlement: null,
			};
		throw new Error(`Unexpected command: ${command}`);
	});

	await createAcpClient().forkSession("connection", "parent", "/workspace", "interim-message");

	expect(acpTranscript.entries("child").map((entry) => entry.id)).toEqual(["prompt", "interim", "tool", "final"]);
	expect(acpTranscript.entries("parent")).toHaveLength(6);
});
