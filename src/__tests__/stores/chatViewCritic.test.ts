import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(),
	listen: vi.fn(async () => () => {}),
}));

import { invoke } from "../../invoke";
import { acpTranscript } from "../../stores/acpTranscript";
import { chatViewKey, chatViewStore } from "../../stores/chatView";

const SID = "sess-critic";

describe("chatViewStore.refresh overlap", () => {
	beforeEach(() => {
		chatViewStore.reset();
		acpTranscript.reset();
		vi.mocked(invoke).mockReset();
	});

	// A wake event arriving while the keepalive read is still in flight (slow
	// phone link) reads from the same cursor; both replies carry the same chunk,
	// and acpTranscript concatenates chunks of one messageId: "hellohello".
	it("applies a chunk once when two refreshes overlap", async () => {
		const snapshot = {
			epoch: 0,
			nextSeq: 1,
			reset: false,
			unknownRows: 0,
			malformedRows: 0,
			updates: [
				{
					sessionUpdate: "agent_message_chunk",
					messageId: "m1",
					content: { type: "text", text: "hello" },
				},
			],
		};
		vi.mocked(invoke).mockImplementation(async (_cmd, args) =>
			(args as { fromSeq: number }).fromSeq === 0 ? snapshot : { ...snapshot, updates: [] },
		);
		await chatViewStore.watch(SID);
		await Promise.all([chatViewStore.refresh(SID), chatViewStore.refresh(SID)]);
		const entries = acpTranscript.entries(chatViewKey(SID));
		expect(entries.map((e) => (e.kind === "agent" ? e.text : e.kind))).toEqual(["hello"]);
	});
});
