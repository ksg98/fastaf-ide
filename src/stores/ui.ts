import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { invoke } from "../invoke";
import { appLogger } from "./appLogger";

const LEGACY_SIDEBAR_VISIBLE_KEY = "tui-commander-sidebar-visible";
const LEGACY_SIDEBAR_WIDTH_KEY = "tui-commander-sidebar-width";

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 500;
const SIDEBAR_DEFAULT_WIDTH = 300;

const SETTINGS_NAV_DEFAULT_WIDTH = 180;

/** Debounce window for persisting UI prefs, matching settingsStore. */
const SAVE_DEBOUNCE_MS = 500;

/** Git panel tab names */
export type GitPanelTab = "changes" | "log" | "stashes" | "branches";

/** Diff viewer display mode */
export type DiffViewMode = "split" | "unified" | "scroll";

/** UI store state */
interface UIStoreState {
	// Sidebar visibility
	sidebarVisible: boolean;

	/** Focus mode: hides sidebar, tab bar and side panels to maximize the active
	 *  tab's content area. Toolbar and StatusBar stay visible. Session-only
	 *  (not persisted) — toggled via Cmd+Alt+Enter. */
	focusMode: boolean;

	/** Repo filter: when true the sidebar shows only repositories that have at
	 *  least one open terminal. Session-only (not persisted) — toggled from the
	 *  toolbar filter icon next to the sidebar collapse button. */
	repoFilterActiveOnly: boolean;

	/** Sidebar repo search: case-insensitive substring filter on repo display
	 *  names. Session-only (not persisted) — typed into the sidebar search box,
	 *  cleared on Esc/Enter. */
	repoSearchQuery: string;

	// Sidebar width
	sidebarWidth: number;

	// Panel visibility
	markdownPanelVisible: boolean;
	notesPanelVisible: boolean;
	fileBrowserPanelVisible: boolean;
	gitPanelVisible: boolean;

	outlinePanelVisible: boolean;
	referencesPanelVisible: boolean;
	aiChatPanelVisible: boolean;
	aiTriagePanelVisible: boolean;
	detachedPanels: Record<string, string>;

	/** Collapsed state of the GitHub panel sections, keyed by section id
	 *  (`my-prs`, `prs`, `issues`). A missing key means the section has never
	 *  been toggled and keeps its own default. */
	githubSectionCollapsed: Record<string, boolean>;

	// Knowledge history overlay — ephemeral, not persisted. Full-screen modal
	// opened from SessionKnowledgeBar's "History" button.
	knowledgeHistoryOverlayVisible: boolean;

	// Requested active tab for the git panel (set by external actions like toggle-branches-tab)
	gitPanelRequestedTab: GitPanelTab | null;

	// Resizable panel widths (persisted). The right-side panels are resized by
	// PanelResizeHandle, which writes panel.style.width inline and keeps no
	// store state — only the sidebar and the settings nav are tracked here.
	settingsNavWidth: number;

	// Diff viewer mode (persisted)
	diffViewMode: DiffViewMode;

	// File browser view mode (persisted)
	fileBrowserViewMode: "flat" | "tree";

	// External root (ephemeral) — when set, FileBrowserPanel browses this absolute
	// path instead of the active repo. Used by "Open Folder…" / "Open Path…".
	fileBrowserExternalRoot: string | null;

	// Content-search request nonce (ephemeral) — bumped by the
	// `toggle-file-browser-content-search` shortcut (Cmd+Shift+F). FileBrowserPanel
	// watches it and switches its local searchMode to "content" + focuses the input.
	fileBrowserContentSearchNonce: number;

	// Active dropdown (mutually exclusive)
	activeDropdown: "ide" | "font" | "agent" | null;

	// Loading states
	isLoading: boolean;
	loadingMessage: string;
}

function clampWidth(v: number): number {
	return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, v));
}

/** Create the UI store */
function createUIStore() {
	const [state, setState] = createStore<UIStoreState>({
		sidebarVisible: true,
		focusMode: false,
		repoFilterActiveOnly: false,
		repoSearchQuery: "",
		sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
		markdownPanelVisible: false,
		notesPanelVisible: false,
		fileBrowserPanelVisible: false,
		gitPanelVisible: false,
		outlinePanelVisible: false,
		referencesPanelVisible: false,
		aiChatPanelVisible: false,
		aiTriagePanelVisible: false,
		detachedPanels: {} as Record<string, string>,
		githubSectionCollapsed: {} as Record<string, boolean>,
		knowledgeHistoryOverlayVisible: false,
		gitPanelRequestedTab: null,
		settingsNavWidth: SETTINGS_NAV_DEFAULT_WIDTH,
		diffViewMode: "split" as DiffViewMode,
		fileBrowserViewMode: "tree" as "flat" | "tree",
		fileBrowserExternalRoot: null,
		fileBrowserContentSearchNonce: 0,
		activeDropdown: null,
		isLoading: false,
		loadingMessage: "",
	});

	let saveTimer: ReturnType<typeof setTimeout> | null = null;

	/** Debounced persist — coalesces a burst of panel toggles into one write.
	 *  Each `save_ui_prefs` costs a config read, the global write lock and an
	 *  atomic write on the Rust side, so `setExclusivePanel` must not pay one per
	 *  mutation. Mirrors `settingsStore.save()` and `paneLayoutStore.scheduleSave()`. */
	function saveUIPrefs(): void {
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = null;
			writeUIPrefs();
		}, SAVE_DEBOUNCE_MS);
	}

	/** Write the current prefs to the Rust backend (fire-and-forget) */
	function writeUIPrefs(): void {
		invoke("save_ui_prefs", {
			config: {
				sidebar_visible: state.sidebarVisible,
				sidebar_width: state.sidebarWidth,
				markdown_panel_visible: state.markdownPanelVisible,
				notes_panel_visible: state.notesPanelVisible,
				file_browser_panel_visible: state.fileBrowserPanelVisible,
				git_panel_visible: state.gitPanelVisible,
				ai_chat_panel_visible: state.aiChatPanelVisible,
				settings_nav_width: state.settingsNavWidth,
				diff_view_mode: state.diffViewMode,
				file_browser_view_mode: state.fileBrowserViewMode,
				detached_panels: state.detachedPanels,
				github_section_collapsed: state.githubSectionCollapsed,
			},
		}).catch((err) => appLogger.debug("store", "Failed to save UI prefs", err));
	}

	/** Keys of the mutually exclusive right-side panels */
	type ExclusivePanel =
		| "markdownPanelVisible"
		| "fileBrowserPanelVisible"
		| "gitPanelVisible"
		| "outlinePanelVisible"
		| "referencesPanelVisible"
		| "aiChatPanelVisible"
		| "aiTriagePanelVisible"
		| "notesPanelVisible";
	const exclusivePanels: ExclusivePanel[] = [
		"markdownPanelVisible",
		"fileBrowserPanelVisible",
		"gitPanelVisible",
		"outlinePanelVisible",
		"referencesPanelVisible",
		"aiChatPanelVisible",
		"aiTriagePanelVisible",
		"notesPanelVisible",
	];

	/** Open one exclusive panel and close the others, or close all if `key` is already open (toggle). */
	function setExclusivePanel(key: ExclusivePanel, visible: boolean): void {
		batch(() => {
			setState(key, visible);
			if (visible) {
				for (const k of exclusivePanels) {
					if (k !== key) setState(k, false);
				}
			}
		});
		saveUIPrefs();
	}

	const actions = {
		/** Load UI prefs from Rust backend; migrate from localStorage on first run */
		async hydrate(): Promise<void> {
			try {
				// One-time migration from localStorage
				const legacyVisible = localStorage.getItem(LEGACY_SIDEBAR_VISIBLE_KEY);
				const legacyWidth = localStorage.getItem(LEGACY_SIDEBAR_WIDTH_KEY);
				if (legacyVisible !== null || legacyWidth !== null) {
					const visible = legacyVisible !== "false";
					const width = parseInt(legacyWidth || "", 10);
					const sidebarWidth = clampWidth(Number.isNaN(width) ? SIDEBAR_DEFAULT_WIDTH : width);
					await invoke("save_ui_prefs", {
						config: { sidebar_visible: visible, sidebar_width: sidebarWidth },
					});
					localStorage.removeItem(LEGACY_SIDEBAR_VISIBLE_KEY);
					localStorage.removeItem(LEGACY_SIDEBAR_WIDTH_KEY);
				}

				const loaded = await invoke<{
					sidebar_visible?: boolean;
					sidebar_width?: number;
					markdown_panel_visible?: boolean;
					notes_panel_visible?: boolean;
					file_browser_panel_visible?: boolean;
					git_panel_visible?: boolean;
					ai_chat_panel_visible?: boolean;
					settings_nav_width?: number;
					diff_view_mode?: string;
					file_browser_view_mode?: string;
					detached_panels?: Record<string, string>;
					github_section_collapsed?: Record<string, boolean>;
				}>("load_ui_prefs");
				if (loaded) {
					if (loaded.sidebar_visible !== undefined) {
						setState("sidebarVisible", loaded.sidebar_visible);
					}
					if (loaded.sidebar_width !== undefined) {
						setState("sidebarWidth", clampWidth(loaded.sidebar_width));
					}
					if (loaded.markdown_panel_visible !== undefined) {
						setState("markdownPanelVisible", loaded.markdown_panel_visible);
					}
					if (loaded.notes_panel_visible !== undefined) {
						setState("notesPanelVisible", loaded.notes_panel_visible);
					}
					if (loaded.file_browser_panel_visible !== undefined) {
						setState("fileBrowserPanelVisible", loaded.file_browser_panel_visible);
					}
					if (loaded.git_panel_visible !== undefined) {
						setState("gitPanelVisible", loaded.git_panel_visible);
					}
					if (loaded.ai_chat_panel_visible !== undefined) {
						setState("aiChatPanelVisible", loaded.ai_chat_panel_visible);
					}
					if (loaded.settings_nav_width !== undefined) {
						setState("settingsNavWidth", loaded.settings_nav_width);
					}
					if (
						loaded.diff_view_mode === "split" ||
						loaded.diff_view_mode === "unified" ||
						loaded.diff_view_mode === "scroll"
					) {
						setState("diffViewMode", loaded.diff_view_mode);
					}
					if (loaded.file_browser_view_mode === "flat" || loaded.file_browser_view_mode === "tree") {
						setState("fileBrowserViewMode", loaded.file_browser_view_mode);
					}
					if (loaded.detached_panels && typeof loaded.detached_panels === "object") {
						setState("detachedPanels", loaded.detached_panels);
					}
					if (loaded.github_section_collapsed && typeof loaded.github_section_collapsed === "object") {
						setState("githubSectionCollapsed", loaded.github_section_collapsed);
					}
				}
			} catch (err) {
				appLogger.debug("store", "Failed to hydrate UI prefs", err);
			}
		},

		// Diff view mode
		setDiffViewMode(mode: DiffViewMode): void {
			setState("diffViewMode", mode);
			saveUIPrefs();
		},

		// File browser view mode
		setFileBrowserViewMode(mode: "flat" | "tree"): void {
			setState("fileBrowserViewMode", mode);
			saveUIPrefs();
		},

		// External root (ephemeral, not persisted) — lets the file browser escape
		// repo scoping for "Open Folder…" / "Open Path…".
		setFileBrowserExternalRoot(path: string | null): void {
			setState("fileBrowserExternalRoot", path);
		},

		// Open the file browser (if not already) and ask it to enter content-search
		// mode. Bumping the nonce lets the panel react even when it's already visible.
		requestFileBrowserContentSearch(): void {
			setExclusivePanel("fileBrowserPanelVisible", true);
			setState("fileBrowserContentSearchNonce", (n) => n + 1);
		},

		// Panel toggles — mutually exclusive
		toggleMarkdownPanel(): void {
			setExclusivePanel("markdownPanelVisible", !state.markdownPanelVisible);
		},

		setMarkdownPanelVisible(visible: boolean): void {
			setExclusivePanel("markdownPanelVisible", visible);
		},

		toggleNotesPanel(): void {
			setExclusivePanel("notesPanelVisible", !state.notesPanelVisible);
		},

		setNotesPanelVisible(visible: boolean): void {
			setExclusivePanel("notesPanelVisible", visible);
		},

		toggleFileBrowserPanel(): void {
			setExclusivePanel("fileBrowserPanelVisible", !state.fileBrowserPanelVisible);
		},

		setFileBrowserPanelVisible(visible: boolean): void {
			setExclusivePanel("fileBrowserPanelVisible", visible);
		},

		toggleGitPanel(): void {
			setExclusivePanel("gitPanelVisible", !state.gitPanelVisible);
		},

		setGitPanelVisible(visible: boolean): void {
			setExclusivePanel("gitPanelVisible", visible);
		},

		/**
		 * Open the git panel and switch to the given tab.
		 * If the panel is already open on that tab, close it (toggle behaviour).
		 */
		toggleGitPanelOnTab(tab: GitPanelTab): void {
			const alreadyOpenOnTab = state.gitPanelVisible && state.gitPanelRequestedTab === tab;
			if (alreadyOpenOnTab) {
				setExclusivePanel("gitPanelVisible", false);
			} else {
				setState("gitPanelRequestedTab", tab);
				setExclusivePanel("gitPanelVisible", true);
			}
		},

		toggleOutlinePanel(): void {
			setExclusivePanel("outlinePanelVisible", !state.outlinePanelVisible);
		},

		setOutlinePanelVisible(visible: boolean): void {
			setExclusivePanel("outlinePanelVisible", visible);
		},

		toggleReferencesPanel(): void {
			setExclusivePanel("referencesPanelVisible", !state.referencesPanelVisible);
		},

		setReferencesPanelVisible(visible: boolean): void {
			setExclusivePanel("referencesPanelVisible", visible);
		},

		toggleAiChatPanel(): void {
			setExclusivePanel("aiChatPanelVisible", !state.aiChatPanelVisible);
		},

		setAiChatPanelVisible(visible: boolean): void {
			setExclusivePanel("aiChatPanelVisible", visible);
		},

		toggleAiTriagePanel(): void {
			setExclusivePanel("aiTriagePanelVisible", !state.aiTriagePanelVisible);
		},

		setAiTriagePanelVisible(visible: boolean): void {
			setExclusivePanel("aiTriagePanelVisible", visible);
		},

		setDetached(panelId: string, windowLabel: string): void {
			setState("detachedPanels", panelId, windowLabel);
			saveUIPrefs();
		},

		clearDetached(panelId: string): void {
			const { [panelId]: _, ...rest } = state.detachedPanels;
			setState("detachedPanels", reconcile(rest));
			saveUIPrefs();
		},

		isDetached(panelId: string): boolean {
			return panelId in state.detachedPanels;
		},

		/** Collapsed flag for a GitHub panel section, or undefined when the user
		 *  has never toggled it — the caller then applies its own default. */
		getGithubSectionCollapsed(sectionId: string): boolean | undefined {
			return state.githubSectionCollapsed[sectionId];
		},

		setGithubSectionCollapsed(sectionId: string, collapsed: boolean): void {
			setState("githubSectionCollapsed", sectionId, collapsed);
			saveUIPrefs();
		},

		setKnowledgeHistoryOverlayVisible(visible: boolean): void {
			setState("knowledgeHistoryOverlayVisible", visible);
		},

		toggleKnowledgeHistoryOverlay(): void {
			setState("knowledgeHistoryOverlayVisible", (v) => !v);
		},

		// Dropdown management
		toggleIdeDropdown(): void {
			setState("activeDropdown", (v) => (v === "ide" ? null : "ide"));
		},

		toggleFontDropdown(): void {
			setState("activeDropdown", (v) => (v === "font" ? null : "font"));
		},

		toggleAgentDropdown(): void {
			setState("activeDropdown", (v) => (v === "agent" ? null : "agent"));
		},

		closeAllDropdowns(): void {
			setState("activeDropdown", null);
		},

		// Sidebar visibility
		toggleSidebar(): void {
			setState("sidebarVisible", (v) => !v);
			saveUIPrefs();
		},

		// Focus mode (session-only, not persisted)
		toggleFocusMode(): void {
			setState("focusMode", (v) => !v);
		},

		// Repo filter (session-only, not persisted)
		toggleRepoFilter(): void {
			setState("repoFilterActiveOnly", (v) => !v);
		},

		setRepoFilterActiveOnly(active: boolean): void {
			setState("repoFilterActiveOnly", active);
		},

		// Repo search (session-only, not persisted)
		setRepoSearchQuery(query: string): void {
			setState("repoSearchQuery", query);
		},

		setSidebarVisible(visible: boolean): void {
			setState("sidebarVisible", visible);
			saveUIPrefs();
		},

		// Sidebar width
		setSidebarWidth(width: number): void {
			setState("sidebarWidth", clampWidth(width));
			saveUIPrefs();
		},

		setSettingsNavWidth(width: number): void {
			setState("settingsNavWidth", width);
		},

		/** Persist current UI prefs to disk. Call after drag-end, not during drag. */
		persistUIPrefs(): void {
			saveUIPrefs();
		},

		/** Reset all panel and sidebar widths to defaults */
		resetLayout(): void {
			batch(() => {
				setState("sidebarWidth", SIDEBAR_DEFAULT_WIDTH);
				setState("settingsNavWidth", SETTINGS_NAV_DEFAULT_WIDTH);
			});
			saveUIPrefs();
		},

		// Loading state
		setLoading(loading: boolean, message?: string): void {
			batch(() => {
				setState("isLoading", loading);
				setState("loadingMessage", message || "");
			});
		},
	};

	return {
		state,
		...actions,
		/** Write a pending debounced save now — the app is going away. */
		flushSave(): void {
			if (!saveTimer) return;
			clearTimeout(saveTimer);
			saveTimer = null;
			writeUIPrefs();
		},
		_testCancelPendingSave(): void {
			if (saveTimer) {
				clearTimeout(saveTimer);
				saveTimer = null;
			}
		},
	};
}

export const uiStore = createUIStore();

// Debug registry — expose UI panel state for MCP introspection
import { registerDebugSnapshot } from "./debugRegistry";

registerDebugSnapshot("ui", () => {
	const s = uiStore.state;
	return {
		sidebarVisible: s.sidebarVisible,
		focusMode: s.focusMode,
		sidebarWidth: s.sidebarWidth,
		markdownPanelVisible: s.markdownPanelVisible,
		notesPanelVisible: s.notesPanelVisible,
		fileBrowserPanelVisible: s.fileBrowserPanelVisible,
		gitPanelVisible: s.gitPanelVisible,
		aiChatPanelVisible: s.aiChatPanelVisible,
		diffViewMode: s.diffViewMode,
		isLoading: s.isLoading,
	};
});
