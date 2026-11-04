import { expect, it, vi } from "vitest";
import { allDemoRows, listDemo } from "../components/Tasks/list/demo";
import { initialTaskQuery } from "../components/Tasks/list/useTasksListQuery";
import type { WorkItem, WorkItemQuery } from "../types/work-items.gen";
import { collectLocalTasks } from "./tasksLocalQuery";

// Catches: provider rejects local title sort because collection forwards it, or stops at page one.
it("collects_120_items_without_forwarding_local_query_operations", async () => {
	const provider = listDemo(120);
	const list = provider.list.bind(provider);
	provider.list = vi.fn(async (query, signal) => {
		expect(query.sort).toBeNull();
		expect(query.groupBy).toBeNull();
		expect(query.filters).toEqual([]);
		return { ...(await list(query, signal)), total: 120 };
	});
	const items = await collectLocalTasks(
		provider,
		{ ...initialTaskQuery(), sort: { fieldId: "title", descending: true } },
		new AbortController().signal,
	);
	expect(items).toHaveLength(120);
	expect(provider.list).toHaveBeenCalledTimes(2);
});

// Catches: changed totals, duplicate-only pages, or a repeating cursor certify a partial list as complete.
it("refuses_inconsistent_or_nonterminal_collection", async () => {
	const seed = listDemo(2);
	const rows = await allDemoRows(seed);
	for (const scenario of ["changed", "repeat", "missing", "overfull"]) {
		let calls = 0;
		const provider = {
			...seed,
			list: async () => {
				calls++;
				if (scenario === "overfull") return { items: rows, total: 1, nextCursor: null };
				if (calls === 1) return { items: [rows[0]], total: 2, nextCursor: "next" };
				return {
					items: [rows[0]],
					total: scenario === "changed" ? 3 : 2,
					nextCursor: scenario === "repeat" ? "next" : null,
				};
			},
		};
		expect(await collectLocalTasks(provider, initialTaskQuery(), new AbortController().signal)).toBeNull();
		expect(calls).toBeLessThanOrEqual(2);
	}
});

// Catches: unknown totals are invented, or a large list triggers automatic full loading.
it("unknown_or_large_totals_keep_server_mode", async () => {
	const seed = listDemo(1);
	for (const total of [undefined, 1001]) {
		const list = vi.fn(async () => ({ items: [], total, nextCursor: "next" }));
		expect(await collectLocalTasks({ ...seed, list }, initialTaskQuery(), new AbortController().signal)).toBeNull();
		expect(list).toHaveBeenCalledTimes(1);
	}
});

/** A GitLab-shaped source: type and state pick the endpoint and scope, as the real provider's do. */
function gitlabSource() {
	const row = (id: string, itemType: string): WorkItem => ({
		reference: { providerId: "gitlab", accountId: "local", id },
		key: id,
		title: id,
		itemType,
		state: { id: "opened", name: "Open", tone: "info" },
		assignees: [],
		labels: [],
		updatedAt: "2026-10-10",
		url: "https://gitlab.example.invalid/review/demo",
		fields: {},
	});
	const list = vi.fn(async (query: WorkItemQuery) => {
		const type = query.filters.find((filter) => filter.fieldId === "type")?.values[0];
		const mergeRequests = type?.kind === "enum" && type.value === "merge_request";
		return { items: [mergeRequests ? row("!1", "merge_request") : row("#1", "issue")], total: 1, nextCursor: null };
	});
	return { providerId: "gitlab", fields: [], list };
}
const typeFilter = { fieldId: "type", values: [{ kind: "enum" as const, value: "merge_request" }] };
const stateFilter = { fieldId: "state", values: [{ kind: "enum" as const, value: "all" }] };
const labelFilter = { fieldId: "labels", values: [{ kind: "labels" as const, value: [{ id: "bug", name: "bug" }] }] };

// Catches: local collection clears the MR discriminator and certifies an issue-only scope instead.
it("local_collection_preserves_gitlab_merge_request_scope", async () => {
	const provider = gitlabSource();
	const rows = await collectLocalTasks(
		provider,
		{ ...initialTaskQuery(), filters: [typeFilter, labelFilter], sort: { fieldId: "title", descending: false } },
		new AbortController().signal,
	);
	expect(rows?.map((item) => item.itemType)).toEqual(["merge_request"]);
	// Only the endpoint-selecting filters travel; the rest is projected locally.
	expect(provider.list).toHaveBeenCalledWith(
		expect.objectContaining({ filters: [typeFilter], sort: null, groupBy: null, cursor: null, limit: 100 }),
		expect.anything(),
	);
});

// Catches: a saved preset losing its id, or state=all dropped so collection falls back to the opened scope.
it("gitlab_collection_preserves_state_and_preset_scope", async () => {
	const provider = gitlabSource();
	await collectLocalTasks(
		provider,
		{ ...initialTaskQuery(), savedFilterId: "assigned-mrs", filters: [typeFilter, stateFilter, labelFilter] },
		new AbortController().signal,
	);
	expect(provider.list).toHaveBeenCalledWith(
		expect.objectContaining({ savedFilterId: "assigned-mrs", filters: [typeFilter, stateFilter] }),
		expect.anything(),
	);
});
