import { expect, it, vi } from "vitest";
import type { WorkItemLink, WorkItemLinks } from "../types/workItemLinks";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../invoke", () => ({ invoke }));
vi.mock("../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));

import { createWorkItemLinksStore } from "../stores/workItemLinks";

it("linking during initial load does not hide the other persisted worktree links", async () => {
	const existing: WorkItemLink = {
		reference: { providerId: "jira", accountId: "me", id: "7" },
		key: "APP-7",
		title: "Fix login",
		url: "https://example.com/APP-7",
		state: null,
	};
	const added: WorkItemLink = { ...existing, reference: { ...existing.reference, id: "8" }, key: "APP-8" };
	let finishLoad!: (value: WorkItemLinks) => void;
	invoke.mockImplementation((command: string) =>
		command === "list_workitem_links"
			? new Promise<WorkItemLinks>((resolve) => {
					finishLoad = resolve;
				})
			: Promise.resolve(),
	);
	const store = createWorkItemLinksStore();
	store.get("/repo", "feat/existing");
	const loading = store.refresh();
	await store.link("/repo", "feat/new", added);
	finishLoad({ "/repo": { "feat/existing": existing } });
	await loading;
	expect(store.get("/repo", "feat/existing"), "existing link vanished when another worktree was linked").toEqual(
		existing,
	);
	expect(store.get("/repo", "feat/new")).toEqual(added);
});
