import {
	batch,
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { openPathsAsTabs } from "../../hooks/useFileDrop";
import { initMouseDrag } from "../../hooks/useMouseDrag";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { t } from "../../i18n";
import { shortenHomePath } from "../../platform";
import { appLogger } from "../../stores/appLogger";
import { contextMenuActionsStore } from "../../stores/contextMenuActionsStore";
import { diffTabsStore } from "../../stores/diffTabs";
import { findPaneGroupAtPoint } from "../../stores/dragDrop";
import { editorTabsStore } from "../../stores/editorTabs";
import { globalWorkspaceStore } from "../../stores/globalWorkspace";
import { mdTabsStore, type PluginPanelTab } from "../../stores/mdTabs";
import { multiviewStore } from "../../stores/multiview";
import { paneLayoutStore } from "../../stores/paneLayout";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { makeBranchKey } from "../../stores/tabManager";
import { tabOrderingStore } from "../../stores/tabOrdering";
import { terminalsStore } from "../../stores/terminals";
import { cx } from "../../utils";
import { writeClipboard } from "../../utils/clipboard";
import { keyFor } from "../../utils/hotkey";
import { computeGrid } from "../../utils/multiviewGrid";
import { handleOpenUrl } from "../../utils/openUrl";
import { computeLeafRects } from "../../utils/paneTreeGeometry";
import { fileContextSmartMenuItem } from "../../utils/promptContext";
import { getRepoColor } from "../../utils/repoColor";
import type { ContextMenuItem } from "../ContextMenu/ContextMenu";
import { ContextMenu, createContextMenu } from "../ContextMenu/ContextMenu";
import s from "./TabBar.module.css";
import { alignDockedTabs, DiffTabView, EditorTabView, MarkdownTabView, TerminalTabView } from "./TabViews";

export interface TabBarProps {
	quickSwitcherActive?: boolean;
	onTabSelect: (id: string) => void;
	onTabClose: (id: string, skipConfirm?: boolean) => void;
	onCloseOthers: (id: string) => void;
	onCloseToRight: (id: string) => void;
	onNewTab: () => void;
	onSplitVertical?: () => void;
	onSplitHorizontal?: () => void;
	onReorder?: (fromIndex: number, toIndex: number) => void;
	onDetachTab?: (id: string) => void;
	onReattachTab?: (id: string) => void;
	onFocusDetachedTab?: (id: string) => void;
	onMoveToWorktree?: (terminalId: string, worktreePath: string) => void;
	getWorktreeTargets?: (terminalId: string) => Array<{ branchName: string; path: string }>;
}

export const TabBar: Component<TabBarProps> = (props) => {
	const [dragOverId, setDragOverId] = createSignal<string | null>(null);
	const [dragOverSide, setDragOverSide] = createSignal<"left" | "right" | null>(null);
	const [draggingId, setDraggingId] = createSignal<string | null>(null);
	const [dragInvalid, setDragInvalid] = createSignal(false);
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [mvPreviewPos, setMvPreviewPos] = createSignal<{ x: number; y: number } | null>(null);
	const smartPrompts = useSmartPrompts();

	/** Append a Smart Prompts submenu to a tab context menu if any file-context
	 *  prompts exist. Mutates `items` in-place. */
	const pushFileContextItem = (items: ContextMenuItem[], filePath: string | undefined) => {
		if (!filePath) return;
		const repoRoot = repositoriesStore.getActive()?.path ?? null;
		const item = fileContextSmartMenuItem({ absPath: filePath, repoRoot, isDir: false }, smartPrompts, {
			separator: true,
		});
		if (item) items.push(item);
	};

	// Context menu for tabs
	const tabMenu = createContextMenu();
	const [contextTabId, setContextTabId] = createSignal<string | null>(null);

	// Context menu for new tab + button
	const newTabMenu = createContextMenu();

	// Context menu for overflow tabs (right-click on scroll arrows)
	const overflowMenu = createContextMenu();

	// Shared memo for pane position mini-map (avoids N redundant tree walks)
	const paneRects = createMemo(() => {
		const root = paneLayoutStore.getRoot();
		return root ? computeLeafRects(root) : [];
	});
	const getNewTabMenuItems = (): ContextMenuItem[] => [
		{ label: t("tabBar.newTab", "New Tab"), shortcut: keyFor("new-terminal"), action: () => props.onNewTab() },
		{ label: "", separator: true, action: () => {} },
		{
			label: t("tabBar.splitVertical", "Split Vertically"),
			shortcut: keyFor("split-vertical"),
			action: () => props.onSplitVertical?.(),
			disabled: !paneLayoutStore.isSplit() && !terminalsStore.state.activeId,
		},
		{
			label: t("tabBar.splitHorizontal", "Split Horizontally"),
			shortcut: keyFor("split-horizontal"),
			action: () => props.onSplitHorizontal?.(),
			disabled: !paneLayoutStore.isSplit() && !terminalsStore.state.activeId,
		},
	];

	const openNewTabMenu = (e: MouseEvent) => {
		e.stopPropagation();
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		newTabMenu.openAt(rect.left, rect.bottom + 4);
	};

	const getTabContextMenuItems = (): ContextMenuItem[] => {
		const id = contextTabId();
		if (!id) return [];

		if (id.startsWith("diff-")) {
			const tab = diffTabsStore.get(id);
			const ids = visibleDiffIds();
			const idx = ids.indexOf(id);
			const isPinned = tab?.pinned ?? false;
			const diffItems: ContextMenuItem[] = [
				{
					label: t("tabBar.copyPath", "Copy Path"),
					action: () => {
						if (tab?.filePath)
							writeClipboard(shortenHomePath(tab.filePath)).catch((err) =>
								appLogger.error("app", "Failed to copy path", err),
							);
					},
				},
				{
					label: isPinned ? t("tabBar.unpinTab", "Unpin Tab") : t("tabBar.pinTab", "Pin Tab"),
					action: () => diffTabsStore.setPinned(id, !isPinned),
				},
				{ label: "", separator: true, action: () => {} },
				{
					label: t("tabBar.closeTab", "Close Tab"),
					action: () => {
						diffTabsStore.remove(id);
						props.onTabClose(id);
					},
				},
				{
					label: t("tabBar.closeOthers", "Close Other Tabs"),
					action: () => props.onCloseOthers(id),
					disabled: ids.length <= 1,
				},
				{
					label: t("tabBar.closeRight", "Close Tabs to the Right"),
					action: () => props.onCloseToRight(id),
					disabled: idx >= ids.length - 1,
				},
			];
			pushFileContextItem(diffItems, tab?.filePath);
			return diffItems;
		}

		if (id.startsWith("md-")) {
			const tab = mdTabsStore.get(id);
			const ids = visibleMdIds();
			const idx = ids.indexOf(id);
			const isPinned = tab?.pinned ?? false;
			const hasPath = tab?.type === "file" && tab.filePath;
			const tabUrl = tab?.type === "plugin-panel" ? (tab as PluginPanelTab).url : undefined;
			const mdItems: ContextMenuItem[] = [
				...(hasPath
					? [
							{
								label: t("tabBar.copyPath", "Copy Path"),
								action: () => {
									writeClipboard(shortenHomePath(tab.filePath)).catch((err) =>
										appLogger.error("app", "Failed to copy path", err),
									);
								},
							},
						]
					: []),
				...(tabUrl
					? [{ label: t("tabBar.openInBrowser", "Open in Browser"), action: () => handleOpenUrl(tabUrl) }]
					: []),
				{
					label: isPinned ? t("tabBar.unpinTab", "Unpin Tab") : t("tabBar.pinTab", "Pin Tab"),
					action: () => mdTabsStore.setPinned(id, !isPinned),
				},
				{ label: t("tabBar.print", "Print…"), action: () => window.print() },
				{ label: "", separator: true, action: () => {} },
				{
					label: t("tabBar.closeTab", "Close Tab"),
					action: () => {
						mdTabsStore.remove(id);
						props.onTabClose(id);
					},
				},
				{
					label: t("tabBar.closeOthers", "Close Other Tabs"),
					action: () => props.onCloseOthers(id),
					disabled: ids.length <= 1,
				},
				{
					label: t("tabBar.closeRight", "Close Tabs to the Right"),
					action: () => props.onCloseToRight(id),
					disabled: idx >= ids.length - 1,
				},
			];
			pushFileContextItem(mdItems, hasPath ? tab.filePath : undefined);
			return mdItems;
		}

		if (id.startsWith("edit-")) {
			const tab = editorTabsStore.get(id);
			const ids = visibleEditIds();
			const idx = ids.indexOf(id);
			const isPinned = tab?.pinned ?? false;
			const editItems: ContextMenuItem[] = [
				{
					label: t("tabBar.copyPath", "Copy Path"),
					action: () => {
						if (tab?.filePath)
							writeClipboard(shortenHomePath(tab.filePath)).catch((err) =>
								appLogger.error("app", "Failed to copy path", err),
							);
					},
				},
				{
					label: isPinned ? t("tabBar.unpinTab", "Unpin Tab") : t("tabBar.pinTab", "Pin Tab"),
					action: () => editorTabsStore.setPinned(id, !isPinned),
				},
				{ label: "", separator: true, action: () => {} },
				{ label: t("tabBar.closeTab", "Close Tab"), action: () => props.onTabClose(id) },
				{
					label: t("tabBar.closeOthers", "Close Other Tabs"),
					action: () => props.onCloseOthers(id),
					disabled: ids.length <= 1,
				},
				{
					label: t("tabBar.closeRight", "Close Tabs to the Right"),
					action: () => props.onCloseToRight(id),
					disabled: idx >= ids.length - 1,
				},
			];
			pushFileContextItem(editItems, tab?.filePath);
			return editItems;
		}

		// Terminal tab
		const ids = activeTerminals();
		const idx = ids.indexOf(id);
		const term = terminalsStore.get(id);
		const hasSession = !!term?.sessionId;
		const exited = term?.shellState === "exited";
		const detached = terminalsStore.isDetached(id);
		const worktreeTargets = props.getWorktreeTargets?.(id) ?? [];
		const items: ContextMenuItem[] = [
			{
				label: exited ? t("tabBar.removeTab", "Remove Tab") : t("tabBar.closeTab", "Close Tab"),
				shortcut: keyFor("close-terminal"),
				action: () => props.onTabClose(id),
			},
			{
				label: t("tabBar.closeOthers", "Close Other Tabs"),
				action: () => props.onCloseOthers(id),
				disabled: ids.length <= 1,
			},
			{
				label: t("tabBar.closeRight", "Close Tabs to the Right"),
				action: () => props.onCloseToRight(id),
				disabled: idx >= ids.length - 1,
			},
			{ label: "", separator: true, action: () => {} },
			{ label: t("tabBar.renameTab", "Rename Tab"), action: () => setEditingId(id) },
			detached
				? {
						label: t("tabBar.reattachTab", "Reattach to Main Window"),
						action: () => props.onReattachTab?.(id),
						disabled: exited,
					}
				: {
						label: t("tabBar.detachToWindow", "Detach to Window"),
						action: () => props.onDetachTab?.(id),
						disabled: !hasSession || exited,
					},
		];
		if (worktreeTargets.length > 0) {
			items.push(
				{ label: "", separator: true, action: () => {} },
				{
					label: t("tabBar.moveToWorktree", "Move to Worktree"),
					action: () => {},
					children: worktreeTargets.map((wt) => ({
						label: wt.branchName,
						action: () => props.onMoveToWorktree?.(id, wt.path),
					})),
				},
			);
		}
		// Global workspace promote/unpromote
		const isPromoted = globalWorkspaceStore.isPromoted(id);
		items.push(
			{ label: "", separator: true, action: () => {} },
			{
				label: isPromoted
					? t("tabBar.removeFromWorkspace", "Remove from Global Workspace")
					: t("tabBar.promoteToWorkspace", "Add to Global Workspace"),
				action: () => globalWorkspaceStore.togglePromote(id),
			},
		);
		// Plugin-registered tab actions
		const tabActions = contextMenuActionsStore.getContextActions("tab");
		if (tabActions.length > 0) {
			const ctx = { target: "tab" as const, tabId: id, sessionId: terminalsStore.get(id)?.sessionId ?? undefined };
			for (const a of tabActions) {
				items.push({
					label: a.label,
					action: () => a.action(ctx),
					disabled: a.disabled?.(ctx),
					separator: tabActions.indexOf(a) === 0,
				});
			}
		}
		return items;
	};

	const openTabContextMenu = (e: MouseEvent, id: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextTabId(id);
		tabMenu.open(e);
	};

	// Get terminals for active branch only, ordered by pane layout when split.
	// When global workspace is active, show only promoted terminals instead.
	let prevTerminalIds: string[] = [];
	const activeTerminals = () => {
		let ids: string[];
		if (globalWorkspaceStore.isActive()) {
			ids = globalWorkspaceStore.getPromotedIds();
		} else {
			const activeRepoPath = repositoriesStore.state.activeRepoPath;
			if (!activeRepoPath) {
				ids = terminalsStore.getIds();
			} else {
				const repo = repositoriesStore.state.repositories[activeRepoPath];
				if (!repo?.activeBranch) {
					ids = terminalsStore.getIds();
				} else {
					const branch = repo.branches[repo.activeBranch];
					ids = branch?.terminals || [];
				}
			}
		}

		// During branch switch, hold previous tab list to prevent flash of empty tabs
		if (ids.length === 0 && repositoriesStore.state.branchSwitching) {
			return prevTerminalIds;
		}

		prevTerminalIds = ids;

		// Diagnostic: detect when TabBar shows 0 terminals but the store has some
		// that belong to the current branch (ignore terminals from other repos/branches)
		if (ids.length === 0 && !repositoriesStore.state.branchSwitching) {
			const activeRepoPath = repositoriesStore.state.activeRepoPath;
			const repo = activeRepoPath ? repositoriesStore.state.repositories[activeRepoPath] : null;
			const activeBranch = repo?.activeBranch;
			const branchTerminals = activeBranch ? repo!.branches[activeBranch]?.terminals : null;
			if (branchTerminals && branchTerminals.length > 0) {
				appLogger.warn("app", "TabBar: activeTerminals empty but branch has terminals", {
					branchTerminals,
					activeRepoPath,
					activeBranch,
					activeId: terminalsStore.state.activeId,
				});
			}
		}

		// In split mode, reorder tabs to match the spatial pane layout (DFS order)
		if (!paneLayoutStore.isSplit()) return ids;
		const idSet = new Set(ids);
		const ordered: string[] = [];
		for (const groupId of paneLayoutStore.getAllGroupIds()) {
			const group = paneLayoutStore.state.groups[groupId];
			if (!group) continue;
			for (const tab of group.tabs) {
				if (tab.type === "terminal" && idSet.has(tab.id)) {
					ordered.push(tab.id);
					idSet.delete(tab.id);
				}
			}
		}
		// Append any orphan terminals not assigned to a pane group
		for (const id of ids) {
			if (idSet.has(id)) ordered.push(id);
		}
		return ordered;
	};

	// Branch key for filtering non-terminal tabs
	const activeBranchKey = () => {
		const repoPath = repositoriesStore.state.activeRepoPath;
		if (!repoPath) return null;
		const repo = repositoriesStore.state.repositories[repoPath];
		if (!repo?.activeBranch) return null;
		return makeBranchKey(repoPath, repo.activeBranch);
	};

	const visibleDiffIds = () => diffTabsStore.getVisibleIds(activeBranchKey());
	const visibleMdIds = () => mdTabsStore.getVisibleIds(activeBranchKey());
	const visibleEditIds = () => editorTabsStore.getVisibleIds(activeBranchKey());

	// The docked cluster starts at the split line: the spacer is sized so the
	// docked tabs begin at their pane's left edge and flow left-to-right,
	// exactly like a VSCode editor group's tab strip.
	let dockedSpacerRef: HTMLDivElement | undefined;
	const [dockedOffsetPx, setDockedOffsetPx] = createSignal(0);
	const dockedAnchorGroupId = () => {
		if (!alignDockedTabs()) return null;
		const withFiles = paneRects().filter((r) =>
			paneLayoutStore.state.groups[r.groupId]?.tabs.some((tab) => tab.type !== "terminal"),
		);
		if (withFiles.length === 0) return null;
		return withFiles.reduce((a, b) => (a.x <= b.x ? a : b)).groupId;
	};
	const measureDockedOffset = () => {
		const g = dockedAnchorGroupId();
		if (!g) {
			setDockedOffsetPx(0);
			return;
		}
		requestAnimationFrame(() => {
			const groupEl = document.querySelector(`[data-group-id="${g}"]`);
			const sp = dockedSpacerRef;
			if (!groupEl || !tabsRef || !sp) return;
			const tabsLeft = tabsRef.getBoundingClientRect().left - tabsRef.scrollLeft;
			const paneLeft = groupEl.getBoundingClientRect().left - tabsLeft;
			const spacerLeft = sp.getBoundingClientRect().left - tabsLeft;
			setDockedOffsetPx(Math.max(0, Math.round(paneLeft - spacerLeft)));
		});
	};
	createEffect(() => {
		paneRects(); // layout tree + ratio drags
		activeTerminals(); // terminal tab set shifts the spacer's start
		visibleDiffIds();
		visibleMdIds();
		visibleEditIds();
		measureDockedOffset();
	});
	onMount(() => {
		window.addEventListener("resize", measureDockedOffset);
		onCleanup(() => window.removeEventListener("resize", measureDockedOffset));
	});

	const isGroupedMode = () => settingsStore.state.tabOrderingMode === "grouped-by-type";
	const isFreeMode = () => settingsStore.state.tabOrderingMode === "free";

	const mergedNonTerminalIds = () => {
		if (isGroupedMode()) return [];
		if (isFreeMode()) {
			const allIds = new Set([...activeTerminals(), ...visibleDiffIds(), ...visibleMdIds(), ...visibleEditIds()]);
			return tabOrderingStore.getOrdered(allIds);
		}
		const allIds = new Set([...visibleDiffIds(), ...visibleMdIds(), ...visibleEditIds()]);
		return tabOrderingStore.getOrdered(allIds);
	};

	// Deactivate non-terminal tabs that become invisible after a BRANCH SWITCH.
	// Gated on activeBranchKey (with defer) so it fires only on an actual branch
	// change — NOT on every tab open. A plain createEffect here re-ran whenever a
	// tab was added (activeId change) and nuked a just-opened diff/md/editor whose
	// branchKey didn't yet match the active branch (e.g. opening a diff from a
	// worktree's Git panel), so the click appeared to do nothing.
	createEffect(
		on(
			activeBranchKey,
			() => {
				const diffActive = diffTabsStore.state.activeId;
				if (diffActive && !visibleDiffIds().includes(diffActive)) {
					diffTabsStore.setActive(null);
				}
				const mdActive = mdTabsStore.state.activeId;
				if (mdActive && !visibleMdIds().includes(mdActive)) {
					mdTabsStore.setActive(null);
				}
				const editActive = editorTabsStore.state.activeId;
				if (editActive && !visibleEditIds().includes(editActive)) {
					editorTabsStore.setActive(null);
				}
			},
			{ defer: true },
		),
	);

	// Evict non-pinned plugin-panel tabs from other repos on repo switch — they
	// would otherwise pile up forever, invisible but still holding HTML in memory.
	createEffect(() => {
		const current = repositoriesStore.state.activeRepoPath;
		mdTabsStore.evictNonPinnedPluginPanelsForOtherRepos(current);
	});

	const tabTypeOf = (tabId: string): "terminal" | "markdown" | "diff" | "editor" | null => {
		if (activeTerminals().includes(tabId)) return "terminal";
		if (visibleMdIds().includes(tabId)) return "markdown";
		if (visibleDiffIds().includes(tabId)) return "diff";
		if (visibleEditIds().includes(tabId)) return "editor";
		return null;
	};

	// Mouse-based drag — replaces HTML5 DnD which conflicts with Tauri dragDropEnabled=true
	const handleMouseDrag = (
		e: PointerEvent,
		id: string,
		_tabType: "terminal" | "markdown" | "diff" | "editor" = "terminal",
	) => {
		initMouseDrag(e, e.currentTarget as HTMLElement, {
			onStart: () => setDraggingId(id),
			onMove: (x, y) => {
				const el = document.elementFromPoint(x, y);
				const tabEl = el?.closest("[data-tab-id]") as HTMLElement | null;
				if (tabEl && tabEl.dataset.tabId !== id) {
					const targetId = tabEl.dataset.tabId!;
					const rect = tabEl.getBoundingClientRect();
					setDragOverId(targetId);
					setDragOverSide(x < rect.left + rect.width / 2 ? "left" : "right");
					if (isGroupedMode()) {
						setDragInvalid(tabTypeOf(id) !== tabTypeOf(targetId));
					} else if (isFreeMode()) {
						setDragInvalid(false);
					} else {
						const srcType = tabTypeOf(id);
						const tgtType = tabTypeOf(targetId);
						setDragInvalid((srcType === "terminal") !== (tgtType === "terminal"));
					}
				} else {
					setDragOverId(null);
					setDragOverSide(null);
					setDragInvalid(false);
				}
			},
			onDrop: (x, y) => {
				const sourceId = id;
				// 1. Tab reorder (highest priority — dragOverId from onMove is reliable)
				const overId = dragOverId();
				const overSide = dragOverSide();
				if (overId && overId !== sourceId) {
					const termIds = activeTerminals();
					const fromIndex = termIds.indexOf(sourceId);
					const toIndex = termIds.indexOf(overId);
					if (fromIndex !== -1 && toIndex !== -1 && !isFreeMode()) {
						let adjustedTo = toIndex;
						if (overSide === "left" && fromIndex < toIndex) adjustedTo--;
						else if (overSide === "right" && fromIndex > toIndex) adjustedTo++;
						const clampedTo = Math.max(0, Math.min(adjustedTo, termIds.length - 1));
						if (fromIndex !== clampedTo) {
							props.onReorder?.(fromIndex, clampedTo);
						}
					} else if (isGroupedMode()) {
						if (visibleMdIds().includes(sourceId) && visibleMdIds().includes(overId)) {
							const side = overSide === "left" ? "before" : "after";
							mdTabsStore.reorderByIds(sourceId, overId, side);
						} else if (visibleDiffIds().includes(sourceId) && visibleDiffIds().includes(overId)) {
							const side = overSide === "left" ? "before" : "after";
							diffTabsStore.reorderByIds(sourceId, overId, side);
						} else if (visibleEditIds().includes(sourceId) && visibleEditIds().includes(overId)) {
							const side = overSide === "left" ? "before" : "after";
							editorTabsStore.reorderByIds(sourceId, overId, side);
						}
					} else {
						const side = overSide === "left" ? "before" : "after";
						tabOrderingStore.reorder(sourceId, overId, side);
						if (fromIndex !== -1 && toIndex !== -1) {
							let adjustedTo = toIndex;
							if (overSide === "left" && fromIndex < toIndex) adjustedTo--;
							else if (overSide === "right" && fromIndex > toIndex) adjustedTo++;
							const clampedTo = Math.max(0, Math.min(adjustedTo, termIds.length - 1));
							if (fromIndex !== clampedTo) {
								props.onReorder?.(fromIndex, clampedTo);
							}
						}
					}
					resetDragState();
					return;
				}
				// 2. Cross-pane move / assign orphan (split mode, dropped on pane area)
				if (paneLayoutStore.isSplit()) {
					const targetGroup = findPaneGroupAtPoint(x, y);
					if (targetGroup) {
						const fromGroup = paneLayoutStore.getGroupForTab(sourceId);
						if (fromGroup && fromGroup !== targetGroup) {
							paneLayoutStore.moveTab(fromGroup, targetGroup, sourceId);
							const srcGroup = paneLayoutStore.state.groups[fromGroup];
							if (srcGroup && srcGroup.tabs.length === 0) {
								paneLayoutStore.reset();
							} else {
								paneLayoutStore.setActiveGroup(targetGroup);
							}
							resetDragState();
							return;
						}
						if (!fromGroup) {
							const type = terminalsStore.get(sourceId)
								? ("terminal" as const)
								: diffTabsStore.get(sourceId)
									? ("diff" as const)
									: editorTabsStore.get(sourceId)
										? ("editor" as const)
										: ("markdown" as const);
							paneLayoutStore.addTab(targetGroup, { id: sourceId, type });
							paneLayoutStore.setActiveGroup(targetGroup);
							resetDragState();
							return;
						}
					}
				}
				// 3. Detach from split (dropped outside panes AND not on a tab)
				if (paneLayoutStore.isSplit()) {
					const fromGroup = paneLayoutStore.getGroupForTab(sourceId);
					if (fromGroup) {
						paneLayoutStore.removeTab(fromGroup, sourceId);
						const groups = Object.values(paneLayoutStore.state.groups);
						if (groups.some((g) => g.tabs.length === 0)) {
							paneLayoutStore.reset();
						}
						resetDragState();
						return;
					}
				}
				resetDragState();
			},
			onCancel: () => resetDragState(),
		});
	};

	const resetDragState = () => {
		setDraggingId(null);
		setDragOverId(null);
		setDragOverSide(null);
		setDragInvalid(false);
	};

	const commitRename = (id: string, input: HTMLInputElement) => {
		const newName = input.value.trim();
		if (newName) {
			terminalsStore.update(id, { name: newName, nameIsCustom: true });
		}
		setEditingId(null);
	};

	// Scroll state for arrows and fade gradients
	let tabsRef: HTMLDivElement | undefined;
	const [canScrollLeft, setCanScrollLeft] = createSignal(false);
	const [canScrollRight, setCanScrollRight] = createSignal(false);

	const updateScrollState = () => {
		const el = tabsRef;
		if (!el) return;
		const threshold = 8;
		const hasOverflow = el.scrollWidth > el.clientWidth + threshold;
		batch(() => {
			setCanScrollLeft(hasOverflow && el.scrollLeft > threshold);
			setCanScrollRight(hasOverflow && el.scrollLeft + el.clientWidth < el.scrollWidth - threshold);
		});
	};

	const scrollBy = (delta: number) => {
		tabsRef?.scrollBy({ left: delta, behavior: "smooth" });
	};

	onMount(() => {
		updateScrollState();
		const ro = new ResizeObserver(updateScrollState);
		if (tabsRef) ro.observe(tabsRef);
		onCleanup(() => ro.disconnect());
	});

	// Scroll active tab into view when selection changes
	createEffect(() => {
		const activeId = terminalsStore.state.activeId;
		const diffActive = diffTabsStore.state.activeId;
		const mdActive = mdTabsStore.state.activeId;
		const editActive = editorTabsStore.state.activeId;
		// Track any active id to trigger the effect
		void (activeId || diffActive || mdActive || editActive);
		requestAnimationFrame(() => {
			if (!tabsRef) return;
			const activeEl = tabsRef.querySelector(`.${s.active}`) as HTMLElement | null;
			activeEl?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
			updateScrollState();
		});
	});

	/** Collect tab IDs and names that are clipped in the given direction */
	const getOverflowItems = (direction: "left" | "right"): ContextMenuItem[] => {
		const el = tabsRef;
		if (!el) return [];
		const containerRect = el.getBoundingClientRect();
		const items: ContextMenuItem[] = [];

		const tabEls = el.querySelectorAll(`.${s.tab}`) as NodeListOf<HTMLElement>;
		for (const tabEl of tabEls) {
			const rect = tabEl.getBoundingClientRect();
			const clipped = direction === "left" ? rect.left < containerRect.left - 1 : rect.right > containerRect.right + 1;
			if (!clipped) continue;

			const nameEl = tabEl.querySelector(`.${s.tabName}`) as HTMLElement | null;
			const label = nameEl?.textContent ?? "Tab";

			// Determine which tab this DOM element represents by finding its click handler
			// We read the data from the element title or text content
			items.push({
				label,
				action: () => {
					tabEl.click();
					tabEl.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
				},
			});
		}

		return items;
	};

	const [overflowItems, setOverflowItems] = createSignal<ContextMenuItem[]>([]);

	const openOverflowMenu = (e: MouseEvent, direction: "left" | "right") => {
		e.preventDefault();
		e.stopPropagation();
		const items = getOverflowItems(direction);
		if (items.length === 0) return;
		setOverflowItems(items);
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		overflowMenu.openAt(rect.left, rect.bottom + 4);
	};

	const chevronLeft = (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
			<path
				fill-rule="evenodd"
				d="M11.354 1.646a.5.5 0 010 .708L5.707 8l5.647 5.646a.5.5 0 01-.708.708l-6-6a.5.5 0 010-.708l6-6a.5.5 0 01.708 0z"
			/>
		</svg>
	);
	const chevronRight = (
		<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
			<path
				fill-rule="evenodd"
				d="M4.646 1.646a.5.5 0 01.708 0l6 6a.5.5 0 010 .708l-6 6a.5.5 0 01-.708-.708L10.293 8 4.646 2.354a.5.5 0 010-.708z"
			/>
		</svg>
	);

	return (
		<div
			class={s.tabBarWrapper}
			data-drop-target="tab-bar"
			onDragOver={(e) => {
				if (e.dataTransfer?.types?.includes("application/x-tuic-path")) {
					e.preventDefault();
					e.dataTransfer.dropEffect = "copy";
				}
			}}
			onDrop={(e) => {
				const path = e.dataTransfer?.getData("application/x-tuic-path");
				if (!path) return;
				e.preventDefault();
				openPathsAsTabs([path]);
			}}
		>
			<div class={s.scrollRegion}>
				{/* Left scroll arrow */}
				<button
					class={cx(s.scrollArrow, s.scrollArrowLeft, canScrollLeft() && s.visible)}
					onClick={() => scrollBy(-200)}
					onContextMenu={(e) => openOverflowMenu(e, "left")}
					title="Scroll tabs left"
				>
					{chevronLeft}
				</button>

				{/* Left fade gradient */}
				<div class={cx(s.fadeGradient, s.fadeLeft, canScrollLeft() && s.visible)} />

				<div class={s.tabs} ref={tabsRef} onScroll={updateScrollState}>
					{/* Sized so docked file tabs (order 100) start at the split line, above their pane */}
					<Show when={alignDockedTabs()}>
						<div ref={dockedSpacerRef} class={s.tabSpacer} style={{ width: `${dockedOffsetPx()}px` }} />
					</Show>
					{/* Terminal tabs (not rendered here in free mode — included in merged list) */}
					<Show when={!isFreeMode()}>
						<For each={activeTerminals()}>
							{(id, index) => (
								<TerminalTabView
									id={id}
									index={index()}
									paneRects={paneRects()}
									isDragging={draggingId() === id}
									isDragOver={dragOverId() === id && draggingId() !== id}
									dragOverSide={dragOverSide()}
									dragInvalid={dragInvalid()}
									isEditing={editingId() === id}
									quickSwitcherActive={Boolean(props.quickSwitcherActive)}
									showWorkspaceMetadata={true}
									onSelect={props.onTabSelect}
									onClose={props.onTabClose}
									onFocusDetached={props.onFocusDetachedTab}
									onContextMenu={openTabContextMenu}
									onPointerDown={handleMouseDrag}
									onStartEditing={(editingId) => setEditingId(editingId || null)}
									onCommitRename={commitRename}
								/>
							)}
						</For>
					</Show>

					{/* Non-terminal tabs: grouped mode renders 3 separate For blocks */}
					<Show when={isGroupedMode()}>
						<For each={visibleDiffIds()}>
							{(id) => (
								<DiffTabView
									id={id}
									paneRects={paneRects()}
									isDragging={draggingId() === id}
									isDragOver={dragOverId() === id && draggingId() !== id}
									dragOverSide={dragOverSide()}
									dragInvalid={dragInvalid()}
									onSelect={props.onTabSelect}
									onClose={props.onTabClose}
									onContextMenu={openTabContextMenu}
									onPointerDown={handleMouseDrag}
									showPinned={true}
									richIcon={true}
								/>
							)}
						</For>
						<For each={visibleMdIds()}>
							{(id) => (
								<MarkdownTabView
									id={id}
									paneRects={paneRects()}
									isDragging={draggingId() === id}
									isDragOver={dragOverId() === id && draggingId() !== id}
									dragOverSide={dragOverSide()}
									dragInvalid={dragInvalid()}
									onSelect={props.onTabSelect}
									onClose={props.onTabClose}
									onContextMenu={openTabContextMenu}
									onPointerDown={handleMouseDrag}
									showPinned={true}
									richIcon={true}
								/>
							)}
						</For>
						<For each={visibleEditIds()}>
							{(id) => (
								<EditorTabView
									id={id}
									paneRects={paneRects()}
									isDragging={draggingId() === id}
									isDragOver={dragOverId() === id && draggingId() !== id}
									dragOverSide={dragOverSide()}
									dragInvalid={dragInvalid()}
									onSelect={props.onTabSelect}
									onClose={props.onTabClose}
									onContextMenu={openTabContextMenu}
									onPointerDown={handleMouseDrag}
									showPinned={true}
								/>
							)}
						</For>
					</Show>

					{/* Non-terminal tabs: merged mode (terminals-first / free) */}
					<Show when={!isGroupedMode()}>
						<For each={mergedNonTerminalIds()}>
							{(id) => {
								const type = () => tabTypeOf(id);
								return (
									<Switch>
										<Match when={type() === "terminal"}>
											<TerminalTabView
												id={id}
												index={activeTerminals().indexOf(id)}
												paneRects={paneRects()}
												isDragging={draggingId() === id}
												isDragOver={dragOverId() === id && draggingId() !== id}
												dragOverSide={dragOverSide()}
												dragInvalid={dragInvalid()}
												isEditing={editingId() === id}
												quickSwitcherActive={Boolean(props.quickSwitcherActive)}
												showWorkspaceMetadata={false}
												onSelect={props.onTabSelect}
												onClose={props.onTabClose}
												onFocusDetached={props.onFocusDetachedTab}
												onContextMenu={openTabContextMenu}
												onPointerDown={handleMouseDrag}
												onStartEditing={(editingId) => setEditingId(editingId || null)}
												onCommitRename={commitRename}
											/>
										</Match>
										<Match when={type() === "diff"}>
											<DiffTabView
												id={id}
												paneRects={paneRects()}
												isDragging={draggingId() === id}
												isDragOver={dragOverId() === id && draggingId() !== id}
												dragOverSide={dragOverSide()}
												dragInvalid={dragInvalid()}
												onSelect={props.onTabSelect}
												onClose={props.onTabClose}
												onContextMenu={openTabContextMenu}
												onPointerDown={handleMouseDrag}
												showPinned={false}
												richIcon={false}
											/>
										</Match>
										<Match when={type() === "markdown"}>
											<MarkdownTabView
												id={id}
												paneRects={paneRects()}
												isDragging={draggingId() === id}
												isDragOver={dragOverId() === id && draggingId() !== id}
												dragOverSide={dragOverSide()}
												dragInvalid={dragInvalid()}
												onSelect={props.onTabSelect}
												onClose={props.onTabClose}
												onContextMenu={openTabContextMenu}
												onPointerDown={handleMouseDrag}
												showPinned={false}
												richIcon={false}
											/>
										</Match>
										<Match when={type() === "editor"}>
											<EditorTabView
												id={id}
												paneRects={paneRects()}
												isDragging={draggingId() === id}
												isDragOver={dragOverId() === id && draggingId() !== id}
												dragOverSide={dragOverSide()}
												dragInvalid={dragInvalid()}
												onSelect={props.onTabSelect}
												onClose={props.onTabClose}
												onContextMenu={openTabContextMenu}
												onPointerDown={handleMouseDrag}
												showPinned={false}
											/>
										</Match>
									</Switch>
								);
							}}
						</For>
					</Show>
				</div>
				{/* end .tabs */}

				{/* Right fade gradient */}
				<div class={cx(s.fadeGradient, s.fadeRight, canScrollRight() && s.visible)} />

				{/* Right scroll arrow */}
				<button
					class={cx(s.scrollArrow, s.scrollArrowRight, canScrollRight() && s.visible)}
					onClick={() => scrollBy(200)}
					onContextMenu={(e) => openOverflowMenu(e, "right")}
					title="Scroll tabs right"
				>
					{chevronRight}
				</button>
			</div>
			{/* end .scrollRegion */}

			{/* New Tab button: outside scroll region so arrows don't overlap it */}
			<button
				class={s.newBtn}
				onClick={() => props.onNewTab()}
				onContextMenu={openNewTabMenu}
				title={`${t("tabBar.newTab", "New Tab")} (${keyFor("new-terminal")})`}
			>
				+
			</button>

			{/* Multiview toggle — hover shows a preview of the grid */}
			<Show when={settingsStore.state.multiviewEnabled}>
				<button
					class={s.newBtn}
					classList={{ [s.mvBtnActive]: multiviewStore.state.isOpen }}
					onClick={() => {
						setMvPreviewPos(null);
						multiviewStore.toggle();
					}}
					onMouseEnter={(e) => {
						const r = e.currentTarget.getBoundingClientRect();
						setMvPreviewPos({ x: r.right, y: r.bottom + 4 });
					}}
					onMouseLeave={() => setMvPreviewPos(null)}
					title={`Multiview — all terminals grid (${keyFor("toggle-multiview")})`}
				>
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
						<rect x="3" y="3" width="7" height="7" rx="1" />
						<rect x="14" y="3" width="7" height="7" rx="1" />
						<rect x="3" y="14" width="7" height="7" rx="1" />
						<rect x="14" y="14" width="7" height="7" rx="1" />
					</svg>
				</button>
				<Show when={multiviewStore.state.isOpen ? null : mvPreviewPos()}>
					{(pos) => {
						const tiles = () => multiviewStore.shownTileIds();
						return (
							<div class={s.mvPreview} style={{ left: `${pos().x - 240}px`, top: `${pos().y}px` }}>
								<Show when={tiles().length > 0} fallback={<div class={s.mvPreviewHint}>No live terminals</div>}>
									<div
										class={s.mvPreviewGrid}
										style={{ "grid-template-columns": `repeat(${computeGrid(tiles().length).cols}, 1fr)` }}
									>
										<For each={tiles()}>
											{(tid) => {
												const owner = repositoriesStore.findOwnerForTerminal(tid);
												return (
													<div
														class={s.mvPreviewTile}
														style={{
															"border-left-color": (owner && getRepoColor(owner.repoPath)) || "var(--bg-highlight)",
														}}
													>
														<span class={s.mvPreviewName}>{terminalsStore.get(tid)?.name ?? tid}</span>
														<span class={s.mvPreviewRepo}>
															{owner ? (repositoriesStore.get(owner.repoPath)?.displayName ?? "") : ""}
														</span>
													</div>
												);
											}}
										</For>
									</div>
									<div class={s.mvPreviewHint}>
										Multiview: {tiles().length} terminal{tiles().length === 1 ? "" : "s"}
										{multiviewStore.overflowCount() > 0 ? ` (+${multiviewStore.overflowCount()} more)` : ""}
									</div>
								</Show>
							</div>
						);
					}}
				</Show>
			</Show>

			<ContextMenu
				items={getTabContextMenuItems()}
				x={tabMenu.position().x}
				y={tabMenu.position().y}
				visible={tabMenu.visible()}
				onClose={tabMenu.close}
			/>
			<ContextMenu
				items={getNewTabMenuItems()}
				x={newTabMenu.position().x}
				y={newTabMenu.position().y}
				visible={newTabMenu.visible()}
				onClose={newTabMenu.close}
			/>
			<ContextMenu
				items={overflowItems()}
				x={overflowMenu.position().x}
				y={overflowMenu.position().y}
				visible={overflowMenu.visible()}
				onClose={overflowMenu.close}
			/>
		</div>
	);
};

export default TabBar;
