import { describe, expect, it } from "vitest";
// Extension modules run directly in Chromium; no build step changes their state model.
import {
	addPick,
	deletePick,
	draftForTab,
	editPick,
	serverSession,
	// @ts-expect-error plain MV3 module
} from "../../../browser-extension/design-mode/cards.js";

describe("Design Mode drafts", () => {
	// Catches: editing/deleting one pick overwriting another tab's feedback.
	it("preserves comments and isolates picks by tab", () => {
		let draft = addPick({ picks: [] }, { id: "one", raw: { selector: "#first" } });
		draft = addPick(draft, { id: "two", raw: { selector: "#second" } });
		draft = editPick(draft, "one", "Use more spacing");
		expect(draft.picks.map((pick: { comment: string }) => pick.comment)).toEqual(["Use more spacing", ""]);
		expect(deletePick(draft, "two").picks).toEqual([
			expect.objectContaining({ id: "one", comment: "Use more spacing" }),
		]);
		expect(draftForTab({ "42": draft }, 43).picks).toEqual([]);
	});
	// Catches: unbounded collection exhausting storage and losing all drafts.
	it("refuses the thirty-third pick without losing existing comments", () => {
		let draft = { picks: [] };
		for (let n = 0; n < 32; n++) draft = addPick(draft, { id: String(n), raw: {} });
		expect(() => addPick(draft, { id: "overflow" })).toThrow("32 maximum");
		expect(draft.picks).toHaveLength(32);
	});
});

describe("Design Mode agent selection", () => {
	// Catches: ignoring the terminal that started Design Mode and selecting a different agent.
	it("selects the launching session, preserves a switch and reports an exited selection", async () => {
		// @ts-expect-error plain MV3 module
		const { recipient } = await import("../../../browser-extension/design-mode/cards.js");
		const agents = [
			{ sessionId: "Y", label: "Other" },
			{ sessionId: "X", label: "Launching" },
		];
		expect(recipient({ picks: [] }, agents, "X").selectedSessionId).toBe("X");
		expect(
			recipient({ picks: [], selectionInitialized: true, selectedSessionId: "Y", armedFor: "X" }, agents, "X")
				.selectedSessionId,
		).toBe("Y");
		const exited = recipient({ picks: [], selectionInitialized: true, selectedSessionId: "X" }, [agents[0]], "X");
		expect(exited.selectedSessionId).toBe("");
		expect(exited.agentNotice).toContain("exited");
		expect(recipient({ picks: [] }, agents).selectedSessionId).toBe("Y");
	});

	// Catches: the default recipient staying on the session bound at extension start after Boss starts Design Mode elsewhere.
	it("recipient_follows_newly_armed_session", async () => {
		// @ts-expect-error plain MV3 module
		const { recipient } = await import("../../../browser-extension/design-mode/cards.js");
		const agents = [
			{ sessionId: "X", label: "First starter" },
			{ sessionId: "Y", label: "Manual choice" },
			{ sessionId: "Z", label: "New starter" },
		];
		const chosen = { picks: [], selectionInitialized: true, selectedSessionId: "Y", armedFor: "X" };
		expect(recipient(chosen, agents, "Z")).toMatchObject({ selectedSessionId: "Z", armedFor: "Z" });
		// A draft from before armedFor existed adopts the armed session once.
		expect(
			recipient({ picks: [], selectionInitialized: true, selectedSessionId: "Y" }, agents, "X").selectedSessionId,
		).toBe("X");
		// An armed session not yet listed leaves the choice alone and is retried later.
		expect({ ...chosen, ...recipient(chosen, agents.slice(0, 2), "Q") }).toMatchObject({
			selectedSessionId: "Y",
			armedFor: "X",
		});
	});
});

describe("Shared Markdown and Design Mode recipients", () => {
	// Catches: offering shells or agents belonging to another repository.
	it("offers only same-repository live agent sessions in existing order", async () => {
		const { reviewAgents } = await import("../../../browser-extension/design-mode/reviewAgents.js");
		expect(
			reviewAgents(
				[
					{ sessionId: "shell", repoPath: "/repo", name: "Shell" },
					{ sessionId: "other", repoPath: "/other", agentType: "codex", name: "Other" },
					{ sessionId: "first", repoPath: "/repo", agentType: "claude", name: "First" },
					{ sessionId: "second", repoPath: "/repo", agentType: "codex", name: "Second" },
				],
				"/repo",
			),
		).toEqual([
			{ sessionId: "first", label: "First" },
			{ sessionId: "second", label: "Second" },
		]);
	});
});

describe("Design feedback delivery", () => {
	// Catches: failed or lost delivery replies discarding cards or retrying with another key.
	it("retains failed drafts, retries the same batch and shows queued acceptance", async () => {
		// @ts-expect-error plain MV3 module
		const { deliverDraft } = await import("../../../browser-extension/design-mode/cards.js");
		let stored = {
			selectedSessionId: "X",
			picks: [
				{ id: "one", comment: "More space", raw: {} },
				{ id: "two", comment: "", raw: {} },
			],
		};
		const save = async (value: typeof stored) => {
			stored = value;
		};
		await expect(
			deliverDraft(
				stored,
				async () => {
					throw new Error("Disconnected");
				},
				save,
				"batch-1",
			),
		).rejects.toThrow("Disconnected");
		expect(stored.picks).toHaveLength(2);
		const batches: unknown[] = [];
		const result = await deliverDraft(
			stored,
			async (batch: unknown) => {
				batches.push(batch);
				return { accepted: true, typed: false, queued: 1 };
			},
			save,
			"batch-2",
		);
		expect(batches).toEqual([expect.objectContaining({ idempotencyKey: "batch-1", sessionId: "X" })]);
		expect(result.typed).toBe(false);
		expect(stored.picks).toEqual([expect.objectContaining({ id: "two" })]);
	});
	// Catches: the dev-server list keyed to the launching session (binding.json) instead of the selected agent.
	it("lists servers for the agent selected in the dropdown, not the launcher", () => {
		const agents = [{ sessionId: "launcher" }, { sessionId: "B" }];
		const selected = { picks: [], selectedSessionId: "B", selectionInitialized: true, armedFor: "launcher" };
		expect(serverSession(selected, agents, "launcher")).toBe("B");
		expect(serverSession({ picks: [] }, agents, "launcher")).toBe("launcher");
		expect(serverSession({ ...selected, selectedSessionId: "gone" }, agents, "launcher")).toBe("");
	});
});

describe("Design Mode page errors", () => {
	const load = async () =>
		// @ts-expect-error plain MV3 module
		(await import("../../../browser-extension/design-mode/cards.js")) as Record<string, (...args: unknown[]) => never>;
	// Catches: duplicate or unbounded errors exhausting storage, and page-supplied fields being trusted.
	it("deduplicates by message and source, keeps the last 50 and re-validates fields", async () => {
		const { addError } = await load();
		let draft = addError({ picks: [] }, { kind: "error", message: "boom", source: "a.js" }, 1) as never as {
			errors: { message: string }[];
		};
		expect(
			(addError(draft, { kind: "error", message: "boom", source: "a.js" }, 2) as typeof draft).errors,
		).toHaveLength(1);
		expect(
			(addError(draft, { kind: "error", message: "boom", source: "b.js" }, 2) as typeof draft).errors,
		).toHaveLength(2);
		for (let n = 0; n < 60; n++) draft = addError(draft, { message: `m${n}` }, n) as typeof draft;
		expect(draft.errors).toHaveLength(50);
		expect(draft.errors.at(-1)?.message).toBe("m59");
		const hostile = (
			addError(
				{ picks: [] },
				{ kind: "<script>", message: "x".repeat(5000), line: -1, column: "7", stack: 5 },
				9,
			) as typeof draft
		).errors[0] as never as Record<string, unknown>;
		expect(hostile).toMatchObject({ kind: "error", line: undefined, column: undefined, stack: "", timestamp: 9 });
		expect((hostile.message as string).length).toBe(1024);
	});
	// Catches: errors-only send needing a commented pick; attach toggle ignored; sent errors resent or new ones lost.
	it("sends errors alone or attached and clears only the errors that were sent", async () => {
		const { addError, prepareSend, completeSend } = await load();
		const base = {
			selectedSessionId: "S",
			picks: [
				{ id: "p", comment: "Fix it", raw: {} },
				{ id: "q", comment: "", raw: {} },
			],
		};
		type Draft = Record<string, never>;
		const draft = addError(base, { message: "first" }, 1) as unknown as Draft;
		expect(() => prepareSend(base, "k")).not.toThrow();
		expect((prepareSend(draft, "k") as never as { pendingSend: { errors: unknown[] } }).pendingSend.errors).toEqual([]);
		const alone = prepareSend(draft, "k", true) as never as { pendingSend: { picks: unknown[]; errors: unknown[] } };
		expect(alone.pendingSend.picks).toEqual([]);
		expect(alone.pendingSend.errors).toHaveLength(1);
		const attached = prepareSend({ ...draft, attachErrors: true }, "k") as never as {
			pendingSend: { picks: unknown[]; errors: unknown[] };
		};
		expect(attached.pendingSend.picks).toHaveLength(1);
		expect(attached.pendingSend.errors).toHaveLength(1);
		expect(() => prepareSend({ selectedSessionId: "S", picks: [] }, "k", true)).toThrow("No page errors");
		// An error that arrives while the batch is in flight survives completion.
		const inflight = addError(alone, { message: "second" }, 2) as never as Draft;
		const done = completeSend(inflight) as never as { errors: { message: string }[]; picks: unknown[] };
		expect(done.errors.map((e) => e.message)).toEqual(["second"]);
		expect(done.picks).toHaveLength(2);
	});
});
