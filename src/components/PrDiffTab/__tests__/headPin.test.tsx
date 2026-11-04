import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../../../__tests__/mocks/tauri";

// happy-dom has no layout, so the real virtualizer mounts nothing: render every row.
vi.mock("@tanstack/solid-virtual", () => ({
	createVirtualizer: (opts: { count: number }) => ({
		getTotalSize: () => opts.count * 100,
		getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 100 })),
		measureElement: () => {},
	}),
}));

// DiffViewer measures text on a canvas, which happy-dom lacks.
vi.mock("../../ui/DiffViewer", async (orig) => ({
	...(await orig<typeof import("../../ui/DiffViewer")>()),
	DiffViewer: () => <div>diff body</div>,
}));

import { mdTabsStore } from "../../../stores/mdTabs";
import { MdTabContent } from "../../shared/MdTabContent";

const diffAt = (text: string) => `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+${text}`;

/** GitHub as the backend sees it: `head` is the PR head right now. */
function github(initialHead: string) {
	const state = { head: initialHead, submitted: [] as string[] };
	mockInvoke.mockReset();
	mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd === "get_pr_line_threads") return { headSha: state.head, threads: [], hasNextPage: false, endCursor: null };
		if (cmd === "submit_pr_draft_review") {
			const pinned = (args.draft as { headSha: string }).headSha;
			if (pinned !== state.head) throw new Error("review-head-changed: Refresh and review the new commits");
			state.submitted.push(pinned);
			return undefined;
		}
		return undefined;
	});
	return state;
}

const renderTab = (id: string) => render(() => <MdTabContent tab={mdTabsStore.get(id)!} onClose={() => {}} />);

async function submitSummary(view: ReturnType<typeof renderTab>) {
	const input = (await view.findByLabelText("Review summary")) as HTMLInputElement;
	fireEvent.input(input, { target: { value: "looks good" } });
	const button = view.getByText("Submit review") as HTMLButtonElement;
	if (!button.disabled) fireEvent.click(button);
	return button;
}

describe("PR review head pin (critic)", () => {
	beforeEach(() => {
		mdTabsStore.clearAll();
	});

	it("does not re-pin a remounted tab to a head its diff was never fetched at", async () => {
		// Catches: a remount (pane move, detach/reattach) creates a fresh session that pins
		// whatever head GitHub reports now, while the tab still shows the old diff string, so
		// line numbers of head A are submitted as comments on head B.
		const gh = github("A");
		const id = mdTabsStore.addPrDiff("/repo", 7, "t", diffAt("at-A"));
		const first = renderTab(id);
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_pr_line_threads", expect.anything()), {
			// The tab is lazy-loaded; the first import is slow on a loaded box.
			timeout: 10_000,
		});
		first.unmount();

		gh.head = "B"; // someone pushed while the tab was open
		const second = renderTab(id);
		await waitFor(() =>
			expect(mockInvoke.mock.calls.filter(([c]) => c === "get_pr_line_threads").length).toBeGreaterThan(1),
		);
		await submitSummary(second);
		await new Promise((r) => setTimeout(r, 0));
		expect(gh.submitted).toEqual([]);
	});

	it("re-enables the review after the user reopens the diff at the new head, as the alert tells them to", async () => {
		// Catches: reopening reuses the tab (addPrDiff only swaps `diff`), the session keeps the
		// stale pin and `headMoved`, so the advertised remedy never works and the tab is a dead end.
		const gh = github("A");
		const id = mdTabsStore.addPrDiff("/repo", 8, "t", diffAt("at-A"));
		const view = renderTab(id);
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledWith("get_pr_line_threads", expect.anything()));

		gh.head = "B";
		await submitSummary(view);
		await view.findByText(/Reopen the diff/);

		mdTabsStore.addPrDiff("/repo", 8, "t", diffAt("at-B")); // what the sidebar does on reopen
		await waitFor(() => expect(view.queryByText(/Reopen the diff/)).toBeNull());
		await submitSummary(view);
		await waitFor(() => expect(gh.submitted).toEqual(["B"]));
	});
});
