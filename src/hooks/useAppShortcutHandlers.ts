import { type Accessor, batch, type Setter } from "solid-js";
import { invoke } from "../invoke";
import { normalizeCombo } from "../keybindingDefaults";
import { detachPanel, togglePanel } from "../panelRouter";
import { appLogger } from "../stores/appLogger";
import { branchSwitcherStore } from "../stores/branchSwitcher";
import { commandPaletteStore } from "../stores/commandPalette";
import { diffTabsStore } from "../stores/diffTabs";
import { editorTabsStore } from "../stores/editorTabs";
import { errorLogStore } from "../stores/errorLog";
import { globalWorkspaceStore } from "../stores/globalWorkspace";
import { mcpPopupStore } from "../stores/mcpPopup";
import { mdTabsStore } from "../stores/mdTabs";
import { multiviewStore } from "../stores/multiview";
import { promptLibraryStore, type SavedPrompt } from "../stores/promptLibrary";
import { repositoriesStore } from "../stores/repositories";
import { paneLayoutKey } from "../stores/savedPaneLayouts";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { toastsStore } from "../stores/toasts";
import { uiStore } from "../stores/ui";
import { worktreeManagerStore } from "../stores/worktreeManager";
import { isTauri } from "../transport";
import { writeClipboard } from "../utils/clipboard";
import { openDialog, saveDialog } from "../utils/nativeDialog";
import { navigateToTerminal } from "../utils/navigateToTerminal";
import { nextWaitingTerminal } from "../utils/nextWaitingTerminal";
import { isAbsolutePath, joinPath, pathStripPrefix } from "../utils/pathUtils";
import { runWithFeedback } from "../utils/promptContext";
import { applyAppZoom } from "../zoom";
import { nextZoomStep, ZOOM_DEFAULT } from "../zoomLevels";
import type { useGitOperations } from "./useGitOperations";
import type { ShortcutHandlers } from "./useKeyboardShortcuts";
import type { useQuickSwitcher } from "./useQuickSwitcher";
import type { SmartPromptResult } from "./useSmartPrompts";
import type { useSplitPanes } from "./useSplitPanes";
import type { useTerminalLifecycle } from "./useTerminalLifecycle";

interface AppShortcutHandlerOptions {
	/** Start or end talk mode. Supplied by the app, which knows whether it is on offer. */
	toggleTalk: () => void;
	terminalLifecycle: ReturnType<typeof useTerminalLifecycle>;
	gitOps: ReturnType<typeof useGitOperations>;
	splitPanes: ReturnType<typeof useSplitPanes>;
	quickSwitcher: ReturnType<typeof useQuickSwitcher>;
	quickSwitcherVisible: Accessor<boolean>;
	closeActiveTabOrPane: () => void;
	setRunCommandDialogVisible: Setter<boolean>;
	setSettingsPanelVisible: Setter<boolean>;
	setTaskQueueVisible: Setter<boolean>;
	setHelpPanelVisible: Setter<boolean>;
	setShowProcessManager: Setter<boolean>;
	setShowGenerators: Setter<boolean>;
	setShowRemoteQr: Setter<boolean>;
	promptOpenPath: () => Promise<string | null>;
	handleOpenFilePath: (absolutePath: string) => void;
	revealFolderInBrowser: (absolutePath: string) => void;
	executeSmartPrompt: (prompt: SavedPrompt) => Promise<SmartPromptResult>;
	setStatusInfo: (text: string) => void;
}

/**
 * Resolve the active file-carrying tab's absolute path + owning repo root for
 * the copy-file-path actions. Checks diff → md → editor (same priority as
 * `findInTerminal` — tab stores deactivate each other, so at most one is
 * active). Returns null when no file tab is active (e.g. a terminal is shown).
 */
function activeFileTabPath(): { abs: string; root: string } | null {
	const diff = diffTabsStore.getActive();
	if (diff?.filePath) {
		const root = diff.repoPath;
		return { abs: isAbsolutePath(diff.filePath) ? diff.filePath : joinPath(root, diff.filePath), root };
	}
	const md = mdTabsStore.getActive();
	if (md?.type === "file" && md.filePath) {
		const root = md.fsRoot ?? md.repoPath;
		return { abs: isAbsolutePath(md.filePath) ? md.filePath : joinPath(root, md.filePath), root };
	}
	const editor = editorTabsStore.getActive();
	if (editor?.filePath) {
		const root = editor.fsRoot || editor.repoPath;
		return { abs: isAbsolutePath(editor.filePath) ? editor.filePath : joinPath(root, editor.filePath), root };
	}
	return null;
}

/** Persist a zoom level and push it into this webview. */
function setAppZoom(level: number): void {
	settingsStore.setAppZoom(level);
	void applyAppZoom(settingsStore.state.appZoom);
}

/** Constructs the shared keyboard, palette, and native-menu action callbacks. */
export function useAppShortcutHandlers(options: AppShortcutHandlerOptions): ShortcutHandlers {
	const { terminalLifecycle, gitOps, splitPanes, quickSwitcher } = options;
	const zoomAll = (action: "zoomIn" | "zoomOut" | "zoomReset") => {
		batch(() => {
			terminalLifecycle[`${action}All`]();
			for (const id of mdTabsStore.getIds()) mdTabsStore[action](id);
			for (const id of editorTabsStore.getIds()) {
				editorTabsStore[action](settingsStore.state.defaultFontSize, id);
			}
		});
	};
	return {
		// Cmd +/-/0 zoom the whole app, the way Cursor and VS Code do. They used to
		// resize only the active terminal's (or markdown tab's) font, which left the
		// rest of the UI fixed. Per-terminal font size is still reachable through
		// Cmd+Shift +/-/0 below (every terminal, markdown and editor tab) and the
		// Appearance settings.
		zoomIn: () => setAppZoom(nextZoomStep(settingsStore.state.appZoom, 1)),
		zoomOut: () => setAppZoom(nextZoomStep(settingsStore.state.appZoom, -1)),
		zoomReset: () => setAppZoom(ZOOM_DEFAULT),
		zoomInAll: () => zoomAll("zoomIn"),
		zoomOutAll: () => zoomAll("zoomOut"),
		zoomResetAll: () => zoomAll("zoomReset"),
		createNewTerminal: gitOps.handleNewTab,
		closeTerminal: terminalLifecycle.closeTerminal,
		reopenClosedTab: terminalLifecycle.reopenClosedTab,
		navigateTab: terminalLifecycle.navigateTab,
		focusLastTerminal: () => {
			const previousId = terminalsStore.getPreviousActiveId();
			if (previousId) navigateToTerminal(previousId);
		},
		historyBack: () => {
			const id = terminalsStore.stepHistory("back");
			if (id) navigateToTerminal(id);
		},
		historyForward: () => {
			const id = terminalsStore.stepHistory("forward");
			if (id) navigateToTerminal(id);
		},
		jumpWaitingTerminal: () => {
			const waiting = terminalsStore
				.getIds()
				.filter((id) => terminalsStore.get(id)?.awaitingInput != null && !terminalsStore.isDetached(id));
			const next = nextWaitingTerminal(waiting, terminalsStore.state.activeId);
			if (next) navigateToTerminal(next);
		},
		clearTerminal: terminalLifecycle.clearTerminal,
		refreshTerminal: terminalLifecycle.refreshTerminal,
		clearScrollback: terminalLifecycle.clearScrollback,
		scrollToTop: terminalLifecycle.scrollToTop,
		scrollToBottom: terminalLifecycle.scrollToBottom,
		scrollPageUp: terminalLifecycle.scrollPageUp,
		scrollPageDown: terminalLifecycle.scrollPageDown,
		toggleZoomPane: splitPanes.toggleZoomPane,
		toggleFocusMode: uiStore.toggleFocusMode,
		closeActivePane: splitPanes.closeActivePane,
		closeActiveTabOrPane: options.closeActiveTabOrPane,
		terminalIds: terminalLifecycle.terminalIds,
		handleTerminalSelect: terminalLifecycle.handleTerminalSelect,
		handleSplit: splitPanes.handleSplit,
		handleRunCommand: (forceDialog) => {
			gitOps.handleRunCommand(forceDialog, () => options.setRunCommandDialogVisible(true));
		},
		reloadActiveTab: () => {
			const activeId = mdTabsStore.state.activeId;
			const handle = activeId ? mdTabsStore.getHandle<{ reload?: () => void }>(activeId) : undefined;
			if (!handle?.reload) return false;
			handle.reload();
			return true;
		},
		switchToBranchByIndex: quickSwitcher.switchToBranchByIndex,
		isQuickSwitcherOpen: options.quickSwitcherVisible,
		toggleMarkdownPanel: uiStore.toggleMarkdownPanel,
		toggleSidebar: uiStore.toggleSidebar,
		togglePromptLibrary: promptLibraryStore.toggleDrawer,
		toggleSettings: () => options.setSettingsPanelVisible((visible) => !visible),
		toggleTaskQueue: () => options.setTaskQueueVisible((visible) => !visible),
		toggleGitOpsPanel: () => togglePanel("git"),
		toggleHelpPanel: () => options.setHelpPanelVisible((visible) => !visible),
		toggleIdeasPanel: uiStore.toggleIdeasPanel,
		toggleFileBrowserPanel: uiStore.toggleFileBrowserPanel,
		requestFileBrowserContentSearch: uiStore.requestFileBrowserContentSearch,
		toggleOutlinePanel: uiStore.toggleOutlinePanel,
		findInTerminal: () => {
			const diffId = diffTabsStore.state.activeId;
			if (diffId) {
				diffTabsStore.getHandle<{ openSearch: () => void }>(diffId)?.openSearch();
				return;
			}
			const markdownId = mdTabsStore.state.activeId;
			if (markdownId) {
				mdTabsStore.getHandle<{ openSearch: () => void }>(markdownId)?.openSearch();
				return;
			}
			const editorId = editorTabsStore.state.activeId;
			if (editorId) {
				editorTabsStore.getHandle<{ openSearch: () => void }>(editorId)?.openSearch();
				return;
			}
			terminalsStore.getActive()?.ref?.openSearch();
		},
		toggleCommandPalette: commandPaletteStore.toggle,
		toggleActivityDashboard: () => togglePanel("activity"),
		toggleMultiview: () => multiviewStore.toggle(),
		toggleWorktreeManager: worktreeManagerStore.toggle,
		toggleBranchSwitcher: branchSwitcherStore.toggle,
		toggleErrorLog: errorLogStore.toggle,
		toggleBranchesTab: () => (uiStore.isDetached("git") ? togglePanel("git") : uiStore.toggleGitPanelOnTab("branches")),
		toggleAiChatPanel: () => togglePanel("ai-chat"),
		toggleMcpPopup: mcpPopupStore.toggle,
		toggleGlobalWorkspace: () => {
			if (!globalWorkspaceStore.hasPromoted()) return;
			const repoPath = repositoriesStore.state.activeRepoPath;
			const repo = repoPath ? repositoriesStore.state.repositories[repoPath] : null;
			const key = repoPath && repo?.activeWorkspaceId ? paneLayoutKey(repoPath, repo.activeWorkspaceId) : undefined;
			if (globalWorkspaceStore.isActive()) globalWorkspaceStore.deactivate(key);
			else globalWorkspaceStore.activate(key);
		},
		toggleDiffScroll: () => {
			const repoPath = repositoriesStore.state.activeRepoPath;
			if (!repoPath) return;
			uiStore.setDiffViewMode("scroll");
			diffTabsStore.add(repoPath, "", "M");
		},
		openFile: () => {
			const defaultPath = gitOps.activeWorktreePath() || repositoriesStore.state.activeRepoPath || undefined;
			void openDialog({ multiple: false, directory: false, defaultPath })
				.then((selected) => {
					if (typeof selected === "string") options.handleOpenFilePath(selected);
				})
				.catch((error) => {
					appLogger.error("app", "Open file dialog failed", error);
					toastsStore.add("Open file failed", String(error), "error", true);
				});
		},
		openFolder: () => {
			const defaultPath = gitOps.activeWorktreePath() || repositoriesStore.state.activeRepoPath || undefined;
			void openDialog({ multiple: false, directory: true, defaultPath })
				.then((selected) => {
					if (typeof selected === "string") options.revealFolderInBrowser(selected);
				})
				.catch((error) => {
					appLogger.error("app", "Open folder dialog failed", error);
					toastsStore.add("Open folder failed", String(error), "error", true);
				});
		},
		openPath: () => {
			void options
				.promptOpenPath()
				.then(async (path) => {
					if (!path) return;
					const stat = await invoke<{ exists: boolean; is_dir: boolean }>("stat_path", { path });
					if (!stat.exists) {
						appLogger.warn("app", "Open Path: path does not exist", { path });
						toastsStore.add("Path does not exist", path, "warn", true);
						return;
					}
					if (stat.is_dir) options.revealFolderInBrowser(path);
					else options.handleOpenFilePath(path);
				})
				.catch((error) => {
					appLogger.error("app", "Open path failed", error);
					toastsStore.add("Open path failed", String(error), "error", true);
				});
		},
		copyFilePath: () => {
			const resolved = activeFileTabPath();
			if (!resolved) return;
			writeClipboard(resolved.abs)
				.then(() => options.setStatusInfo(`Copied path: ${resolved.abs}`))
				.catch((error) => appLogger.error("app", "Failed to copy file path", error));
		},
		copyRelativeFilePath: () => {
			const resolved = activeFileTabPath();
			if (!resolved) return;
			// Relative to the repo root that owns the file; absolute when outside it
			const rel = pathStripPrefix(resolved.abs, resolved.root) ?? resolved.abs;
			writeClipboard(rel)
				.then(() => options.setStatusInfo(`Copied path: ${rel}`))
				.catch((error) => appLogger.error("app", "Failed to copy relative file path", error));
		},
		openSecondaryWindow: () => {
			invoke("open_secondary_window", {}).catch((error) =>
				appLogger.error("app", "Failed to open secondary window", error),
			);
		},
		toggleCommandOverview: mdTabsStore.addCommandOverview,
		openTasks: mdTabsStore.addTasks,
		toggleComposePanel: () => terminalsStore.getActive()?.ref?.toggleCompose(),
		toggleTalk: options.toggleTalk,
		detachActivityDashboard: () => {
			if (!isTauri()) return;
			detachPanel("activity").catch((error) =>
				appLogger.error("app", "Failed to detach Activity Dashboard", { error: String(error) }),
			);
		},
		toggleProcessManager: () => options.setShowProcessManager((visible) => !visible),
		toggleGenerators: () => options.setShowGenerators((visible) => !visible),
		showRemoteQr: () => options.setShowRemoteQr(true),
		blockPrev: () => navigateCommandBlock("previous"),
		blockNext: () => navigateCommandBlock("next"),
		blockFoldToggle: toggleNearestCommandBlock,
		blockSearchToggle: () => terminalsStore.getActive()?.ref?.openSearch(),
		newFile: () => {
			const defaultPath = gitOps.activeWorktreePath() || repositoriesStore.state.activeRepoPath || undefined;
			void saveDialog({ title: "New File", defaultPath })
				.then(async (target) => {
					if (typeof target !== "string") return;
					await invoke("write_external_file", { path: target, content: "" });
					options.handleOpenFilePath(target);
				})
				.catch((error) => {
					appLogger.error("app", "New file creation failed", error);
					toastsStore.add("New file failed", String(error), "error", true);
				});
		},
		runSmartPromptByCombo: (combo) => {
			const prompt = promptLibraryStore
				.getAllPrompts()
				.find(
					(candidate) =>
						candidate.enabled !== false && candidate.shortcut && normalizeCombo(candidate.shortcut) === combo,
				);
			if (!prompt) return false;
			promptLibraryStore.markAsUsed(prompt.id);
			void runWithFeedback(prompt, () => options.executeSmartPrompt(prompt));
			return true;
		},
	};
}

function navigateCommandBlock(direction: "previous" | "next"): void {
	const terminal = terminalsStore.getActive();
	if (!terminal?.ref || terminal.commandBlocks.length === 0) return;
	const sessionId = terminal.ref.getSessionId();
	if (!sessionId) return;
	invoke<[number, number, number]>("terminal_scroll_info", { sessionId })
		.then(([offset, total]) => {
			const viewTop = terminal.historyBase + total - offset;
			if (direction === "previous") {
				for (let index = terminal.commandBlocks.length - 1; index >= 0; index--) {
					if (
						terminal.commandBlocks[index].promptLine >= terminal.historyBase &&
						terminal.commandBlocks[index].promptLine < viewTop - 1
					) {
						terminal.ref!.scrollToLine(terminal.commandBlocks[index].promptLine - terminal.historyBase);
						return;
					}
				}
				return;
			}
			for (const block of terminal.commandBlocks) {
				if (block.promptLine > viewTop + 1) {
					terminal.ref!.scrollToLine(block.promptLine - terminal.historyBase);
					return;
				}
			}
			terminal.ref!.scrollToBottom();
		})
		.catch(() => {});
}

function toggleNearestCommandBlock(): void {
	// No `blockFoldingEnabled` check here on purpose: `toggleBlockFold` enforces
	// it for every caller, so this path cannot drift from CanvasTerminal's.
	const terminal = terminalsStore.getActive();
	if (!terminal?.ref || terminal.commandBlocks.length === 0) return;
	const sessionId = terminal.ref.getSessionId();
	if (!sessionId) return;
	invoke<[number, number, number]>("terminal_scroll_info", { sessionId })
		.then(([offset, total, screenRows]) => {
			const viewCenter = terminal.historyBase + total - offset + Math.floor(screenRows / 2);
			const blocks = terminal.commandBlocks.filter((block) => block.promptLine >= terminal.historyBase);
			if (blocks.length === 0) return;
			let nearest = blocks[0];
			let bestDistance = Math.abs(nearest.promptLine - viewCenter);
			for (let index = 1; index < blocks.length; index++) {
				const distance = Math.abs(blocks[index].promptLine - viewCenter);
				if (distance < bestDistance) {
					nearest = blocks[index];
					bestDistance = distance;
				}
			}
			terminalsStore.toggleBlockFold(terminal.id, nearest.promptLine);
		})
		.catch(() => {});
}
