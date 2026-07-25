import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

const mockGithubStore = vi.hoisted(() => ({
	getBranchPrData: vi.fn(),
	getCheckSummary: vi.fn(() => null),
	getCheckDetails: vi.fn(() => []),
	loadCheckDetails: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../stores/github", () => ({ githubStore: mockGithubStore }));

import { PrDetailContent } from "../../components/PrDetailPopover/PrDetailContent";

const basePr = {
	number: 42,
	state: "OPEN",
	branch: "feature",
	base_ref_name: "main",
	author: "boss",
	commits: 1,
	additions: 10,
	deletions: 2,
	labels: [],
	mergeable: "MERGEABLE",
	merge_state_label: null,
	review_state_label: null,
	created_at: null,
	updated_at: null,
};

const cleanFile = (path: string) => ({
	path,
	relevance: "medium",
	category: "business-logic",
	risk: "behavioral-change",
	summary: "changed stuff",
	findings: [],
	source: "llm",
	additions: 5,
	deletions: 1,
});

describe("PrDetailContent — AI review result metadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGithubStore.getBranchPrData.mockReturnValue(basePr);
		mockGithubStore.getCheckSummary.mockReturnValue(null);
		mockGithubStore.getCheckDetails.mockReturnValue([]);
	});

	it("shows reviewed-files count and model when the review returns no findings", async () => {
		mockInvoke.mockResolvedValue({
			summary: "Two clean refactors, nothing risky.",
			files: [cleanFile("src/a.ts"), cleanFile("src/b.ts")],
			llm_used: true,
			llm_model: "claude-sonnet-5",
		});
		const { getByText, findByText } = render(() => <PrDetailContent repoPath="/repo" branch="feature" />);
		fireEvent.click(getByText("Run"));

		// Proof-of-work line: file count + model, not just a bare "No findings".
		await findByText(/2 files/);
		expect(getByText(/claude-sonnet-5/)).toBeTruthy();
		expect(getByText("Two clean refactors, nothing risky.")).toBeTruthy();
		expect(getByText("No findings")).toBeTruthy();
	});

	it("labels heuristic-only reviews instead of showing a model name", async () => {
		mockInvoke.mockResolvedValue({
			summary: "Reviewed 1 file",
			files: [cleanFile("pnpm-lock.yaml")],
			llm_used: false,
			llm_model: null,
		});
		const { getByText, findByText } = render(() => <PrDetailContent repoPath="/repo" branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText(/1 file reviewed/);
		expect(getByText(/heuristics/)).toBeTruthy();
	});

	it("shows the error and no metadata when the review invoke fails", async () => {
		mockInvoke.mockRejectedValue(new Error("model unavailable"));
		const { getByText, findByText, queryByText } = render(() => <PrDetailContent repoPath="/repo" branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText(/model unavailable/);
		expect(queryByText("No findings")).toBeNull();
	});

	it("still lists findings with checkboxes when the review has findings", async () => {
		const fileWithFinding = {
			...cleanFile("src/bug.ts"),
			findings: [
				{
					path: "src/bug.ts",
					line: 7,
					hunk: null,
					severity: "bug",
					message: "Null deref on empty input",
					confidence: 0.9,
				},
			],
		};
		mockInvoke.mockResolvedValue({
			summary: "One bug found.",
			files: [fileWithFinding],
			llm_used: true,
			llm_model: "claude-sonnet-5",
		});
		const { getByText, findByText, queryByText } = render(() => <PrDetailContent repoPath="/repo" branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText("Null deref on empty input");
		await waitFor(() => expect(queryByText("No findings")).toBeNull());
	});
});
