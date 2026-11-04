import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Sidebar", () => {
	beforeEach(() => {
		// These cases exercise the auto density budget; pin it whatever the app default is.
		while (uiStore.state.sidebarDensityMode !== "auto") uiStore.cycleSidebarDensityMode();
		vi.useFakeTimers();
		vi.clearAllMocks();
		setRepos({});
		mockGetActive.mockReturnValue(null);
		mockTerminalsGet.mockReturnValue(null);
		mockGetSubAgentTag.mockReturnValue(null);
		mockGetCheckSummary.mockReturnValue(null);
		mockGetPrStatus.mockReturnValue(null);
		mockLastActivityAt.mockReturnValue(0);
		// Nested terminal tabs are opt-in and off by default — reset per test so the
		// feature-behavior block can enable it and the gating block can rely on off.
		settingsStore.setTabTreeEnabled(false);
		_resetMergedActivityAccum();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	// Critic cases for #1334-b659 round 2.
	const branches = (n: number, terminalsPer = 0) =>
		Object.fromEntries(
			Array.from({ length: n }, (_, i) => [
				`w${i}`,
				{
					workspaceId: `w${i}`,
					branchName: `b${i}`,
					isMain: i === 0,
					worktreePath: null,
					terminals: Array.from({ length: terminalsPer }, (_, k) => `t${i}-${k}`),
					additions: 0,
					deletions: 0,
				},
			]),
		);
	const aside = (container: HTMLElement) => container.querySelector("aside#sidebar") as HTMLElement;

	// Catches: repos of a COLLAPSED group counted in the row budget although GroupSection renders
	// none of them, so collapsing a big group never relaxes the sidebar and the few visible rows stay compact.
	it("does not count repos hidden inside a collapsed group", () => {
		const big = makeRepo({ path: "/big", workspaces: branches(30) });
		const small = makeRepo({ path: "/small", workspaces: branches(2) });
		mockGetGroupedLayout.mockReturnValue({
			groups: [{ group: { id: "g1", name: "Big", color: "", collapsed: true, repoOrder: ["/big"] }, repos: [big] }],
			ungrouped: [small],
		});
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(aside(container).dataset.density).toBe("rich");
	});

	// Catches: tabTreeEnabled flipped on in settings not reaching the density memo (stale read),
	// so 3 branches with 6 tabs each stay comfortable while 21 rows render.
	it("goes compact when enabling the tab tree pushes the list past the budget", () => {
		setRepos({ "/r": makeRepo({ workspaces: branches(3, 6) }) });
		settingsStore.setTabTreeEnabled(true);
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(aside(container).dataset.density).toBe("compact");
	});

	// Catches: terminals counted when the tab tree is off (the list is not rendered), over-counting to compact.
	it("ignores terminals when the tab tree is off", () => {
		setRepos({ "/r": makeRepo({ workspaces: branches(3, 6) }) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(aside(container).dataset.density).toBe("rich");
	});

	// Catches: the density not following a live flip of the tab tree setting (memo not reactive to it).
	it("re-derives density when the tab tree is toggled while mounted", () => {
		setRepos({ "/r": makeRepo({ workspaces: branches(3, 6) }) });
		const { container } = render(() => <Sidebar {...defaultProps()} />);
		expect(aside(container).dataset.density).toBe("rich");
		settingsStore.setTabTreeEnabled(true);
		expect(aside(container).dataset.density).toBe("compact");
	});
});
