import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import type { BranchPrStatus, GitHubIssue } from "../../types";

const ISSUES: GitHubIssue[] = [
	{ number: 11, title: "First issue", state: "OPEN", author: "a", url: "", labels: [], comments_count: 0 },
	{ number: 12, title: "Second issue", state: "OPEN", author: "b", url: "", labels: [], comments_count: 0 },
] as unknown as GitHubIssue[];

const PRS: BranchPrStatus[] = [
	{ number: 101, title: "First PR", branch: "feat/one", state: "OPEN" },
	{ number: 102, title: "Second PR", branch: "feat/two", state: "OPEN" },
] as unknown as BranchPrStatus[];

vi.mock("../../stores/github", () => ({
	githubStore: {
		state: { viewerLogin: null, issuesLoading: false, circuitBreakerOpen: false },
		getRepoIssues: () => ISSUES,
		pollIssues: vi.fn(),
		pollRepo: vi.fn(),
		setIssueFilter: vi.fn(),
	},
}));

vi.mock("../../stores/settings", () => ({
	settingsStore: {
		state: { issueFilter: "assigned", prHideDrafts: false, prHideConflicting: false, prHideCiFailing: false },
	},
}));

vi.mock("../../stores/repositories", () => ({
	repositoriesStore: { get: () => undefined, state: { repositories: {}, repoOrder: [] } },
}));

vi.mock("../../stores/repoSettings", () => ({
	repoSettingsStore: { getEffective: () => undefined, getOrCreate: vi.fn(), update: vi.fn() },
}));

vi.mock("../../stores/repoDefaults", () => ({ repoDefaultsStore: { state: { prMergeStrategy: "merge" } } }));
vi.mock("../../stores/mdTabs", () => ({ mdTabsStore: { addGithubOps: vi.fn(), addPrDiff: vi.fn() } }));

// Heavy leaf components — not under test here
vi.mock("../../components/IssueDetailPopover/IssueDetailContent", () => ({
	IssueDetailContent: (p: { children?: unknown }) => p.children,
}));
vi.mock("../../components/PrDetailPopover/PrDetailContent", () => ({
	PrDetailContent: (p: { children?: unknown }) => p.children,
}));
vi.mock("../../components/SmartButtonStrip/SmartButtonStrip", () => ({ SmartButtonStrip: () => null }));

import { GitHubPanel } from "../../components/Sidebar/GitHubPanel";
import { uiStore } from "../../stores/ui";

const baseProps = {
	prs: PRS,
	allPrs: PRS,
	repoPath: "/repo",
	onClose: vi.fn(),
	onCheckout: vi.fn(),
};

/** The panel renders through a Portal, so query the document, not the container. */
const panel = () => document.querySelector(".ghPanel") as HTMLElement;
const rows = () => Array.from(document.querySelectorAll(".ghItemRow"));
const activeRow = () => document.querySelector(".ghItemRowActive");
const rowText = (el: Element | null) => el?.textContent ?? "";

function resetCollapse() {
	for (const id of ["my-prs", "prs", "issues"]) uiStore.setGithubSectionCollapsed(id, false);
}

describe("GitHubPanel keyboard navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCollapse();
	});

	afterEach(() => {
		document.body.innerHTML = "";
		uiStore._testCancelPendingSave();
	});

	it("ArrowDown starts at the first row and walks down", () => {
		render(() => <GitHubPanel {...baseProps} />);
		expect(activeRow()).toBeNull();

		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(rowText(activeRow())).toContain("First PR");

		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(rowText(activeRow())).toContain("Second PR");
	});

	it("walks from the last PR into the issues section", () => {
		render(() => <GitHubPanel {...baseProps} />);
		for (let i = 0; i < 3; i++) fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(rowText(activeRow())).toContain("First issue");
	});

	it("ArrowUp walks back and stops at the top", () => {
		render(() => <GitHubPanel {...baseProps} />);
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		fireEvent.keyDown(panel(), { key: "ArrowUp" });
		expect(rowText(activeRow())).toContain("First PR");
		// Already at the top — stays put instead of wrapping
		fireEvent.keyDown(panel(), { key: "ArrowUp" });
		expect(rowText(activeRow())).toContain("First PR");
	});

	it("keeps DOM focus on the panel while navigating", () => {
		render(() => <GitHubPanel {...baseProps} />);
		const before = document.activeElement;
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(document.activeElement).toBe(before);
	});

	it("Enter expands the active issue row and collapses it again", () => {
		render(() => <GitHubPanel {...baseProps} />);
		for (let i = 0; i < 3; i++) fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(rowText(activeRow())).toContain("First issue");

		fireEvent.keyDown(panel(), { key: "Enter" });
		expect(document.querySelectorAll(".ghItemExpanded")).toHaveLength(1);

		fireEvent.keyDown(panel(), { key: "Enter" });
		expect(document.querySelectorAll(".ghItemExpanded")).toHaveLength(0);
	});

	it("Enter expands the active PR row", () => {
		render(() => <GitHubPanel {...baseProps} />);
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		fireEvent.keyDown(panel(), { key: "Enter" });
		expect(document.querySelectorAll(".ghItemExpanded")).toHaveLength(1);
	});

	it("Enter does nothing when no row is active", () => {
		render(() => <GitHubPanel {...baseProps} />);
		fireEvent.keyDown(panel(), { key: "Enter" });
		expect(document.querySelectorAll(".ghItemExpanded")).toHaveLength(0);
	});

	it("skips the rows of a collapsed section", () => {
		uiStore.setGithubSectionCollapsed("prs", true);
		render(() => <GitHubPanel {...baseProps} />);
		fireEvent.keyDown(panel(), { key: "ArrowDown" });
		expect(rowText(activeRow())).toContain("First issue");
	});

	it("Escape collapses an expanded issue before closing the panel", () => {
		const onClose = vi.fn();
		render(() => <GitHubPanel {...baseProps} onClose={onClose} />);
		for (let i = 0; i < 3; i++) fireEvent.keyDown(panel(), { key: "ArrowDown" });
		fireEvent.keyDown(panel(), { key: "Enter" });

		fireEvent.keyDown(panel(), { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();
		expect(document.querySelectorAll(".ghItemExpanded")).toHaveLength(0);

		fireEvent.keyDown(panel(), { key: "Escape" });
		expect(onClose).toHaveBeenCalledOnce();
	});
});

describe("GitHubPanel section collapse persistence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetCollapse();
	});

	afterEach(() => {
		document.body.innerHTML = "";
		uiStore._testCancelPendingSave();
	});

	it("writes the collapsed flag to the ui store when a header is clicked", () => {
		render(() => <GitHubPanel {...baseProps} />);
		const issuesHeader = Array.from(document.querySelectorAll(".ghSectionHeader")).find((h) =>
			h.textContent?.includes("Issues"),
		);
		fireEvent.click(issuesHeader!);
		expect(uiStore.getGithubSectionCollapsed("issues")).toBe(true);
	});

	it("renders the stored collapsed state on mount instead of the default", () => {
		uiStore.setGithubSectionCollapsed("issues", true);
		render(() => <GitHubPanel {...baseProps} />);
		expect(document.body.textContent).not.toContain("First issue");
		// The section header itself is still there to expand again
		expect(document.body.textContent).toContain("Issues");
	});

	it("falls back to the section default when nothing was stored", () => {
		// An empty PR list defaults to collapsed; a populated one defaults to open.
		render(() => <GitHubPanel {...baseProps} />);
		expect(rows().length).toBe(PRS.length + ISSUES.length);
	});
});
