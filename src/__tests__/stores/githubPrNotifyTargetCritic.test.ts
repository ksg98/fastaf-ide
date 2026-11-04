import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { listen as tauriListen } from "@tauri-apps/api/event";
import type { BranchPrStatus } from "../../types";
import { testInScope } from "../helpers/store";
import { mockInvoke } from "../mocks/tauri";

const notifyPrTransition = vi.fn();
const mockListen = tauriListen as ReturnType<typeof vi.fn>;
const handlers = new Map<string, ((event: { payload: unknown }) => void)[]>();

function row(overrides: Partial<BranchPrStatus>): BranchPrStatus {
	return {
		branch: "feature/x",
		number: 5,
		title: "Old PR",
		state: "MERGED",
		url: "https://github.com/org/repo/pull/5",
		additions: 1,
		deletions: 1,
		checks: { passed: 0, failed: 0, pending: 0, total: 0 },
		check_details: [],
		author: "u",
		commits: 1,
		mergeable: "MERGEABLE",
		conflict_state: "clear",
		merge_state_status: "CLEAN",
		review_decision: "",
		viewer_did_approve: false,
		labels: [],
		is_draft: false,
		base_ref_name: "main",
		head_ref_oid: "abc",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		merge_state_label: null,
		review_state_label: null,
		merge_commit_allowed: true,
		squash_merge_allowed: true,
		rebase_merge_allowed: true,
		...overrides,
	} as BranchPrStatus;
}

describe("PR transition notification target (critic)", () => {
	let store: typeof import("../../stores/github").githubStore;

	beforeEach(async () => {
		vi.resetModules();
		handlers.clear();
		notifyPrTransition.mockClear();
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		mockListen.mockImplementation((event: string, handler: (event: { payload: unknown }) => void) => {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
			return Promise.resolve(vi.fn());
		});
		vi.doMock("../../services/prNativeNotifications", () => ({ notifyPrTransition }));
		vi.doMock("../../stores/repositories", () => ({
			repositoriesStore: { getPaths: () => ["/r"], getActivePaths: () => ["/r"], get: () => ({ displayName: "Repo" }) },
		}));
		vi.doMock("../../stores/settings", () => ({
			settingsStore: { state: { issueFilter: "assigned" }, setIssueFilter: vi.fn() },
		}));
		store = (await import("../../stores/github")).githubStore;
	});

	// Catches: the click URL is read from the store row that still holds the PREVIOUS PR of the
	// branch (poller keys by branch; a reused branch carries a new PR number), so the OS
	// notification for PR #9 opens PR #5 on GitHub.
	it("never pairs a transition's PR number with the URL of a different PR", () => {
		testInScope(() => {
			store.updateRepoData("/r", [row({ number: 5, url: "https://github.com/org/repo/pull/5" })]);
			store.startPolling();
		});
		expect(handlers.get("github-transition")?.length).toBeGreaterThan(0);
		for (const h of handlers.get("github-transition") ?? []) {
			h({ payload: { type: "ci_failed", repo_path: "/r", branch: "feature/x", pr_number: 9, title: "New PR" } });
		}
		for (const call of notifyPrTransition.mock.calls) {
			expect(call[0].url).toMatch(/\/pull\/9$/);
		}
	});
});

afterEach(async () => {
	const { prNotificationsStore } = await import("../../stores/prNotifications");
	prNotificationsStore.stopFocusTimer();
	prNotificationsStore.clearAll();
});
