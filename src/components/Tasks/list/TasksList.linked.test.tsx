import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listDemo } from "./demo";
import { TasksList } from "./TasksList";

const linkedIds = vi.hoisted(() => new Map<string, string>());
vi.mock("../../../stores/workItemLinks", () => ({
	workItemLinksStore: {
		findByItem: (reference: { id: string }) => {
			const branch = linkedIds.get(reference.id);
			return branch ? { repoPath: "/repo", branch, link: {} } : undefined;
		},
	},
}));

// happy-dom has no layout. Supply viewport geometry, keeping the real virtualizer.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	linkedIds.clear();
	linkedIds.set("2", "feat/two");
	linkedIds.set("3", "feat/three");
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("Tasks list worktree filter", () => {
	// Catches: the filter hides nothing, hides linked rows, or keeps its count after it is switched off.
	it("lists only tasks linked to a worktree while the filter is on", async () => {
		render(() => <TasksList providers={[listDemo(4)]} onOpen={() => {}} />);
		await screen.findByRole("button", { name: /Task 00004/ });
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));
		fireEvent.click(screen.getByLabelText("Linked to a worktree"));
		await waitFor(() => expect(screen.queryByRole("button", { name: /Task 00004/ })).not.toBeInTheDocument());
		expect(screen.queryByRole("button", { name: /Task 00001/ })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Task 00002/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Task 00003/ })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Filters (1)" })).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("Linked to a worktree"));
		await screen.findByRole("button", { name: /Task 00004/ });
		expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
	});
});
