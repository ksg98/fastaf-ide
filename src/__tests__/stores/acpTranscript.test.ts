import { beforeEach, describe, expect, it } from "vitest";

import { acpTranscript } from "../../stores/acpTranscript";
import type { AcpClientEvent, AcpStreamFrame } from "../../types/acp";

const SESSION = "01932d5e-0000-7000-8000-0000000000aa";
const OTHER = "01932d5e-0000-7000-8000-0000000000ab";

let sequence = 0;

function frame(event: AcpClientEvent, sessionId: string | null = SESSION): AcpStreamFrame {
	sequence += 1;
	return {
		kind: "event",
		connectionId: "01932d5e-0000-7000-8000-0000000000c1",
		generation: 1,
		sequence,
		sessionId,
		turnId: null,
		event,
	};
}

/** One `session/update`, in the shape the wire carries it. */
function update(body: Record<string, unknown>, sessionId: string | null = SESSION): AcpStreamFrame {
	return frame({ kind: "sessionUpdate", update: body } as unknown as AcpClientEvent, sessionId);
}

function text(body: string) {
	return { type: "text", text: body };
}

beforeEach(() => {
	sequence = 0;
	acpTranscript.reset();
});

describe("acpTranscript: messages", () => {
	// Catches: steering creates an optimistic bubble or merges its echo into the preceding reply.
	it("shows mid-turn steering once at the echoed conversation position", () => {
		acpTranscript.applyFrame(frame({ kind: "promptSent", text: "desktop" }));
		acpTranscript.applyFrame(
			update({ sessionUpdate: "user_message_chunk", content: text("desktop"), messageId: "first" }),
		);
		acpTranscript.applyFrame(
			update({ sessionUpdate: "agent_message_chunk", content: text("working"), messageId: "reply" }),
		);
		acpTranscript.applyFrame(
			update({ sessionUpdate: "user_message_chunk", content: text("phone"), messageId: "steer" }),
		);
		expect(acpTranscript.entries(SESSION).map((entry) => entry.kind)).toEqual(["user", "agent", "user"]);
		expect(
			acpTranscript
				.entries(SESSION)
				.filter((entry) => entry.kind === "user")
				.map((entry) => entry.text),
		).toEqual(["desktop", "phone"]);
	});

	// Catches: appending an ACP echo to the promptSent bubble doubles the user's text.
	it("shows a sent prompt once when ego echoes it in chunks", () => {
		acpTranscript.applyFrame(frame({ kind: "promptSent", text: "Diagnose connection" }));
		acpTranscript.applyFrame(update({ sessionUpdate: "user_message_chunk", content: text("Diagnose ") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "user_message_chunk", content: text("connection") }));
		expect(acpTranscript.entries(SESSION).filter((entry) => entry.kind === "user")).toEqual([
			{ id: "e1", kind: "user", text: "Diagnose connection" },
		]);
	});

	// Catches: suppressing a changed echo just because it starts like the sent prompt.
	it("shows a changed echo once when ego rewrites the sent prompt", () => {
		acpTranscript.applyFrame(frame({ kind: "promptSent", text: "Diagnose connection" }));
		acpTranscript.applyFrame(update({ sessionUpdate: "user_message_chunk", content: text("Diagnose ") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "user_message_chunk", content: text("network") }));
		expect(acpTranscript.entries(SESSION).filter((entry) => entry.kind === "user")).toEqual([
			{ id: "e1", kind: "user", text: "Diagnose network" },
		]);
	});

	// A turn streams one chunk at a time. Kept apart they render as one bubble
	// per word; joined at render time the grouping is re-derived every frame.
	it("joins consecutive chunks of the same kind into one message", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("one ") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("two") }));

		expect(acpTranscript.entries(SESSION)).toEqual([{ id: "e1", kind: "agent", text: "one two" }]);
	});

	// Thinking is not the answer. Merging the two would put reasoning into the
	// message a person quotes back.
	it("keeps thoughts apart from the answer", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_thought_chunk", content: text("hmm") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("hello") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_thought_chunk", content: text("more") }));

		expect(acpTranscript.entries(SESSION).map((e) => e.kind)).toEqual(["thought", "agent", "thought"]);
	});

	// An image or an embedded resource carries no text. Rendering its JSON
	// instead would put a wall of base64 in the conversation.
	it("ignores a content block that carries no text", () => {
		acpTranscript.applyFrame(
			update({ sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" } }),
		);

		expect(acpTranscript.entries(SESSION)).toEqual([]);
	});

	it("files each session's conversation under its own id", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("here") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("there") }, OTHER));

		expect(acpTranscript.entries(SESSION)).toHaveLength(1);
		expect(acpTranscript.entries(OTHER)).toHaveLength(1);
	});

	// A connection-level frame belongs to no conversation. Filing it under one
	// would need a session id this frame does not have.
	it("drops a frame that names no session", () => {
		acpTranscript.applyFrame(frame({ kind: "connectionState", state: "failed" }, null));

		expect(acpTranscript.entries(SESSION)).toEqual([]);
	});
});

describe("acpTranscript: tool calls", () => {
	// One call is one card. A second card per update would show a file being
	// read three times because it was reported pending, running and done.
	it("folds updates into the card the call opened", () => {
		acpTranscript.applyFrame(
			update({
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "Read AGENTS.md",
				kind: "read",
				status: "pending",
			}),
		);
		acpTranscript.applyFrame(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));

		const entries = acpTranscript.entries(SESSION);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ kind: "tool", call: { title: "Read AGENTS.md", status: "completed" } });
	});

	// An update names only what changed, so copying its absent fields over
	// would erase the title and the locations the first frame carried.
	it("keeps what an update did not mention", () => {
		acpTranscript.applyFrame(
			update({
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "Edit src/main.rs",
				locations: [{ path: "src/main.rs", line: 4 }],
			}),
		);
		acpTranscript.applyFrame(update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" }));

		expect(acpTranscript.entries(SESSION)[0]).toMatchObject({
			call: { title: "Edit src/main.rs", locations: [{ path: "src/main.rs", line: 4 }], status: "failed" },
		});
	});

	// A session attached mid-flight replays updates for calls that started
	// before this client was listening. Dropping them would leave the work
	// invisible; an untitled card at least says something ran.
	it("shows an update for a call it never saw open", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "tool_call_update", toolCallId: "t9", status: "in_progress" }));

		expect(acpTranscript.entries(SESSION)[0]).toMatchObject({ kind: "tool", call: { toolCallId: "t9", title: "t9" } });
	});
});

describe("acpTranscript: the plan", () => {
	// The agent sends the whole plan every time and the client replaces its
	// copy. Appending would show every intermediate version of the list.
	it("replaces the plan rather than appending another one", () => {
		acpTranscript.applyFrame(
			update({ sessionUpdate: "plan", entries: [{ content: "one", priority: "high", status: "pending" }] }),
		);
		acpTranscript.applyFrame(
			update({
				sessionUpdate: "plan",
				entries: [
					{ content: "one", priority: "high", status: "completed" },
					{ content: "two", priority: "low", status: "pending" },
				],
			}),
		);

		const plans = acpTranscript.entries(SESSION).filter((e) => e.kind === "plan");
		expect(plans).toHaveLength(1);
		expect(plans[0]).toMatchObject({ entries: [{ status: "completed" }, { content: "two" }] });
	});
});

describe("acpTranscript: how a turn ended", () => {
	it("does not treat a previous answer as a reply to the next empty turn", () => {
		acpTranscript.applyFrame(frame({ kind: "promptSent", text: "first" }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("done") }));
		acpTranscript.applyFrame(frame({ kind: "turnSettled", stopReason: "end_turn", usage: null }));
		acpTranscript.applyFrame(frame({ kind: "promptSent", text: "second" }));
		acpTranscript.applyFrame(frame({ kind: "turnSettled", stopReason: "end_turn", usage: null }));
		expect(acpTranscript.entries(SESSION).at(-1)).toMatchObject({ kind: "settled", stopReason: "empty" });
	});

	// A finished answer needs no marker — the answer is the marker.
	it("says nothing when a turn ended normally", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("done") }));
		acpTranscript.applyFrame(frame({ kind: "turnSettled", stopReason: "end_turn", usage: null }));

		expect(acpTranscript.entries(SESSION).map((e) => e.kind)).toEqual(["agent"]);
	});

	// Cancelled, refused or out of room all end the turn without answering, and
	// a transcript that just stops there reads as the agent falling silent.
	it("records a turn that ended without answering", () => {
		acpTranscript.applyFrame(frame({ kind: "turnSettled", stopReason: "cancelled", usage: null }));

		expect(acpTranscript.entries(SESSION)).toEqual([{ id: "e1", kind: "settled", stopReason: "cancelled" }]);
	});
});

describe("acpTranscript: starting over", () => {
	// `session/load` replays the whole history. Without clearing, the replay
	// lands under what is already there and every message appears twice.
	it("drops one session's history and leaves the others", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("old") }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("kept") }, OTHER));
		acpTranscript.clear(SESSION);

		expect(acpTranscript.entries(SESSION)).toEqual([]);
		expect(acpTranscript.entries(OTHER)).toHaveLength(1);
	});

	// What a person typed shows immediately, before any frame comes back.
	it("holds the message the user sent", () => {
		acpTranscript.noteUserMessage(SESSION, "hello");

		expect(acpTranscript.entries(SESSION)).toEqual([{ id: "e1", kind: "user", text: "hello" }]);
	});
});

describe("acpTranscript: ego notice cards", () => {
	const card = (action: unknown, body = "Worker finished: RESULT") => ({
		sessionUpdate: "agent_message_chunk",
		messageId: "result-42",
		content: text(body),
		_meta: { ego: { salience: "card", action } },
	});

	// Catches: out-of-turn updates dropped, or a card glued onto the previous reply.
	it("folds a notice that arrives after the turn settled as its own entry, in arrival order", () => {
		acpTranscript.applyFrame(frame({ kind: "turnStarted" }));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("Done.") }));
		acpTranscript.applyFrame(frame({ kind: "turnSettled", stopReason: "end_turn", usage: null }));
		acpTranscript.applyFrame(update(card({ kind: "open_result", path: "/w/results/worker.md" })));
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("Next turn.") }));
		expect(acpTranscript.entries(SESSION)).toEqual([
			{ id: "e1", kind: "agent", text: "Done." },
			{
				id: "e2",
				kind: "notice",
				text: "Worker finished: RESULT",
				action: { kind: "open_result", path: "/w/results/worker.md" },
			},
			{ id: "e3", kind: "agent", text: "Next turn." },
		]);
	});

	// Catches: answer/approve payloads lost, or an unknown action producing a dead button.
	it("reads the answer and approve payloads and drops an action it does not know", () => {
		acpTranscript.applyFrame(update(card({ kind: "answer", question_id: "q1" })));
		acpTranscript.applyFrame(update(card({ kind: "approve", request_id: "r1" })));
		acpTranscript.applyFrame(update(card({ kind: "teleport" })));
		acpTranscript.applyFrame(update(card({ kind: "open_result" })));
		expect(acpTranscript.entries(SESSION).map((entry) => (entry.kind === "notice" ? entry.action : "x"))).toEqual([
			{ kind: "answer", questionId: "q1" },
			{ kind: "approve", requestId: "r1" },
			undefined,
			undefined,
		]);
	});

	// Catches: breaking non-ego or older ego sessions by treating every message as a card.
	it("renders an update without _meta, or with another salience, as ordinary agent text", () => {
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", content: text("plain ") }));
		acpTranscript.applyFrame(
			update({
				sessionUpdate: "agent_message_chunk",
				content: text("text"),
				_meta: { ego: { salience: "activity" } },
			}),
		);
		expect(acpTranscript.entries(SESSION)).toEqual([{ id: "e1", kind: "agent", text: "plain text" }]);
	});
});

// Catches: durable message IDs discarded or separate replies merged, making a mid-history fork target the tip.
it("keeps durable message IDs across chunks and separate replies", () => {
	for (const [messageId, body] of [
		["reply-one", "first "],
		["reply-one", "reply"],
		["reply-two", "second reply"],
	])
		acpTranscript.applyFrame(update({ sessionUpdate: "agent_message_chunk", messageId, content: text(body) }));
	expect(
		acpTranscript
			.entries(SESSION)
			.map((entry) => ({ messageId: entry.messageId, text: "text" in entry ? entry.text : "" })),
	).toEqual([
		{ messageId: "reply-one", text: "first reply" },
		{ messageId: "reply-two", text: "second reply" },
	]);
});

// Catches: replay origin discarded or inherited and local chunks glued into one reply.
it("keeps inherited replay separate from the child's own reply", () => {
	acpTranscript.applyFrame(
		update({
			sessionUpdate: "agent_message_chunk",
			messageId: "parent",
			content: text("Inherited"),
			_meta: { ego: { inherited: true } },
		}),
	);
	acpTranscript.applyFrame(
		update({ sessionUpdate: "agent_message_chunk", messageId: "child", content: text("Local") }),
	);
	expect(acpTranscript.entries(SESSION)).toEqual([
		expect.objectContaining({ kind: "agent", text: "Inherited", messageId: "parent", inherited: true }),
		expect.objectContaining({ kind: "agent", text: "Local", messageId: "child" }),
	]);
	expect(acpTranscript.entries(SESSION)[1].inherited).toBeUndefined();
});
