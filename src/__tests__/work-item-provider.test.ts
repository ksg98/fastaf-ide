import { describe, expect, it } from "vitest";
import { createInMemoryWorkItemProvider } from "../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../plugins/testing/work-items-demo.gen";
import { createWorkItemProviderRegistry } from "../plugins/workItemProviderRegistry";
import type { WorkItemQuery, WorkItemRef } from "../types/work-items.gen";

const query = (limit = 50): WorkItemQuery => ({
	filters: [],
	savedFilterId: null,
	search: "",
	sort: null,
	groupBy: null,
	cursor: null,
	limit,
});
const reference: WorkItemRef = { providerId: "demo", accountId: "local", id: "1" };

describe("local work-item provider", () => {
	// Catches: cursors duplicate rows or cross query/account boundaries.
	it("paginates and rejects foreign items and changed queries", async () => {
		const provider = createInMemoryWorkItemProvider();
		const first = await provider.list(query(1));
		expect(first.items[0].key).toBe("DEMO-1");
		const second = await provider.list({ ...query(1), cursor: first.nextCursor });
		expect(second.items[0].key).toBe("DEMO-2");
		await expect(provider.list({ ...query(1), cursor: first.nextCursor, search: "transport" })).rejects.toThrow();
		await expect(provider.detail({ ...reference, accountId: "other" })).rejects.toThrow();
		await expect(provider.list(query(0))).rejects.toThrow();
	});
	// Catches: groups/lanes are guessed by UI or board edits never change source state.
	it("supplies grouping, legal moves and persistent board edits", async () => {
		const provider = createInMemoryWorkItemProvider();
		const board = await provider.board("priority", query());
		expect(board.lanes[0].cards.map((card) => card.item.key)).toEqual(["DEMO-1", "DEMO-3"]);
		expect(board.lanes[0].cards[0].moves.map((move) => move.columnId)).toEqual(["high", "low"]);
		await provider.act(reference, board.lanes[0].cards[0].moves[1].action);
		const groups = await provider.grouped({ ...query(), groupBy: "priority" });
		expect(groups.groups.map((group) => [group.name, group.items.length])).toEqual([
			["High", 1],
			["Low", 2],
		]);
	});
	// Catches: mutation after rejected fields or fake state leaking across instances.
	it("validates fields atomically and isolates instances and returned objects", async () => {
		const provider = createInMemoryWorkItemProvider();
		const original = await provider.detail(reference);
		await expect(
			provider.act(reference, {
				kind: "edit_field",
				value: { fieldId: "priority", value: { kind: "text", value: "bad" } },
			}),
		).rejects.toThrow();
		expect(await provider.detail(reference)).toEqual(original);
		original.item.title = "Changed outside provider";
		expect((await provider.detail(reference)).item.title).toBe("Fix terminal resize");
		await provider.act(reference, { kind: "transition", value: "closed" });
		expect((await provider.detail(reference)).item.state.id).toBe("closed");
		expect((await createInMemoryWorkItemProvider().detail(reference)).item.state.id).toBe("open");
	});
	// Catches: resolved threads/review summaries disappear, and aborted actions still mutate.
	it("preserves paginated rich comments and honors cancellation", async () => {
		const provider = createInMemoryWorkItemProvider();
		const first = await provider.comments(reference, null, 1);
		const second = await provider.comments(reference, first.nextCursor, 1);
		expect(second.entries[0]).toMatchObject({ kind: "review_thread", value: { resolved: true, commitId: "demo-sha" } });
		const third = await provider.comments(reference, second.nextCursor, 1);
		expect(third.entries[0].kind).toBe("review_summary");
		const controller = new AbortController();
		controller.abort();
		await expect(
			provider.act(reference, { kind: "comment", value: "Must not persist" }, controller.signal),
		).rejects.toThrow();
		expect((await provider.comments(reference, null, 50)).entries).toHaveLength(3);
	});
});

describe("work-item provider registry", () => {
	// Catches: accounts collide, duplicate providers silently replace ownership, or stale disposers delete a new registration.
	it("scopes accounts and disposes registrations exactly once", () => {
		const registry = createWorkItemProviderRegistry();
		const first = createInMemoryWorkItemProvider();
		const second = createInMemoryWorkItemProvider({ ...workItemsDemo, accountId: "other" });
		const disposable = registry.register(first);
		registry.register(second);
		expect(registry.list("demo")).toHaveLength(2);
		expect(registry.get("demo", "local")).toBe(first);
		expect(() => registry.register(first)).toThrow();
		disposable.dispose();
		registry.register(first);
		disposable.dispose();
		expect(registry.get("demo", "local")).toBe(first);
	});
});
