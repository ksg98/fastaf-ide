import { type Component, createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { togglePanel } from "../../panelRouter";
import { githubStore } from "../../stores/github";
import { remoteConnectionsStore } from "../../stores/remoteConnections";
import type { RepositoryState } from "../../stores/repositories";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { getFirstVisibleRepo, getVisibleLayout, getVisibleRepoSequence } from "../../stores/sidebarLayout";
import { tunnelPanelStore } from "../../stores/tunnelPanel";
import { tunnelsStore } from "../../stores/tunnels";
import { uiStore } from "../../stores/ui";
import { getRepoColor } from "../../utils/repoColor";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu";
import { PrDetailPopover } from "../PrDetailPopover/PrDetailPopover";
import { PromptDialog } from "../PromptDialog";
import { ColorPickerDialog } from "../shared/ColorPickerDialog";
import { GlobalWorkspaceEntry } from "./GlobalWorkspaceEntry";
import { GroupSection } from "./GroupSection";
import { ParkedReposPopover } from "./ParkedReposPopover";
import { RepoSection } from "./RepoSection";
import s from "./Sidebar.module.css";
import { useSidebarDragDrop } from "./useSidebarDragDrop";

export interface SidebarProps {
	quickSwitcherActive?: boolean;
	creatingWorktreeRepos?: Set<string>;
	removingBranches?: Set<string>;
	onBranchSelect: (repoPath: string, branchName: string) => void;
	onAddTerminal: (repoPath: string, branchName: string) => void;
	onRemoveBranch: (repoPath: string, branchName: string) => void;
	onRenameBranch: (repoPath: string, branchName: string) => void;
	onCreateBranch?: (repoPath: string, fromBranch: string) => void;
	buildAgentMenuItems?: (repoPath: string, branchName: string) => ContextMenuItem[];
	onAddWorktree: (repoPath: string) => void;
	onCreateWorktreeFromBranch?: (repoPath: string, branchName: string) => void;
	onMergeAndArchive?: (repoPath: string, branchName: string) => void;
	onAddRepo: () => void;
	/** Opens the clone-from-GitHub dialog */
	onCloneFromGitHub?: () => void;
	onAddRemoteRepo?: (connectionId: string) => void;
	/** Opens the import-from-other-tools dialog (Claude Code / Codex / Cursor / superset.sh) */
	onImportProjects?: () => void;
	onRepoSettings: (repoPath: string) => void;
	onRemoveRepo: (repoPath: string) => void;
	onOpenSettings: () => void;
	onOpenHelp?: () => void;
	onBackgroundGit?: (repoPath: string, op: string, args: string[]) => void;
	runningGitOps?: Set<string>;
	onRefreshBranchStats?: () => Promise<void>;
	onCheckoutRemoteBranch?: (repoPath: string, branchName: string) => void;
	onSwitchBranch?: (repoPath: string, branchName: string) => void;
	switchBranchLists?: Record<string, string[]>;
	currentBranches?: Record<string, string>;
	/** Called when user clicks Review in PrDetailPopover — creates terminal and queues command */
	onReviewPr?: (repoPath: string, branchName: string, command: string) => void;
}

const DRAG_CLASSES: Record<string, string> = {
	top: s.dragOverTop,
	bottom: s.dragOverBottom,
	target: s.dragOverTarget,
};

export const Sidebar: Component<SidebarProps> = (props) => {
	const groupedLayout = createMemo(() => repositoriesStore.getGroupedLayout());
	// Empty state must account for grouped repos too — a repo moved into a group
	// leaves state.repoOrder, so checking ungrouped alone would falsely report
	// "No repositories" when every repo is grouped. (#64)
	const hasVisibleRepos = createMemo(() => {
		const layout = groupedLayout();
		return layout.ungrouped.length > 0 || layout.groups.some((g) => g.repos.length > 0);
	});

	// Layout after the shared visibility pipeline (workspace filter, "active
	// only" toolbar filter, search, sort) — see stores/sidebarLayout.ts. Empty
	// groups are dropped there so no orphaned group header is left behind.
	const filteredLayout = createMemo(() => getVisibleLayout());

	// True when the filtered layout has at least one visible repo. Distinguishes
	// "no repos at all" from "filter hides everything" for the empty state.
	const hasFilteredRepos = createMemo(() => {
		const layout = filteredLayout();
		return layout.ungrouped.length > 0 || layout.groups.some((g) => g.repos.length > 0);
	});

	const countRepos = (layout: { groups: Array<{ repos: unknown[] }>; ungrouped: unknown[] }) =>
		layout.ungrouped.length + layout.groups.reduce((n, g) => n + g.repos.length, 0);
	const totalRepoCount = createMemo(() => countRepos(groupedLayout()));
	const shownRepoCount = createMemo(() => countRepos(filteredLayout()));

	const drag = useSidebarDragDrop();

	// Add-repo context menu for local vs remote
	const addRepoMenu = createContextMenu();

	const connectedRemotes = createMemo(() => {
		const all = remoteConnectionsStore.getConnections();
		return Object.values(all).filter((c) => c.status === "connected");
	});

	const handleAddRepoClick = (e: MouseEvent) => {
		// Only the local entry → skip the menu and add directly
		if (addRepoMenuItems().length < 2) {
			props.onAddRepo();
			return;
		}
		addRepoMenu.open(e);
	};

	const addRepoMenuItems = createMemo((): ContextMenuItem[] => {
		const items: ContextMenuItem[] = [
			{ label: t("sidebar.localRepository", "Local Repository"), action: () => props.onAddRepo() },
		];
		if (props.onCloneFromGitHub) {
			items.push({
				label: t("sidebar.cloneFromGithub", "Clone from GitHub…"),
				action: () => props.onCloneFromGitHub?.(),
			});
		}
		if (props.onAddRemoteRepo) {
			for (const conn of connectedRemotes()) {
				const id = conn.connection.id;
				items.push({
					label: conn.connection.name,
					action: () => props.onAddRemoteRepo?.(id),
				});
			}
		}
		if (settingsStore.state.importToolsEnabled && props.onImportProjects) {
			items.push({
				label: t("sidebar.importProjects", "Import from Claude Code / Codex / Cursor / superset.sh…"),
				action: () => props.onImportProjects?.(),
			});
		}
		return items;
	});

	// PR detail popover state
	const [prDetailTarget, setPrDetailTarget] = createSignal<{ repoPath: string; branch: string } | null>(null);
	// Tracks whether the popover was opened by a manual badge click (vs auto-show)
	const [prDetailIsManual, setPrDetailIsManual] = createSignal(false);

	// Parked repos popover state
	const [parkedPopoverVisible, setParkedPopoverVisible] = createSignal(false);
	const parkedCount = createMemo(() => repositoriesStore.getParkedRepos().length);

	// Reset manual flag whenever target is cleared (prevents orphaned flag)
	createEffect(() => {
		if (!prDetailTarget()) setPrDetailIsManual(false);
	});

	// Auto-show PR popover when active branch has PR data.
	// The decision logic reads reactive signals synchronously (for SolidJS tracking),
	// but the actual setPrDetailTarget is deferred via queueMicrotask so popover
	// mounting doesn't happen during the branch-switch reactive flush.
	createEffect(() => {
		if (!settingsStore.state.autoShowPrPopover) return;
		// Don't override manually-triggered popovers (e.g. badge click on non-active repo)
		if (prDetailIsManual()) return;
		const active = repositoriesStore.getActive();
		if (!active?.activeBranch) {
			queueMicrotask(() => setPrDetailTarget(null));
			return;
		}
		const prStatus = githubStore.getPrStatus(active.path, active.activeBranch);
		const prState = prStatus?.state?.toUpperCase();
		// `!prStatus.is_draft` treats undefined as "not draft", matching the GraphQL
		// path which always sets the field. If the REST fallback ever ships with
		// is_draft missing, a draft would auto-open the detail panel — upgrade to
		// `prStatus.is_draft === false` then.
		if (prStatus && prState !== "CLOSED" && prState !== "MERGED" && !prStatus.is_draft) {
			const target = { repoPath: active.path, branch: active.activeBranch };
			queueMicrotask(() => setPrDetailTarget(target));
		} else {
			const current = prDetailTarget();
			if (!current) return; // nothing to close
			// Only auto-close if user switched to a different branch. When still on
			// the same branch (PR just merged/closed), keep the popover alive — user
			// may be mid-merge or interacting with the cleanup dialog. Destroying the
			// popover kills cleanupCtx and aborts post-merge operations.
			if (current.branch !== active.activeBranch) {
				queueMicrotask(() => setPrDetailTarget(null));
			}
		}
	});

	// Sync CSS variable so toolbar-left matches sidebar width
	createEffect(() => {
		document.documentElement.style.setProperty("--sidebar-width", `${uiStore.state.sidebarWidth}px`);
	});

	const handleResizeStart = (e: MouseEvent) => {
		e.preventDefault();
		const startX = e.clientX;
		const startWidth = uiStore.state.sidebarWidth;

		const sidebar = document.querySelector<HTMLElement>(`[data-testid="sidebar"]`);
		if (sidebar) sidebar.style.transition = "none";

		let lastWidth = startWidth;

		const onMove = (ev: MouseEvent) => {
			const raw = startWidth + (ev.clientX - startX);
			const clamped = Math.min(500, Math.max(200, raw));
			lastWidth = clamped;
			// Update CSS immediately for smooth visual feedback (no IPC)
			document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
		};

		const cleanup = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", cleanup);
			window.removeEventListener("blur", cleanup);
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			if (sidebar) sidebar.style.transition = "";
			// Persist final width via store (single IPC call)
			uiStore.setSidebarWidth(lastWidth);
		};

		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", cleanup);
		// Safety valve: if mouse released outside window, blur fires
		window.addEventListener("blur", cleanup);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";
	};

	// Compute the starting shortcut index for each repo (1-based, cumulative across all groups then ungrouped).
	// Walks the same shared sequence as useQuickSwitcher so numbering can't desync.
	const repoShortcutStarts = createMemo(() => {
		const starts: Record<string, number> = {};
		let counter = 1;
		for (const repo of getVisibleRepoSequence()) {
			starts[repo.path] = counter;
			counter += Object.keys(repo.branches).length;
		}
		return starts;
	});

	// Sidebar search box: Enter activates the first visible match (same activation
	// path as the ParkedReposPopover unpark flow), Esc clears without bubbling to
	// global shortcut handling. Both leave the box blurred.
	const handleSearchKeyDown = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
		if (e.key === "Enter") {
			const repo = getFirstVisibleRepo();
			if (repo) {
				// onBranchSelect switches the active repo itself — pre-setting it
				// corrupts the pane-layout save key for the repo being left.
				const branch = repo.activeBranch || Object.keys(repo.branches)[0];
				if (branch) props.onBranchSelect(repo.path, branch);
				else repositoriesStore.setActive(repo.path);
			}
			uiStore.setRepoSearchQuery("");
			e.currentTarget.blur();
		} else if (e.key === "Escape") {
			e.stopPropagation();
			uiStore.setRepoSearchQuery("");
			e.currentTarget.blur();
		}
	};

	// Workspace/sort footer menu + its dialogs
	const workspaceMenu = createContextMenu();
	const [saveWorkspaceOpen, setSaveWorkspaceOpen] = createSignal(false);
	const [renameWorkspaceTarget, setRenameWorkspaceTarget] = createSignal<string | null>(null);

	/** Repo paths currently visible in the sidebar — what "Save current as workspace" captures */
	const visibleRepoPaths = (): string[] => {
		const layout = filteredLayout();
		const paths: string[] = [];
		for (const entry of layout.groups) {
			for (const repo of entry.repos) paths.push(repo.path);
		}
		for (const repo of layout.ungrouped) paths.push(repo.path);
		return paths;
	};

	// ContextMenuItem has no checked field — "✓ " label prefix marks the active entry
	const checkLabel = (active: boolean, label: string) => (active ? `✓ ${label}` : label);

	const workspaceMenuItems = createMemo((): ContextMenuItem[] => {
		const activeId = repositoriesStore.state.activeWorkspaceId;
		const sortMode = repositoriesStore.state.sortMode;
		const items: ContextMenuItem[] = [
			{
				label: checkLabel(activeId === null, t("sidebar.allProjects", "All projects")),
				action: () => repositoriesStore.setActiveWorkspace(null),
			},
		];
		for (const id of repositoriesStore.state.workspaceOrder) {
			const workspace = repositoriesStore.state.workspaces[id];
			if (!workspace) continue;
			items.push({
				label: checkLabel(activeId === id, workspace.name),
				action: () => repositoriesStore.setActiveWorkspace(id),
			});
		}
		// Trailing `separator: true` renders a divider after the item
		items[items.length - 1].separator = true;
		items.push({
			label: t("sidebar.saveWorkspace", "Save current as workspace…"),
			action: () => setSaveWorkspaceOpen(true),
		});
		items.push({
			label: t("sidebar.renameWorkspace", "Rename workspace…"),
			action: () => setRenameWorkspaceTarget(activeId),
			disabled: activeId === null,
		});
		items.push({
			label: t("sidebar.deleteWorkspace", "Delete workspace"),
			action: () => {
				if (activeId) repositoriesStore.deleteWorkspace(activeId);
			},
			disabled: activeId === null,
			separator: true,
		});
		items.push({
			label: checkLabel(sortMode === "manual", t("sidebar.sortManual", "Sort: Manual")),
			action: () => repositoriesStore.setSortMode("manual"),
		});
		items.push({
			label: checkLabel(sortMode === "name", t("sidebar.sortName", "Sort: Name A–Z")),
			action: () => repositoriesStore.setSortMode("name"),
		});
		items.push({
			label: checkLabel(sortMode === "recent", t("sidebar.sortRecent", "Sort: Recently active")),
			action: () => repositoriesStore.setSortMode("recent"),
		});
		return items;
	});

	// Group rename and color change via PromptDialog
	const [renameGroupTarget, setRenameGroupTarget] = createSignal<string | null>(null);
	const [colorGroupTarget, setColorGroupTarget] = createSignal<string | null>(null);

	const handleGroupRename = (groupId: string) => {
		setRenameGroupTarget(groupId);
	};

	const handleGroupColorChange = (groupId: string) => {
		setColorGroupTarget(groupId);
	};

	/** Render a single RepoSection with all its props */
	const renderRepoSection = (repo: RepositoryState) => {
		// Color inheritance: repo color > group color > undefined
		const nameColor = () => getRepoColor(repo.path);

		return (
			<RepoSection
				repo={repo}
				nameColor={nameColor()}
				isDragging={drag.draggedRepoPath() === repo.path}
				isCreatingWorktree={props.creatingWorktreeRepos?.has(repo.path)}
				removingBranches={props.removingBranches}
				dragOverClass={
					drag.dragOverRepoPath() === repo.path && drag.draggedRepoPath() !== repo.path
						? (DRAG_CLASSES[drag.dragOverSide() ?? ""] ?? undefined)
						: undefined
				}
				quickSwitcherActive={props.quickSwitcherActive}
				branchShortcutStart={repoShortcutStarts()[repo.path]}
				onBranchSelect={(branch) => props.onBranchSelect(repo.path, branch)}
				onAddTerminal={(branch) => props.onAddTerminal(repo.path, branch)}
				onRemoveBranch={(branch) => props.onRemoveBranch(repo.path, branch)}
				onRenameBranch={(branch) => props.onRenameBranch(repo.path, branch)}
				onCreateBranch={props.onCreateBranch ? (branch) => props.onCreateBranch!(repo.path, branch) : undefined}
				onShowPrDetail={(branch) => {
					setPrDetailIsManual(true);
					setPrDetailTarget({ repoPath: repo.path, branch });
				}}
				onShowChanges={() => (uiStore.isDetached("git") ? togglePanel("git") : uiStore.toggleGitPanelOnTab("changes"))}
				buildAgentMenuItems={
					props.buildAgentMenuItems ? (branch) => props.buildAgentMenuItems!(repo.path, branch) : undefined
				}
				onAddWorktree={() => props.onAddWorktree(repo.path)}
				onCreateWorktreeFromBranch={
					props.onCreateWorktreeFromBranch
						? (branch) => props.onCreateWorktreeFromBranch!(repo.path, branch)
						: undefined
				}
				onMergeAndArchive={
					props.onMergeAndArchive ? (branch) => props.onMergeAndArchive!(repo.path, branch) : undefined
				}
				onCheckoutRemoteBranch={
					props.onCheckoutRemoteBranch ? (branch) => props.onCheckoutRemoteBranch!(repo.path, branch) : undefined
				}
				onSettings={() => props.onRepoSettings(repo.path)}
				onRemove={() => props.onRemoveRepo(repo.path)}
				onToggle={() => repositoriesStore.toggleExpanded(repo.path)}
				onToggleCollapsed={() => repositoriesStore.toggleCollapsed(repo.path)}
				onSwitchBranch={(branch) => props.onSwitchBranch?.(repo.path, branch)}
				switchBranchList={() => props.switchBranchLists?.[repo.path] ?? []}
				currentBranch={() => props.currentBranches?.[repo.path] ?? ""}
				onMouseDrag={(e) => {
					// Repo drops map indices against the *stored* order — meaningless
					// while a sort mode rearranges the display, so dragging is inert
					// unless sorting is manual. Group drag stays enabled.
					if (repositoriesStore.state.sortMode === "manual") drag.handleRepoMouseDrag(e, repo.path);
				}}
			/>
		);
	};

	return (
		<aside id="sidebar" class={s.sidebar} data-testid="sidebar">
			{/* Content */}
			<div class={s.content}>
				{/* Repo search box — Enter activates the first match, Esc clears */}
				<Show when={hasVisibleRepos()}>
					<div class={s.searchBox}>
						<input
							class={s.searchInput}
							type="text"
							placeholder={t("sidebar.searchProjects", "Search projects…")}
							value={uiStore.state.repoSearchQuery}
							onInput={(e) => uiStore.setRepoSearchQuery(e.currentTarget.value)}
							onKeyDown={handleSearchKeyDown}
							data-testid="sidebar-search"
						/>
					</div>
				</Show>

				{/* Repo filter status — only rendered while the "active only" filter is
				    engaged (toggled from the toolbar icon). Keeps it unmistakable that
				    repos are hidden, so nobody panics, while taking zero space at rest. */}
				<Show when={hasVisibleRepos() && uiStore.state.repoFilterActiveOnly}>
					<button
						class={s.filterStatus}
						onClick={() => uiStore.setRepoFilterActiveOnly(false)}
						title={t("sidebar.filterShowAll", "Show all")}
					>
						<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
							<path
								d="M1.5 2.5h13l-5 6v5l-3 1.5v-6.5l-5-6Z"
								stroke="currentColor"
								stroke-width="1.3"
								stroke-linejoin="round"
							/>
						</svg>
						<span>
							{t("sidebar.filterActiveOnly", "Active only")} · {shownRepoCount()}/{totalRepoCount()}
						</span>
						<span class={s.filterStatusClear}>{t("sidebar.filterShowAll", "Show all")}</span>
					</button>
				</Show>

				{/* Workspace pill — mirrors the filter banner while a workspace is active */}
				<Show when={repositoriesStore.getActiveWorkspace()}>
					{(workspace) => (
						<button
							class={s.filterStatus}
							onClick={() => repositoriesStore.setActiveWorkspace(null)}
							title={t("sidebar.allProjects", "All projects")}
						>
							<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
								<path
									d="M1.5 3.5h4l1.5 2h7.5v7h-13v-9Z"
									stroke="currentColor"
									stroke-width="1.3"
									stroke-linejoin="round"
								/>
							</svg>
							<span>
								{t("sidebar.workspaceLabel", "Workspace")}: {workspace().name} · {shownRepoCount()}/{totalRepoCount()}
							</span>
							<span class={s.filterStatusClear}>{t("sidebar.allProjects", "All projects")}</span>
						</button>
					)}
				</Show>

				{/* Repository Section */}
				<div>
					<div class={s.repoList} data-sidebar-list>
						{/* Grouped repos */}
						<For each={filteredLayout().groups}>
							{(entry) => (
								<GroupSection
									group={entry.group}
									repos={entry.repos}
									onRename={handleGroupRename}
									onColorChange={handleGroupColorChange}
									onMouseDrag={(e) => drag.handleGroupMouseDrag(e, entry.group.id)}
									dragOverClass={
										drag.dragOverGroupId() === entry.group.id && drag.dragPayload()?.type !== "repo"
											? (DRAG_CLASSES[drag.dragOverGroupSide() ?? ""] ?? undefined)
											: drag.dragOverGroupId() === entry.group.id && drag.dragPayload()?.type === "repo"
												? DRAG_CLASSES["target"]
												: undefined
									}
								>
									<For each={entry.repos}>{(repo) => renderRepoSection(repo)}</For>
								</GroupSection>
							)}
						</For>
						{/* Ungrouped repos */}
						<For each={filteredLayout().ungrouped}>{(repo) => renderRepoSection(repo)}</For>
						<Show when={!hasVisibleRepos()}>
							<div class={s.empty}>
								<p>{t("sidebar.noRepositories", "No repositories")}</p>
								<button onClick={handleAddRepoClick}>{t("sidebar.addRepository", "Add Repository")}</button>
							</div>
						</Show>
						{/* Filters hide every repo — offer a way back for each engaged filter */}
						<Show when={hasVisibleRepos() && !hasFilteredRepos()}>
							<div class={s.empty}>
								<p>
									{uiStore.state.repoSearchQuery
										? t("sidebar.noSearchMatches", "No projects match your search")
										: uiStore.state.repoFilterActiveOnly
											? t("sidebar.noActiveRepos", "No repositories with open terminals")
											: t("sidebar.emptyWorkspace", "This workspace is empty")}
								</p>
								<Show when={uiStore.state.repoSearchQuery}>
									<button onClick={() => uiStore.setRepoSearchQuery("")}>
										{t("sidebar.clearSearch", "Clear search")}
									</button>
								</Show>
								<Show when={uiStore.state.repoFilterActiveOnly}>
									<button onClick={() => uiStore.setRepoFilterActiveOnly(false)}>
										{t("sidebar.filterShowAll", "Show all")}
									</button>
								</Show>
								<Show when={repositoriesStore.state.activeWorkspaceId !== null}>
									<button onClick={() => repositoriesStore.setActiveWorkspace(null)}>
										{t("sidebar.allProjects", "All projects")}
									</button>
								</Show>
							</div>
						</Show>
					</div>
				</div>
			</div>

			<GlobalWorkspaceEntry />

			{/* Git Quick Actions (Story 050) */}
			<Show when={repositoriesStore.getActive()}>
				<div class={s.gitQuickActions}>
					<svg
						class={s.gitQuickLabel}
						width="10"
						height="28"
						viewBox="0 0 10 28"
						aria-hidden="true"
						onClick={() => uiStore.toggleGitPanelOnTab("branches")}
						style={{ cursor: "pointer" }}
					>
						<text
							x="5"
							y="14"
							transform="rotate(-90 5 14)"
							text-anchor="middle"
							dominant-baseline="central"
							fill="currentColor"
							font-size="8.5"
							font-weight="700"
							letter-spacing="0.12em"
							font-family="system-ui,-apple-system,sans-serif"
						>
							GIT
						</text>
					</svg>
					<div class={s.gitQuickBtns}>
						<button
							class={s.gitQuickBtn}
							classList={{ [s.loading]: props.runningGitOps?.has("pull") }}
							disabled={props.runningGitOps?.has("pull")}
							onClick={() => {
								const repo = repositoriesStore.getActive();
								if (repo) props.onBackgroundGit?.(repo.path, "pull", ["pull"]);
							}}
							title={t("sidebar.gitPull", "Pull latest changes")}
						>
							<span class={s.gitQuickIcon}>
								{/* arrow-down-to-line */}
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
									<path
										d="M8 2v9M4 8l4 4 4-4M2 14h12"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</span>
							{t("sidebar.gitPullLabel", "Pull")}
						</button>
						<button
							class={s.gitQuickBtn}
							classList={{ [s.loading]: props.runningGitOps?.has("push") }}
							disabled={props.runningGitOps?.has("push")}
							onClick={() => {
								const repo = repositoriesStore.getActive();
								if (repo) props.onBackgroundGit?.(repo.path, "push", ["push"]);
							}}
							title={t("sidebar.gitPush", "Push commits")}
						>
							<span class={s.gitQuickIcon}>
								{/* arrow-up-from-line */}
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
									<path
										d="M8 14V5M4 8l4-4 4 4M2 2h12"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</span>
							{t("sidebar.gitPushLabel", "Push")}
						</button>
						<button
							class={s.gitQuickBtn}
							classList={{ [s.loading]: props.runningGitOps?.has("fetch") }}
							disabled={props.runningGitOps?.has("fetch")}
							onClick={() => {
								const repo = repositoriesStore.getActive();
								if (repo) props.onBackgroundGit?.(repo.path, "fetch", ["fetch", "--all"]);
							}}
							title={t("sidebar.gitFetch", "Fetch from all remotes")}
						>
							<span class={s.gitQuickIcon}>
								{/* refresh-cw */}
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
									<path
										d="M1 4s.5-1 3-2.5A7 7 0 0 1 15 8"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
									/>
									<path
										d="M15 12s-.5 1-3 2.5A7 7 0 0 1 1 8"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
									/>
									<path
										d="M1 1v3h3M15 15v-3h-3"
										stroke="currentColor"
										stroke-width="1.4"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</span>
							{t("sidebar.gitFetchLabel", "Fetch")}
						</button>
						<button
							class={s.gitQuickBtn}
							classList={{ [s.loading]: props.runningGitOps?.has("stash") }}
							disabled={props.runningGitOps?.has("stash")}
							onClick={() => {
								const repo = repositoriesStore.getActive();
								if (repo) props.onBackgroundGit?.(repo.path, "stash", ["stash"]);
							}}
							title={t("sidebar.gitStash", "Stash changes")}
						>
							<span class={s.gitQuickIcon}>
								{/* layers/stash */}
								<svg width="13" height="13" viewBox="0 0 16 16" fill="none">
									<path
										d="M1.5 6 8 9.5 14.5 6M1.5 10 8 13.5 14.5 10M8 2.5 14.5 6 8 9.5 1.5 6 8 2.5Z"
										stroke="currentColor"
										stroke-width="1.3"
										stroke-linejoin="round"
									/>
								</svg>
							</span>
							{t("sidebar.gitStashLabel", "Stash")}
						</button>
					</div>
				</div>
			</Show>

			{/* Footer */}
			<div class={s.footer}>
				<button class={s.addRepo} onClick={handleAddRepoClick} title={t("sidebar.addRepository", "Add Repository")}>
					<svg class={s.addRepoIcon} width="14" height="14" viewBox="0 0 16 16" fill="none">
						<path
							d="M1.5 2A1.5 1.5 0 0 1 3 .5h3.379a1.5 1.5 0 0 1 1.06.44l1.122 1.12H13A1.5 1.5 0 0 1 14.5 3.5v9a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.5V2Z"
							stroke="currentColor"
							stroke-width="1.2"
						/>
					</svg>
					{t("sidebar.addRepository", "Add Repository")}
				</button>
				<div class={s.footerIcons}>
					<button
						class={s.footerAction}
						onClick={(e) => workspaceMenu.open(e)}
						title={t("sidebar.workspacesAndSort", "Workspaces & sorting")}
					>
						{/* stacked panes / workspace switcher */}
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
							<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2" />
							<path d="M1.5 6h13" stroke="currentColor" stroke-width="1.2" />
							<path d="M4 9h5M4 11h3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
						</svg>
					</button>
					<Show when={parkedCount() > 0}>
						<button
							class={s.footerAction}
							onClick={() => setParkedPopoverVisible((v) => !v)}
							title={t("sidebar.parkedRepos", "Parked repositories")}
							style={{ position: "relative" }}
						>
							<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
								<path d="M2 3h12v2H2zM3 5v8h10V5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
								<path d="M5 8h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
							</svg>
							<span class={s.parkedBadge}>{parkedCount()}</span>
						</button>
					</Show>
					<Show when={tunnelsStore.state.profiles.length > 0}>
						{(() => {
							const connectedCount = () =>
								Object.values(tunnelsStore.state.activeTunnels).filter((t) => t.status.type === "connected").length;
							return (
								<button
									class={s.footerAction}
									onClick={() => tunnelPanelStore.toggle()}
									title={`SSH Tunnels (${connectedCount()} connected)`}
									style={{ position: "relative", color: connectedCount() > 0 ? undefined : "var(--fg-muted)" }}
								>
									<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
										<path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
									</svg>
									<Show when={connectedCount() > 0}>
										<span class={s.parkedBadge} style={{ background: "var(--accent-green, #22c55e)", color: "#000" }}>
											{connectedCount()}
										</span>
									</Show>
								</button>
							);
						})()}
					</Show>
					<button class={s.footerAction} onClick={props.onOpenHelp} title={t("sidebar.help", "Help")}>
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2" />
							<path
								d="M6 6.2a2 2 0 0 1 3.9.6c0 1.2-1.9 1.2-1.9 2.2"
								stroke="currentColor"
								stroke-width="1.2"
								stroke-linecap="round"
							/>
							<circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
						</svg>
					</button>
					<button class={s.footerAction} onClick={props.onOpenSettings} title={t("sidebar.settings", "Settings")}>
						<svg width="15" height="15" viewBox="0 0 16 16" fill="none">
							<path
								d="M6.5 1.5h3l.4 1.8a5 5 0 011.2.7l1.7-.6 1.5 2.6-1.3 1.2a5 5 0 010 1.4l1.3 1.2-1.5 2.6-1.7-.6a5 5 0 01-1.2.7l-.4 1.8h-3l-.4-1.8a5 5 0 01-1.2-.7l-1.7.6-1.5-2.6 1.3-1.2a5 5 0 010-1.4L1.7 5.7l1.5-2.6 1.7.6a5 5 0 011.2-.7z"
								stroke="currentColor"
								stroke-width="1.2"
								stroke-linejoin="round"
							/>
							<circle cx="8" cy="8" r="2" stroke="currentColor" stroke-width="1.2" />
						</svg>
					</button>
				</div>
			</div>

			{/* Parked repos popover */}
			<Show when={parkedPopoverVisible()}>
				<ParkedReposPopover
					onClose={() => setParkedPopoverVisible(false)}
					onUnpark={(repoPath) => {
						repositoriesStore.setPark(repoPath, false);
						setParkedPopoverVisible(false);
						// onBranchSelect switches the active repo itself — pre-setting it
						// corrupts the pane-layout save key for the repo being left.
						const repo = repositoriesStore.get(repoPath);
						const branch = repo?.activeBranch || Object.keys(repo?.branches ?? {})[0];
						if (branch) props.onBranchSelect(repoPath, branch);
						else repositoriesStore.setActive(repoPath);
					}}
				/>
			</Show>

			{/* PR detail popover (triggered from PrStateBadge click) */}
			<Show when={prDetailTarget()}>
				{(target) => (
					<PrDetailPopover
						repoPath={target().repoPath}
						branch={target().branch}
						onClose={() => {
							setPrDetailTarget(null);
							setPrDetailIsManual(false);
						}}
						onReview={props.onReviewPr}
					/>
				)}
			</Show>

			{/* Save-current-as-workspace dialog */}
			<PromptDialog
				visible={saveWorkspaceOpen()}
				title={t("sidebar.saveWorkspaceTitle", "Save Workspace")}
				placeholder={t("sidebar.workspaceNamePlaceholder", "Workspace name")}
				confirmLabel={t("sidebar.saveWorkspaceConfirm", "Save")}
				onClose={() => setSaveWorkspaceOpen(false)}
				onConfirm={(name) => {
					repositoriesStore.createWorkspace(name, visibleRepoPaths());
					setSaveWorkspaceOpen(false);
				}}
			/>

			{/* Workspace rename dialog */}
			<PromptDialog
				visible={renameWorkspaceTarget() !== null}
				title={t("sidebar.renameWorkspaceTitle", "Rename Workspace")}
				placeholder={t("sidebar.workspaceNamePlaceholder", "Workspace name")}
				defaultValue={
					renameWorkspaceTarget() ? (repositoriesStore.state.workspaces[renameWorkspaceTarget()!]?.name ?? "") : ""
				}
				confirmLabel={t("sidebar.renameWorkspaceConfirm", "Rename")}
				onClose={() => setRenameWorkspaceTarget(null)}
				onConfirm={(name) => {
					const id = renameWorkspaceTarget();
					if (id) repositoriesStore.renameWorkspace(id, name);
					setRenameWorkspaceTarget(null);
				}}
			/>

			{/* Group rename dialog */}
			<PromptDialog
				visible={renameGroupTarget() !== null}
				title="Rename Group"
				placeholder="New group name"
				confirmLabel="Rename"
				onClose={() => setRenameGroupTarget(null)}
				onConfirm={(name) => {
					const groupId = renameGroupTarget();
					if (groupId) repositoriesStore.renameGroup(groupId, name);
					setRenameGroupTarget(null);
				}}
			/>

			{/* Group color dialog */}
			<ColorPickerDialog
				visible={colorGroupTarget() !== null}
				title="Group Color"
				currentColor={colorGroupTarget() ? (repositoriesStore.state.groups[colorGroupTarget()!]?.color ?? "") : ""}
				onClose={() => setColorGroupTarget(null)}
				onConfirm={(color) => {
					const groupId = colorGroupTarget();
					if (groupId) repositoriesStore.setGroupColor(groupId, color);
					setColorGroupTarget(null);
				}}
			/>

			{/* Drag handle for resizing */}
			<div class={s.resizeHandle} onMouseDown={handleResizeStart} />

			{/* Add repo context menu (local vs remote) */}
			<ContextMenu
				items={addRepoMenuItems()}
				x={addRepoMenu.position().x}
				y={addRepoMenu.position().y}
				visible={addRepoMenu.visible()}
				onClose={addRepoMenu.close}
			/>

			{/* Workspace/sort footer menu */}
			<ContextMenu
				items={workspaceMenuItems()}
				x={workspaceMenu.position().x}
				y={workspaceMenu.position().y}
				visible={workspaceMenu.visible()}
				onClose={workspaceMenu.close}
			/>
		</aside>
	);
};

export default Sidebar;
