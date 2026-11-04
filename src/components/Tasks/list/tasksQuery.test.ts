import { describe, expect, it, vi } from "vitest";
import { createTasksQuery } from "../../../stores/tasksQuery";
import type { WorkItem, WorkItemPage, WorkItemQuery } from "../../../types/work-items.gen";

const query: WorkItemQuery = {
	filters: [],
	savedFilterId: null,
	search: "",
	sort: null,
	groupBy: null,
	cursor: null,
	limit: 100,
};
function item(id: string, accountId = "a"): WorkItem {
	return {
		reference: { providerId: "demo", accountId, id },
		key: id,
		title: id,
		itemType: "issue",
		state: { id: "open", name: "Open", tone: "info" },
		assignees: [],
		labels: [],
		updatedAt: "2026-10-10",
		url: "https://example.test",
		fields: {},
	};
}
function deferred() {
	let resolve: (page: WorkItemPage) => void = () => {
		throw new Error("not initialized");
	};
	const promise = new Promise<WorkItemPage>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function source(accountId: string, list: (q: WorkItemQuery) => Promise<WorkItemPage>) {
	return {
		providerId: "demo",
		accountId,
		list,
		grouped: async () => {
			throw new Error("Grouping not used by this source");
		},
	};
}

describe("Tasks query consumer", () => {
	// Catches: an older search response replaces the latest search rows.
	it("stale_response_never_overwrites_newer_query", async () => {
		const old = deferred();
		const recent = deferred();
		const provider = source("a", (q) => (q.search === "old" ? old.promise : recent.promise));
		const model = createTasksQuery();
		const first = model.select(provider, { ...query, search: "old" });
		const second = model.select(provider, { ...query, search: "new" });
		recent.resolve({ items: [item("new")], nextCursor: null });
		await second;
		old.resolve({ items: [item("old")], nextCursor: null });
		await first;
		expect(model.state().items.map((row) => row.key)).toEqual(["new"]);
	});

	// Catches: cache keys omit the account or old-account rows survive a failed switch.
	it("cache_is_partitioned_by_account", async () => {
		const model = createTasksQuery();
		await model.select(
			source("a", async () => ({ items: [item("A")], nextCursor: null })),
			query,
		);
		await model.select(
			source("b", async () => {
				throw new Error("offline");
			}),
			query,
		);
		expect(model.state().items).toEqual([]);
		await model.select(
			source("b", async () => ({ items: [item("B", "b")], nextCursor: null })),
			query,
		);
		expect(model.state().items.map((row) => row.key)).toEqual(["B"]);
	});

	// Catches: a repeated provider cursor appends duplicate rows or loops forever.
	it("next_page_appends_without_duplicates", async () => {
		const model = createTasksQuery();
		await model.select(
			source("a", async (q) =>
				q.cursor === null
					? { items: [item("one")], nextCursor: "page2" }
					: { items: [item("one"), item("two")], nextCursor: "page2" },
			),
			query,
		);
		await model.loadMore();
		expect(model.state().items.map((row) => row.key)).toEqual(["one", "two"]);
		expect(model.state().nextCursor).toBeNull();
	});

	// Catches: refreshing page one reuses obsolete cached rows from later pages.
	it("refresh_invalidates_cached_later_pages", async () => {
		const model = createTasksQuery();
		let title = "Old second page";
		const provider = source("a", async (request) =>
			request.cursor
				? { items: [{ ...item("two"), title }], nextCursor: null }
				: { items: [item("one")], nextCursor: "page2" },
		);
		await model.select(provider, query);
		await model.loadMore();
		title = "Updated second page";
		await model.refresh();
		await model.loadMore();
		expect(model.state().items.map((row) => row.title)).toEqual(["one", "Updated second page"]);
	});

	// Catches: refresh failure silently discards rows or presents cached data as fresh.
	it("failed_refresh_retains_rows_marked_stale", async () => {
		const model = createTasksQuery();
		let fail = false;
		const provider = source("a", async () => {
			if (fail) throw new Error("offline");
			return { items: [item("one")], nextCursor: null };
		});
		await model.select(provider, query);
		fail = true;
		await model.refresh();
		expect(model.state().items.map((row) => row.key)).toEqual(["one"]);
		expect(model.state().stale).toBe(true);
		expect(model.state().error).toBe("offline");
	});

	// Catches: the total of a previous source or page survives into a page that reports none.
	it("total_follows_the_latest_page_and_resets_when_unreported", async () => {
		const model = createTasksQuery();
		await model.select(
			source("a", async (q) =>
				q.cursor === null
					? { items: [item("one")], nextCursor: "page2", total: 2 }
					: { items: [item("two")], nextCursor: null, total: 2 },
			),
			query,
		);
		expect(model.state().total).toBe(2);
		await model.loadMore();
		expect(model.state().total).toBe(2);
		await model.select(
			source("b", async () => ({ items: [item("B", "b")], nextCursor: null })),
			query,
		);
		expect(model.state().total).toBeNull();
	});

	// Catches: the page cache grows without evicting the least recently used query.
	it("least_recent_query_is_evicted_at_capacity", async () => {
		const model = createTasksQuery({ maxCachedPages: 2 });
		let calls = 0;
		const provider = source("a", async (q) => {
			calls++;
			return { items: [item(q.search)], nextCursor: null };
		});
		for (const search of ["one", "two", "one", "three", "two"]) await model.select(provider, { ...query, search });
		expect(calls).toBe(4);
	});

	// Catches: grouped cursor pages replace earlier group members or fall back to locally inferred groups.
	it("grouped_pages_preserve_provider_labels_and_append_members", async () => {
		const model = createTasksQuery();
		const provider = {
			...source("a", async () => {
				throw new Error("List must not be used");
			}),
			grouped: async (q: WorkItemQuery) => ({
				groups: [{ id: "custom", name: "Provider group", items: q.cursor ? [item("two")] : [item("one")] }],
				nextCursor: q.cursor ? null : "second",
			}),
		};
		await model.select(provider, { ...query, groupBy: "state" });
		await model.loadMore();
		expect(model.state().groups).toHaveLength(1);
		expect(model.state().groups[0].name).toBe("Provider group");
		expect(model.state().groups[0].items.map((row) => row.key)).toEqual(["one", "two"]);
	});
});

// Catches: GitLab username controls are compared against unrelated numeric REST identities locally.
it("gitlab_username_filters_remain_in_server_mode", async () => {
	for (const fieldId of ["assignee", "author"]) {
		const filters = [
			{ fieldId: "type", values: [{ kind: "enum" as const, value: "merge_request" }] },
			{
				fieldId,
				values: [{ kind: "user" as const, value: [{ id: "dev", name: "dev", avatarUrl: null, bot: false }] }],
			},
		];
		// The row carries a numeric user id, as GitLab REST does, while the filter holds a username.
		const row = {
			...item("!1"),
			itemType: "merge_request",
			assignees: [{ id: "2", name: "dev", avatarUrl: null, bot: false }],
		};
		const list = vi.fn(async (_q: WorkItemQuery) => ({ items: [row], total: 1, nextCursor: null }));
		const provider = { ...source("local", list), providerId: "gitlab", fields: [] };
		const model = createTasksQuery();
		await model.select(provider, { ...query, filters });
		expect(model.state().error).toBeNull();
		expect(model.state().local).toBe(false);
		// One server request that carries the username filter; no local collection pass.
		expect(list).toHaveBeenCalledTimes(1);
		expect(list.mock.calls[0][0].filters).toEqual(filters);
		expect(model.state().items.map((entry) => entry.itemType)).toEqual(["merge_request"]);
		model.dispose();
	}
});
