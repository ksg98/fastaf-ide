import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckDetail } from "../../types";
import { mockInvoke } from "../mocks/tauri";

const mockGithubStore = vi.hoisted(() => ({
	getBranchPrData: vi.fn(),
	getCheckSummary: vi.fn(() => null),
	getCheckDetails: vi.fn((): CheckDetail[] => []),
	loadCheckDetails: vi.fn(() => Promise.resolve()),
}));
const mockRpc = vi.hoisted(() =>
	vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(async () => undefined),
);
const mockOpenUrl = vi.hoisted(() => vi.fn());

vi.mock("../../stores/github", () => ({ githubStore: mockGithubStore }));
vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: mockRpc,
}));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mockOpenUrl }));

import { PrDetailContent } from "../../components/PrDetailPopover/PrDetailContent";

const basePr = {
	number: 42,
	head_ref_oid: "a".repeat(40),
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

const cleanFile = (path: string) => ({ path, summary: "changed stuff", findings: [] });

// prReviewStore is a module singleton keyed by repo+PR, so each test uses its
// own repo path — otherwise a later test reads the previous one's result. It is
// read into a const first: Solid props are getters, so calling nextRepo()
// inside the JSX would hand the component a different repo on every read.
let repoSeq = 0;
const nextRepo = () => `/repo-${++repoSeq}`;

beforeEach(() => {
	// Catches: isolated error tests logging through an undefined RPC return,
	// or inheriting a previous test's command-specific response.
	mockRpc.mockReset();
});

// FastAF reviews PRs with its own engine (not ego). The result carries no model
// name, so the meta line is the reviewed-file count.
describe("PrDetailContent — AI review result metadata", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGithubStore.getBranchPrData.mockReturnValue(basePr);
		mockGithubStore.getCheckSummary.mockReturnValue(null);
		mockGithubStore.getCheckDetails.mockReturnValue([]);
	});

	it("shows the reviewed-files count when the review returns no findings", async () => {
		mockInvoke.mockResolvedValue({
			repo_path: "/repo",
			pr_number: 42,
			head_sha: "abc",
			summary: "Two clean refactors, nothing risky.",
			files: [cleanFile("src/a.ts"), cleanFile("src/b.ts")],
		});
		const repo = nextRepo();
		const { getByText, findByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Run"));

		// Proof-of-work line: the file count, not just a bare "No findings".
		await findByText(/2 files reviewed/);
		expect(getByText("Two clean refactors, nothing risky.")).toBeTruthy();
		expect(getByText("No findings")).toBeTruthy();
	});

	it("fetches and renders a failed CircleCI check log without opening its URL", async () => {
		mockGithubStore.getCheckDetails.mockReturnValue([
			{ context: "ci/circleci: test", state: "failure", html_url: "https://circleci.com/gh/acme/widget/42" },
		]);
		mockRpc.mockResolvedValue("\u001b[31mfailed step\u001b[0m");
		const repo = nextRepo();
		const { getByText, findByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Log"));
		expect(mockRpc).toHaveBeenCalledWith("fetch_ci_failure_logs", {
			repoPath: repo,
			branch: "feature",
			checkUrl: "https://circleci.com/gh/acme/widget/42",
			headSha: "a".repeat(40),
		});
		expect(await findByText("failed step")).toBeTruthy();
	});

	it("offers a Log toggle only on failed CircleCI rows", () => {
		mockGithubStore.getCheckDetails.mockReturnValue([
			{ context: "ci/circleci: lint", state: "success", html_url: "https://circleci.com/gh/acme/widget/41" },
			{ context: "build", state: "failure", html_url: "https://github.com/acme/widget/actions/runs/7" },
			{ context: "ci/circleci: test", state: "failure", html_url: "https://circleci.com/gh/acme/widget/42" },
		]);
		const repo = nextRepo();
		const { getAllByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		expect(getAllByText("Log")).toHaveLength(1);
	});

	it("fetches a CircleCI log once and reuses it when the row is reopened", async () => {
		mockGithubStore.getCheckDetails.mockReturnValue([
			{ context: "ci/circleci: test", state: "failure", html_url: "https://circleci.com/gh/acme/widget/42" },
		]);
		mockRpc.mockResolvedValue("failed step");
		const repo = nextRepo();
		const { getByText, findByText, queryByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Log"));
		expect(await findByText("failed step")).toBeTruthy();
		fireEvent.click(getByText("Log"));
		expect(queryByText("failed step")).toBeNull();
		fireEvent.click(getByText("Log"));
		expect(await findByText("failed step")).toBeTruthy();
		expect(mockRpc.mock.calls.filter(([command]) => command === "fetch_ci_failure_logs")).toHaveLength(1);
	});

	it.each(["Enter", " "])("keeps %s on the CircleCI Log button from opening the check URL", (key) => {
		mockGithubStore.getCheckDetails.mockReturnValue([
			{ context: "ci/circleci: test", state: "failure", html_url: "https://circleci.com/gh/acme/widget/42" },
		]);
		const { getByText } = render(() => <PrDetailContent repoPath={nextRepo()} branch="feature" />);
		fireEvent.keyDown(getByText("Log"), { key });
		expect(mockRpc).not.toHaveBeenCalled();
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});

	it("does not pluralise a single reviewed file", async () => {
		mockInvoke.mockResolvedValue({
			repo_path: "/repo",
			pr_number: 42,
			head_sha: "abc",
			summary: "Reviewed 1 file",
			files: [cleanFile("pnpm-lock.yaml")],
		});
		const repo = nextRepo();
		const { getByText, findByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText(/1 file reviewed/);
	});

	it("shows the engine's own error and no metadata when the review fails", async () => {
		// The reason is actionable, "review failed" is not, and an empty finding
		// list would be a silent lie.
		mockInvoke.mockRejectedValue(new Error("model unavailable"));
		const repo = nextRepo();
		const { getByText, findByText, queryByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText(/model unavailable/);
		expect(queryByText("No findings")).toBeNull();
		expect(queryByText(/reviewed/)).toBeNull();
	});

	it("still lists findings with checkboxes when the review has findings", async () => {
		const fileWithFinding = {
			path: "src/bug.ts",
			summary: "changed stuff",
			findings: [
				{
					path: "src/bug.ts",
					line: 7,
					hunk: null,
					severity: "bug",
					confidence: 0.9,
					message: "Null deref on empty input",
				},
			],
		};
		mockInvoke.mockResolvedValue({
			repo_path: "/repo",
			pr_number: 42,
			head_sha: "abc",
			summary: "One bug found.",
			files: [fileWithFinding],
		});
		const repo = nextRepo();
		const { getByText, findByText, queryByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText("Null deref on empty input");
		await waitFor(() => expect(queryByText("No findings")).toBeNull());
		expect(getByText("Post review")).toBeTruthy();
	});

	it("leaves a file-level finding visible but unselectable — GitHub needs a line", async () => {
		mockInvoke.mockResolvedValue({
			repo_path: "/repo",
			pr_number: 42,
			head_sha: "abc",
			summary: "One file-level note.",
			files: [
				{
					path: "src/wide.ts",
					summary: "changed stuff",
					findings: [
						{
							path: "src/wide.ts",
							line: null,
							hunk: null,
							severity: "risk",
							confidence: 0.8,
							message: "This module has no tests at all",
						},
					],
				},
			],
		});
		const repo = nextRepo();
		const { container, getByText, findByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		fireEvent.click(getByText("Run"));

		await findByText("This module has no tests at all");
		const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(checkbox.disabled).toBe(true);
		// Pre-selected but not postable, so the post button stays out of reach.
		expect((getByText("Post review") as HTMLButtonElement).disabled).toBe(true);
	});
});

describe("PrDetailContent — readiness and unresolved threads", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGithubStore.getCheckSummary.mockReturnValue(null);
		mockGithubStore.getCheckDetails.mockReturnValue([]);
	});

	it("says why an approved PR is not ready and splits the threads by bot and human", async () => {
		// Bug caught: the panel showed no reason for a PR held back by open review threads.
		mockGithubStore.getBranchPrData.mockReturnValue({
			...basePr,
			conflict_state: "clear",
			review_decision: "APPROVED",
			unresolved_threads: 3,
			unresolved_threads_truncated: false,
		});
		mockRpc.mockImplementation(async (cmd: string) =>
			cmd === "get_pr_review_threads" ? { bot: 2, human: 1, ego: 1 } : null,
		);
		const repo = nextRepo();
		const { container, findByText } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		expect(container.querySelector("[data-readiness]")?.getAttribute("data-readiness")).toBe("unresolved-comments");
		// FastAF has no ego: a thread the backend attributes to ego counts as a bot's.
		expect(await findByText("1 human, 3 bot unresolved threads")).toBeTruthy();
		expect(mockRpc).toHaveBeenCalledWith("get_pr_review_threads", { path: repo, prNumber: 42 });
	});

	it("does not query review threads when there are none", () => {
		// Bug caught: paying one GraphQL point per panel open on every PR.
		mockGithubStore.getBranchPrData.mockReturnValue({
			...basePr,
			conflict_state: "clear",
			review_decision: "APPROVED",
			unresolved_threads: 0,
			unresolved_threads_truncated: false,
		});
		const repo = nextRepo();
		const { container } = render(() => <PrDetailContent repoPath={repo} branch="feature" />);
		expect(container.querySelector("[data-readiness]")?.getAttribute("data-readiness")).toBe("ready");
		expect(mockRpc).not.toHaveBeenCalledWith("get_pr_review_threads", expect.anything());
	});
});
