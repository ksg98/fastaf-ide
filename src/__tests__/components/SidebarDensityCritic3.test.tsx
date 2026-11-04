import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";

const {
	mockToggleExpanded,
	mockToggleCollapsed,
	mockGetActive,
	mockGetOrderedRepos,
	mockReorderRepo,
	mockTerminalsGet,
	mockGetSubAgentTag,
	mockGetCheckSummary,
	mockGetPrStatus,
	mockGetGroupedLayout,
	mockGetGroupForRepo,
	mockToggleGroupCollapsed,
	mockDeleteGroup,
	mockAddRepoToGroup,
	mockRemoveRepoFromGroup,
	mockCreateGroup,
	mockReorderRepoInGroup,
	mockMoveRepoBetweenGroups,
	mockReorderGroups,
	mockToggleBranchTabsCollapsed,
	mockNavigateToTerminal,
	mockOpenUrl,
} = vi.hoisted(() => ({
	mockToggleExpanded: vi.fn(),
	mockToggleCollapsed: vi.fn(),
	mockGetActive: vi.fn<() => unknown>(() => null),
	mockGetOrderedRepos: vi.fn<() => unknown[]>(() => []),
	mockReorderRepo: vi.fn(),
	mockTerminalsGet: vi.fn<(id: string) => unknown>(() => null),
	mockGetSubAgentTag: vi.fn<(id: string) => string | null>(() => null),
	mockGetCheckSummary: vi.fn<() => unknown>(() => null),
	mockGetPrStatus: vi.fn<(...args: unknown[]) => unknown>(() => null),
	mockGetGroupedLayout: vi.fn<() => unknown>(() => ({ groups: [], ungrouped: [] })),
	mockGetGroupForRepo: vi.fn<(path: string) => unknown>(() => undefined),
	mockToggleGroupCollapsed: vi.fn(),
	mockDeleteGroup: vi.fn(),
	mockAddRepoToGroup: vi.fn(),
	mockRemoveRepoFromGroup: vi.fn(),
	mockCreateGroup: vi.fn(() => "new-group-id"),
	mockReorderRepoInGroup: vi.fn(),
	mockMoveRepoBetweenGroups: vi.fn(),
	mockReorderGroups: vi.fn(),
	mockToggleBranchTabsCollapsed: vi.fn(),
	mockNavigateToTerminal: vi.fn(),
	mockOpenUrl: vi.fn(),
}));

vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mockOpenUrl }));

// Mock stores before importing the component
vi.mock("../../stores/repositories", () => ({
	resolveRepoPathFor: (path: string) => path,
	// FastAF's sidebarLayout reads sort mode and named workspaces off the store.
	sortRepos: (repos: unknown[]) => repos,
	repositoriesStore: {
		state: {
			repositories: {} as Record<string, unknown>,
			repoOrder: [] as string[],
			activeRepoPath: null as string | null,
			groups: {} as Record<string, unknown>,
			groupOrder: [] as string[],
			staleTempCandidates: [] as Array<{ path: string; displayName: string }>,
			sortMode: "manual" as string,
			namedWorkspaces: {} as Record<string, unknown>,
			namedWorkspaceOrder: [] as string[],
			activeNamedWorkspaceId: null as string | null,
		},
		getActive: mockGetActive,
		getOrderedRepos: mockGetOrderedRepos,
		reorderRepo: mockReorderRepo,
		toggleExpanded: mockToggleExpanded,
		toggleCollapsed: mockToggleCollapsed,
		getGroupedLayout: mockGetGroupedLayout,
		getGroupForRepo: mockGetGroupForRepo,
		toggleGroupCollapsed: mockToggleGroupCollapsed,
		deleteGroup: mockDeleteGroup,
		addRepoToGroup: mockAddRepoToGroup,
		removeRepoFromGroup: mockRemoveRepoFromGroup,
		createGroup: mockCreateGroup,
		renameGroup: vi.fn(() => true),
		setGroupColor: vi.fn(),
		reorderRepoInGroup: mockReorderRepoInGroup,
		moveRepoBetweenGroups: mockMoveRepoBetweenGroups,
		reorderGroups: mockReorderGroups,
		getParkedRepos: vi.fn(() => []),
		setPark: vi.fn(),
		setParkGroup: vi.fn(),
		isGroupFullyParked: vi.fn(() => false),
		get: vi.fn(() => undefined),
		setActive: vi.fn(),
		toggleWorkspaceTabsCollapsed: mockToggleBranchTabsCollapsed,
		getActiveNamedWorkspace: vi.fn(() => undefined),
	},
}));

vi.mock("../../stores/repoSettings", () => ({
	repoSettingsStore: {
		get: vi.fn(() => undefined),
		getEffective: vi.fn(() => undefined),
		getEffectiveField: vi.fn(() => undefined),
		setLabel: vi.fn(),
	},
}));

vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		get: mockTerminalsGet,
		getSubAgentTag: mockGetSubAgentTag,
		isBusy: vi.fn(() => false),
		onRemove: vi.fn(() => () => {}),
		state: { activeId: null as string | null },
	},
}));

vi.mock("../../utils/navigateToTerminal", () => ({
	navigateToTerminal: mockNavigateToTerminal,
}));

vi.mock("../../stores/github", () => ({
	githubStore: {
		getCheckSummary: mockGetCheckSummary,
		getPrStatus: mockGetPrStatus,
		getRemoteOnlyPrs: vi.fn(() => []),
		getRepoIssues: vi.fn(() => []),
		getAllOpenPrs: vi.fn(() => []),
		getRemoteStatus: vi.fn(() => null),
		getLastPolled: vi.fn(() => 0),
		state: { viewerLogin: null, issuesLoading: false, circuitBreakerOpen: false },
	},
}));

const { mockLastActivityAt } = vi.hoisted(() => ({
	mockLastActivityAt: vi.fn<() => number>(() => 0),
}));

vi.mock("../../stores/userActivity", () => ({
	userActivityStore: {
		lastActivityAt: mockLastActivityAt,
	},
}));

// Mock PrDetailPopover to avoid cascading store dependencies
vi.mock("../../components/PrDetailPopover/PrDetailPopover", () => ({
	PrDetailPopover: (props: { repoPath: string; branch: string; onClose: () => void }) => (
		<div data-testid="pr-detail-popover" data-branch={props.branch} data-repo={props.repoPath} />
	),
}));

import { _resetMergedActivityAccum } from "../../components/Sidebar/RepoSection";
import { Sidebar } from "../../components/Sidebar/Sidebar";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { sidebarPluginStore } from "../../stores/sidebarPluginStore";
import { uiStore } from "../../stores/ui";

/** Helper to create default no-op props for Sidebar */
function defaultProps(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
	return {
		onBranchSelect: vi.fn(),
		onAddTerminal: vi.fn(),
		onRemoveBranch: vi.fn(),
		onRenameBranch: vi.fn(),
		onAddWorktree: vi.fn(),
		onAddRepo: vi.fn(),
		onRepoSettings: vi.fn(),
		onRemoveRepo: vi.fn(),
		onOpenSettings: vi.fn(),
		onOpenHelp: vi.fn(),
		onBackgroundGit: vi.fn(),
		...overrides,
	};
}

/** Helper to create a repository with branches */
function makeRepo(overrides: Record<string, unknown> = {}) {
	return {
		path: "/repo1",
		displayName: "Repo One",
		initials: "RO",
		expanded: true,
		collapsed: false,
		activeWorkspaceId: "main",
		workspaces: {
			main: {
				workspaceId: "main",
				branchName: "main",
				isMain: true,
				worktreePath: null,
				terminals: [],
				additions: 0,
				deletions: 0,
			},
		},
		order: 0,
		...overrides,
	};
}

/** Helper to set repo store state */
function setRepos(repos: Record<string, unknown>, activeRepoPath?: string) {
	(repositoriesStore.state as { repositories: Record<string, unknown> }).repositories = repos;
	(repositoriesStore.state as { activeRepoPath: string | null }).activeRepoPath =
		activeRepoPath ?? Object.keys(repos)[0] ?? null;
	const repoValues = Object.values(repos);
	mockGetOrderedRepos.mockReturnValue(repoValues);
	// Default grouped layout: all repos ungrouped (backward compatible)
	mockGetGroupedLayout.mockReturnValue({ groups: [], ungrouped: repoValues });
}
describe("Sidebar density: plugin panels and collapsed groups (critic r3)", () => {
	beforeEach(() => {
		// These cases exercise the auto density budget; pin it whatever the app default is.
		while (uiStore.state.sidebarDensityMode !== "auto") uiStore.cycleSidebarDensityMode();
		vi.clearAllMocks();
		setRepos({});
		mockGetActive.mockReturnValue(null);
		mockTerminalsGet.mockReturnValue(null);
		mockGetSubAgentTag.mockReturnValue(null);
		mockGetCheckSummary.mockReturnValue(null);
		mockGetPrStatus.mockReturnValue(null);
		mockLastActivityAt.mockReturnValue(0);
		settingsStore.setTabTreeEnabled(false);
		_resetMergedActivityAccum();
	});
	afterEach(() => sidebarPluginStore.clear());

	const branches = (n: number) =>
		Object.fromEntries(
			Array.from({ length: n }, (_, i) => [
				`w${i}`,
				{
					workspaceId: `w${i}`,
					branchName: `b${i}`,
					isMain: i === 0,
					worktreePath: null,
					terminals: [],
					additions: 0,
					deletions: 0,
				},
			]),
		);
	const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, label: `item ${i}` }));
	const panel = (n: number, collapsed = false, id = "p") => {
		const h = sidebarPluginStore.registerPanel("c3", { id, label: "Panel", collapsed });
		h.setItems(items(n));
		return h;
	};
	const density = (container: HTMLElement) => (container.querySelector("aside#sidebar") as HTMLElement).dataset.density;
	const repoAt = (path: string, n: number) => makeRepo({ path, displayName: path, workspaces: branches(n) });

	// Catches: plugin rows added once for the whole sidebar instead of under every open repo.
	it("multiplies the panel rows by the number of open repos", () => {
		panel(6);
		setRepos({ "/a": repoAt("/a", 1), "/b": repoAt("/b", 1) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		// 2 x (1 header + 1 branch + 1 panel header + 6 items) = 18 > 12
		expect(density(container)).toBe("compact");
	});

	// Catches: items of a collapsed panel counted although they are not rendered.
	it("counts only the header of a collapsed panel", () => {
		panel(30, true);
		setRepos({ "/a": repoAt("/a", 1), "/b": repoAt("/b", 1) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(density(container)).toBe("rich");
	});

	// Catches: a panel with no items counted as a header row although RepoSection filters it out.
	it("ignores a panel without items", () => {
		panel(0);
		setRepos({ "/a": repoAt("/a", 11) }); // 12 rows: exactly the budget
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(density(container)).toBe("rich");
	});

	// Catches: density memo not subscribed to panel item changes / disposal.
	it("follows setItems and dispose of a panel after mount", () => {
		const h = panel(0);
		setRepos({ "/a": repoAt("/a", 3) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(density(container)).toBe("rich");
		h.setItems(items(20));
		expect(density(container)).toBe("compact");
		h.dispose();
		expect(density(container)).toBe("rich");
	});

	// Catches: density memo not subscribed to a panel being collapsed/expanded by the user.
	it("follows toggleCollapsed of a panel after mount", () => {
		panel(20);
		setRepos({ "/a": repoAt("/a", 3) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(density(container)).toBe("compact");
		sidebarPluginStore.toggleCollapsed("c3", "p");
		expect(density(container)).toBe("rich");
	});

	// Catches: repos of a collapsed group (and the panels they would render) still counted.
	it("ignores repos of a collapsed group, including their panel rows", () => {
		panel(5); // 6 rows per open repo
		const small = repoAt("/small", 3); // 4 + 6 = 10, +1 group header = 11
		const big = repoAt("/big", 3);
		setRepos({ "/small": small, "/big": big });
		mockGetGroupedLayout.mockReturnValue({
			groups: [{ group: { id: "g", name: "G", color: "", collapsed: true, repoOrder: ["/big"] }, repos: [big] }],
			ungrouped: [small],
		});
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(density(container)).toBe("rich");
	});

	// Catches: the group header row itself missing from the budget (GroupSection renders one per group).
	it("counts the header row of an expanded group", () => {
		const repo = repoAt("/a", 10); // 11 rows: rich without headers; two group headers -> 13
		const repo2 = repoAt("/b", 0); // 1 row
		setRepos({ "/a": repo, "/b": repo2 });
		mockGetGroupedLayout.mockReturnValue({
			groups: [
				{ group: { id: "g1", name: "G1", color: "", collapsed: false, repoOrder: ["/a"] }, repos: [repo] },
				{ group: { id: "g2", name: "G2", color: "", collapsed: true, repoOrder: ["/b"] }, repos: [repo2] },
			],
			ungrouped: [],
		});
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		// rendered rows: 2 group headers + 11 = 13 > 12
		expect(density(container)).toBe("compact");
	});
});
