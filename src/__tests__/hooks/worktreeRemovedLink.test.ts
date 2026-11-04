import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemLink } from "../../types/workItemLinks";

const mockInvoke = vi.fn();
const mockListen = vi.fn();
const REPO = "/repo";

const link: WorkItemLink = {
	reference: { providerId: "jira", accountId: "me", id: "7" },
	key: "APP-7",
	title: "Fix login",
	url: "https://example.com/APP-7",
	state: null,
};

describe("worktree-removed and work-item links", () => {
	let handlers: Map<string, (event: { payload: unknown }) => void>;

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		handlers = new Map();
		mockInvoke
			.mockReset()
			.mockImplementation((command: string) =>
				Promise.resolve(command === "list_workitem_links" ? { [REPO]: { "feat/a": link, "feat/b": link } } : undefined),
			);
		mockListen.mockReset().mockImplementation((name: string, cb: (event: { payload: unknown }) => void) => {
			handlers.set(name, cb);
			return Promise.resolve(vi.fn());
		});
		localStorage.clear();
		vi.doMock("../../invoke", () => ({ invoke: mockInvoke, listen: mockListen }));
	});
	afterEach(() => vi.useRealTimers());

	// Catches: the backend drops the link of a removed worktree but the frontend mirror keeps it, so a task keeps its mark.
	it("forgets the link of the removed worktree and keeps the others", async () => {
		const { workItemLinksStore } = await import("../../stores/workItemLinks");
		const { repositoriesStore } = await import("../../stores/repositories");
		const { useWorktreeSwitchPrompt } = await import("../../hooks/useWorktreeSwitchPrompt");
		repositoriesStore._testSetHydrated(true);
		await workItemLinksStore.refresh();
		expect(workItemLinksStore.findByItem(link.reference)?.branch).toBeDefined();
		useWorktreeSwitchPrompt({ handleBranchSelect: vi.fn(), closeTerminalsForBranch: vi.fn() });
		await Promise.resolve();
		handlers.get("worktree-removed")?.({ payload: { repo_path: REPO, workspace_id: "w-a", branch: "feat/a" } });
		expect(workItemLinksStore.get(REPO, "feat/a")).toBeUndefined();
		expect(workItemLinksStore.get(REPO, "feat/b")).toEqual(link);
		repositoriesStore._testCancelPendingSave();
	});
});
