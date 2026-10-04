import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ContentSearchOptions } from "../../hooks/useFileBrowser";
import { useFileBrowser } from "../../hooks/useFileBrowser";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { t } from "../../i18n";
import { invoke, listen } from "../../invoke";
import { getModifierSymbol } from "../../platform";
import { appLogger } from "../../stores/appLogger";
import { diffTabsStore } from "../../stores/diffTabs";
import { markInternalDragEnd, markInternalDragStart, startNativeDrag } from "../../stores/dragDrop";
import { editorTabsStore } from "../../stores/editorTabs";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import { uiStore } from "../../stores/ui";
import type { ContentMatch, DirEntry, PasteResult } from "../../types/fs";
import { cx } from "../../utils";
import { onClickKeyDown } from "../../utils/a11y";
import { writeClipboard } from "../../utils/clipboard";
import { isAbsolutePath, joinPath, replaceBasename } from "../../utils/pathUtils";
import { fileContextSmartMenuItem } from "../../utils/promptContext";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu";
import { PromptDialog } from "../PromptDialog";
import g from "../shared/git-status.module.css";
import p from "../shared/panel.module.css";
import { Dropdown } from "../ui/Dropdown";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import { PanelWindowControls } from "../ui/PanelWindowControls";
import s from "./FileBrowserPanel.module.css";
import { FileIcon } from "./FileIcon";
import { fileTooltip, formatSize, getStatusClass } from "./fileUtils";
import { TreeNode } from "./TreeNode";
import { revalidateTreeCache } from "./treeRevalidate";

export interface FileBrowserPanelProps {
	visible: boolean;
	repoPath: string | null;
	/** Effective filesystem root (worktree path when on a linked worktree) */
	fsRoot?: string | null;
	onClose: () => void;
	onFileOpen: (repoPath: string, filePath: string, line?: number) => void;
	mode?: "inline" | "detached";
}

/** SVG icons for content search toggle buttons (same as SearchBar) */
const CaseSensitiveIcon = () => (
	<svg viewBox="0 0 16 16" fill="currentColor">
		<path d="M8.854 11.702h-1l-.816-2.159H3.772l-.768 2.16H2L5.09 4h.76l3.004 7.702zm-2.27-3.074L5.452 5.549a1.635 1.635 0 01-.066-.252h-.02a1.674 1.674 0 01-.07.256L4.17 8.628h2.415zM13.995 11.7v-.73c-.37.47-.955.792-1.705.792-1.2 0-2.088-.797-2.088-1.836 0-1.092.855-1.792 2.156-1.867l1.636-.09v-.362c0-.788-.49-1.257-1.328-1.257-.678 0-1.174.31-1.399.778h-.91c.153-.95 1.085-1.635 2.333-1.635 1.39 0 2.227.79 2.227 2.04V11.7h-.922z" />
	</svg>
);

const WholeWordIcon = () => (
	<svg viewBox="0 0 16 16" fill="currentColor">
		<path d="M2 6h1v7H2V6zm5.38 4.534h-.022c-.248.371-.7.596-1.205.596C5.344 11.13 4.7 10.48 4.7 9.6c0-.925.604-1.46 1.703-1.522l1-.052V7.72c0-.547-.336-.87-.918-.87-.514 0-.836.22-1.002.563H4.59c.156-.734.808-1.253 1.866-1.253 1.117 0 1.825.6 1.825 1.548v3.023h-.9v-.197zM5.604 9.6c0 .37.283.64.674.64.548 0 .96-.373.96-.836v-.45l-.864.046c-.57.034-.77.256-.77.6zM10.552 6.26c.467 0 .824.186 1.078.54V4h.904v8.73h-.9v-.65c-.258.456-.66.72-1.158.72C9.546 12.8 8.8 11.88 8.8 10.52c0-1.37.74-2.26 1.752-2.26zm.18.816c-.647 0-1.038.56-1.038 1.44s.39 1.46 1.048 1.46c.647 0 1.043-.57 1.043-1.45s-.396-1.45-1.053-1.45z" />
		<path d="M1 13h14v1H1z" />
	</svg>
);

const RegexIcon = () => (
	<svg viewBox="0 0 16 16" fill="currentColor">
		<path d="M10.012 2h.976v3.113l2.56-1.557.486.885L11.47 6l2.564 1.559-.486.885-2.56-1.557V10h-.976V6.887l-2.56 1.557-.486-.885L9.53 6 6.966 4.441l.486-.885 2.56 1.557V2zM2 10h4v4H2v-4z" />
	</svg>
);

/** Filename mode icon — simple "F" in a doc shape */
const FilenameModeIcon = () => (
	<svg viewBox="0 0 16 16" fill="currentColor">
		<path d="M4 2h5l3 3v9H4V2zm1 1v10h6V6H9V3H5zm1.5 4h3v1h-3V7zm0 2h3v1h-3V9z" />
	</svg>
);

/** Content mode icon — magnifier with lines */
const ContentModeIcon = () => (
	<svg viewBox="0 0 16 16" fill="currentColor">
		<path d="M11.5 7a4.5 4.5 0 1 0-1.77 3.56l3.35 3.36.71-.71-3.36-3.35A4.48 4.48 0 0 0 11.5 7zM7 10.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7zM5 6h4v1H5V6zm0 2h4v1H5V8z" />
	</svg>
);

/** Shared empty set: clearing the selection allocates nothing. */
const EMPTY_PATHS: ReadonlySet<string> = new Set();

/** "1 File" / "3 Files", for menu labels and toasts about a selection. */
const fileCount = (n: number) => (n === 1 ? "1 File" : `${n} Files`);

export const FileBrowserPanel: Component<FileBrowserPanelProps> = (props) => {
	const mode = () => props.mode ?? "inline";
	const [entries, setEntries] = createSignal<DirEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [currentSubdir, setCurrentSubdir] = createSignal(".");
	const [selectedIndex, setSelectedIndex] = createSignal(0);
	const [refreshTrigger, setRefreshTrigger] = createSignal(0);
	const [searchQuery, setSearchQuery] = createSignal("");
	const fb = useFileBrowser();
	/**
	 * Effective filesystem root.
	 *
	 * Priority: uiStore.fileBrowserExternalRoot (set by "Open Folder…" / "Open Path…"
	 * to browse an arbitrary folder outside the active repo) > props.fsRoot (worktree)
	 * > props.repoPath. When external root is set, git status/ignore integration is
	 * best-effort — list_directory still works because it canonicalizes repo_path.
	 */
	const root = () => uiStore.state.fileBrowserExternalRoot || props.fsRoot || props.repoPath;

	/** Relative path of the file shown in the active editor OR diff tab, when it
	 * lives under the root this browser shows — for highlighting it in the tree
	 * like VS Code. Editor-first: opening a diff clears the editor's active id, so
	 * editor-first precedence resolves the visible tab correctly. Null otherwise. */
	const activeFilePath = createMemo(() => {
		const tab = editorTabsStore.getActive() ?? diffTabsStore.getActive();
		if (!tab) return null;
		const r = root();
		const tabFsRoot = "fsRoot" in tab ? tab.fsRoot : tab.repoPath;
		if (tabFsRoot !== r && tab.repoPath !== r) return null;
		return tab.filePath;
	});

	const contextMenu = createContextMenu();
	const smartPrompts = useSmartPrompts();

	// Rename dialog state
	const [renameDialogVisible, setRenameDialogVisible] = createSignal(false);
	const [renameTarget, setRenameTarget] = createSignal<DirEntry | null>(null);

	// Delete confirmation dialog state
	const [deleteDialogVisible, setDeleteDialogVisible] = createSignal(false);
	const [deleteTarget, setDeleteTarget] = createSignal<DirEntry | null>(null);

	// VS Code-style inline create: when set, an editable name row is rendered in
	// place in the listing (instead of a popup). `parent` is the dir the new item
	// is created in, relative to root(); "" = root.
	type CreateKind = "folder" | "file";
	const [inlineCreate, setInlineCreate] = createSignal<{ kind: CreateKind; parent: string } | null>(null);

	// File clipboard for Copy/Cut + Paste: every file that was selected when it
	// was copied. `sourceRoot` is the repo those entries came from — captured so
	// paste works across different repos (entry.path is relative to its own repo,
	// not the paste destination's).
	const [clipboard, setClipboard] = createSignal<{
		entries: DirEntry[];
		mode: "copy" | "cut";
		sourceRoot: string;
	} | null>(null);

	/** Repo-relative paths of the files cut from THIS root, for dimming their rows. */
	const cutPaths = createMemo((): ReadonlySet<string> => {
		const clip = clipboard();
		if (clip?.mode !== "cut" || clip.sourceRoot !== root()) return EMPTY_PATHS;
		return new Set(clip.entries.map((e) => e.path));
	});

	// Multi-selection, VS Code / Finder style: Cmd/Ctrl+click toggles a row and
	// Shift+click selects the range from the anchor. Paths are repo-relative. The
	// anchor is also where Cmd+V pastes in tree view (see keyboardPasteDir).
	const [selection, setSelection] = createSignal<ReadonlySet<string>>(EMPTY_PATHS);
	const [selectionAnchor, setSelectionAnchor] = createSignal<string | null>(null);
	let panelRef: HTMLDivElement | undefined;

	// Search mode: "filename" (default) or "content" (full-text grep)
	type SearchMode = "filename" | "content";
	const [searchMode, setSearchMode] = createSignal<SearchMode>("filename");
	const [contentSearching, setContentSearching] = createSignal(false);
	/**
	 * Content matches, grouped by file path and built incrementally: a streamed
	 * batch appends to the groups already on screen. Solid's `<For>` keys by
	 * reference, so regrouping into fresh objects on every batch threw away and
	 * rebuilt the whole result list each time — the Command Palette's append-only
	 * result array never does. A store (not a signal) so appending to one group's
	 * `matches` updates that group's rows without touching the outer list.
	 */
	const [contentMatchGroups, setContentMatchGroups] = createStore<{ path: string; matches: ContentMatch[] }[]>([]);
	const [contentMatchCount, setContentMatchCount] = createSignal(0);
	/** Group index per file path, so appending a match is O(1). */
	const groupIndexByPath = new Map<string, number>();

	const resetContentMatches = () => {
		groupIndexByPath.clear();
		setContentMatchGroups([]);
		setContentMatchCount(0);
	};

	const appendContentMatches = (matches: ContentMatch[]) => {
		if (matches.length === 0) return;
		setContentMatchGroups(
			produce((groups) => {
				for (const m of matches) {
					let idx = groupIndexByPath.get(m.path);
					if (idx === undefined) {
						idx = groups.length;
						groupIndexByPath.set(m.path, idx);
						groups.push({ path: m.path, matches: [] });
					}
					groups[idx].matches.push(m);
				}
			}),
		);
		setContentMatchCount((n) => n + matches.length);
	};
	const [contentStats, setContentStats] = createSignal<{
		filesSearched: number;
		filesSkipped: number;
		truncated: boolean;
	}>({ filesSearched: 0, filesSkipped: 0, truncated: false });
	const [caseSensitive, setCaseSensitive] = createSignal(false);
	const [useRegex, setUseRegex] = createSignal(false);
	const [wholeWord, setWholeWord] = createSignal(false);

	// Sort mode: "name" (default, dirs first + alpha) or "date" (dirs first + newest first)
	type SortMode = "name" | "date";
	const [sortBy, setSortBy] = createSignal<SortMode>("name");
	const [sortDropdownOpen, setSortDropdownOpen] = createSignal(false);

	// Scroll position cache: saves scrollTop + selectedIndex per subdir path
	const scrollCache = new Map<string, { scrollTop: number; selectedIndex: number }>();
	// Per-root subdir memory: when the user switches repos and comes back, restore
	// the directory they were browsing instead of resetting to root. The panel
	// instance persists across repo switches (only props.repoPath changes), so a
	// component-scoped map survives. (#72)
	const rootToSubdir = new Map<string, string>();
	// Per-root search filter memory: the filter is scoped to each repo, never shared
	// across them. Saved/restored alongside the subdir on root switch. (#72)
	const rootToSearchQuery = new Map<string, string>();
	let contentRef: HTMLDivElement | undefined;
	let searchInputRef: HTMLInputElement | undefined;
	let pendingScrollRestore: string | null = null;

	// Cmd+Shift+F (toggle-file-browser-content-search) bumps this nonce. Enter
	// content-search mode and focus the input. Guard the initial 0 so a fresh
	// mount doesn't force content mode; the panel instance persists (hidden via
	// CSS, not unmounted) so this fires even when re-triggered while open.
	createEffect(() => {
		const nonce = uiStore.state.fileBrowserContentSearchNonce;
		if (nonce === 0) return;
		if (untrack(searchMode) !== "content") {
			setSearchMode("content");
			setSearchResults([]); // clear filename-mode results
			setSelectedIndex(0);
		}
		requestAnimationFrame(() => searchInputRef?.focus());
	});

	const changeSubdir = (newSubdir: string) => {
		if (contentRef) {
			scrollCache.set(currentSubdir(), { scrollTop: contentRef.scrollTop, selectedIndex: selectedIndex() });
		}
		pendingScrollRestore = newSubdir;
		setCurrentSubdir(newSubdir);
		// Keep keyboard focus in the panel after navigating into a directory. Entry
		// rows aren't focusable in WebKit, so a click never grants the panel focus —
		// without this, Cmd+C/X/V (which require panel focus, line ~919) silently
		// no-op after entering a folder.
		document.getElementById("file-browser-panel")?.focus();
	};

	// Tree view state
	const viewMode = () => uiStore.state.fileBrowserViewMode;
	const [expandedDirs, setExpandedDirs] = createSignal<Set<string>>(new Set());
	const [treeCache, setTreeCache] = createSignal<Map<string, DirEntry[]>>(new Map());

	const toggleExpand = (path: string) => {
		setExpandedDirs((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	};

	const onChildrenLoaded = (path: string, children: DirEntry[]) => {
		setTreeCache((prev) => {
			const next = new Map(prev);
			next.set(path, children);
			return next;
		});
	};

	/**
	 * Reveal the active editor file: in tree view, expand its ancestor dirs (loading
	 * children as needed) so the highlighted row is mounted; then scroll it into
	 * view. Flat view only scrolls when the file is in the current listing.
	 * `mode`/`searching` are passed in (already tracked by the effect); tree-state
	 * reads here are untracked to avoid re-triggering on our own expand/load.
	 */
	const revealActiveFile = async (rel: string, mode: string, searching: boolean) => {
		const fsRoot = root();
		if (fsRoot && mode === "tree" && !searching) {
			const parts = rel.split("/");
			let acc = "";
			for (let i = 0; i < parts.length - 1; i++) {
				acc = acc ? `${acc}/${parts[i]}` : parts[i];
				if (!treeCache().has(acc)) {
					try {
						onChildrenLoaded(acc, await fb.listDirectory(fsRoot, acc));
					} catch (err) {
						appLogger.debug("app", "reveal: listDirectory failed", { path: acc, error: String(err) });
						return;
					}
				}
				setExpandedDirs((prev) => (prev.has(acc) ? prev : new Set(prev).add(acc)));
			}
		}
		// Let the newly-expanded rows render, then scroll the active row into view.
		requestAnimationFrame(() => {
			contentRef?.querySelector(`.${s.entryActive}`)?.scrollIntoView({ block: "nearest" });
		});
	};

	createEffect(() => {
		const rel = activeFilePath();
		const mode = viewMode();
		const searching = !!searchQuery().trim();
		if (!rel || !props.visible) return;
		untrack(() => void revealActiveFile(rel, mode, searching));
	});

	// Directory watcher revision — bumped when dir-changed event arrives
	const [dirRevision, setDirRevision] = createSignal(0);

	// Track repoPath changes to reset subdir synchronously before fetching
	let lastRepoPath: string | null = null;
	// Generation counter: incremented on every effect run so stale async fetches are discarded
	let fetchGeneration = 0;

	// Load entries when visible, repo changes, subdir changes, or repo content changes
	createEffect(() => {
		if (!props.visible || !root()) {
			setEntries([]);
			return;
		}

		const fsRoot = root()!;
		const gen = ++fetchGeneration;

		// Restore subdir when root changes (merged from separate effect to avoid double fetch)
		if (fsRoot !== lastRepoPath) {
			// Remember where we were in the previous root before switching away. (#72)
			if (lastRepoPath !== null) {
				rootToSubdir.set(
					lastRepoPath,
					untrack(() => currentSubdir()),
				);
				rootToSearchQuery.set(
					lastRepoPath,
					untrack(() => searchQuery()),
				);
			}
			lastRepoPath = fsRoot;
			scrollCache.clear();
			// Tree state is keyed by repo-relative path, so it would otherwise show the
			// previous repo's children under a same-named node in the new one.
			setTreeCache(new Map());
			setExpandedDirs(new Set<string>());
			pendingScrollRestore = null;
			setCurrentSubdir(rootToSubdir.get(fsRoot) ?? ".");
			setSearchQuery(rootToSearchQuery.get(fsRoot) ?? "");
		}

		const subdir = currentSubdir();
		// Subscribe to repo revision for auto-refresh on git changes
		void (props.repoPath ? repositoriesStore.getRevision(props.repoPath) : 0);
		// Subscribe to dir watcher revision for auto-refresh on filesystem changes
		const dirRev = dirRevision();
		// Also subscribe to manual refresh trigger
		void refreshTrigger();

		// Preserve selection by path on dir-watcher refreshes (dirRev > 0)
		// untrack: reading filteredEntries inside this effect would create a circular
		// dependency (effect sets entries → filteredEntries recomputes → effect re-runs)
		const prevSelectedPath = dirRev > 0 ? untrack(() => filteredEntries()[selectedIndex()]?.path) : undefined;

		// Only show loading spinner on initial load — suppress it on auto-refreshes to
		// avoid visible flicker when the directory content hasn't actually changed.
		const isInitialLoad = untrack(() => entries().length === 0);
		if (isInitialLoad) setLoading(true);
		setError(null);

		(async () => {
			try {
				const result = await fb.listDirectory(fsRoot, subdir);
				// Discard stale results: a newer effect run has already started a fresh fetch
				if (gen !== fetchGeneration) return;
				// Skip re-render when entries are identical: same count and every entry
				// matches on the fields that drive visible state (path, git badge, mtime,
				// ignored flag). New object instances from Rust would otherwise cause a
				// full DOM repaint even when nothing changed.
				const current = untrack(() => entries());
				const changed =
					current.length !== result.length ||
					result.some((e, i) => {
						const c = current[i];
						return (
							e.path !== c.path ||
							e.git_status !== c.git_status ||
							e.modified_at !== c.modified_at ||
							e.is_ignored !== c.is_ignored
						);
					});
				if (changed) {
					setEntries(result);
					const cached = pendingScrollRestore !== null ? scrollCache.get(pendingScrollRestore) : undefined;
					pendingScrollRestore = null;
					if (cached) {
						setSelectedIndex(Math.min(cached.selectedIndex, result.length - 1));
						requestAnimationFrame(() => {
							if (contentRef) contentRef.scrollTop = cached.scrollTop;
						});
					} else if (prevSelectedPath) {
						const idx = result.findIndex((e) => e.path === prevSelectedPath);
						setSelectedIndex(idx >= 0 ? idx : 0);
					} else {
						setSelectedIndex(0);
					}
				}
			} catch (err) {
				if (gen !== fetchGeneration) return;
				// A remembered subdir may have been deleted while we were away (#72) —
				// fall back to the root instead of stranding the user on an error.
				if (subdir !== ".") {
					rootToSubdir.delete(fsRoot);
					setCurrentSubdir(".");
					return;
				}
				setError(String(err));
				setEntries([]);
			} finally {
				if (gen === fetchGeneration) setLoading(false);
			}
		})();
	});

	// Directory watcher lifecycle: start/stop watcher as directory or visibility changes
	createEffect(() => {
		if (!props.visible || !root()) return;

		const fsRoot = root()!;
		const subdir = currentSubdir();
		// Don't watch during search (search is recursive, watcher is not)
		if (searchQuery().trim()) return;

		const absPath = subdir === "." || subdir === "" ? fsRoot : `${fsRoot}/${subdir}`;

		invoke("start_dir_watcher", { path: absPath }).catch((err) => {
			appLogger.warn("app", `Dir watcher failed for ${absPath}: ${err}`);
		});

		// Listen for dir-changed events matching this path. Tree-cache invalidation
		// is NOT done here: `dir_path` is absolute while treeCache is keyed by
		// repo-relative paths, and this watcher is non-recursive so it never sees
		// writes into expanded subfolders anyway. The revalidation effect below
		// handles the tree off this revision bump.
		const unlisten = listen<{ dir_path: string }>("dir-changed", (event) => {
			if (event.payload.dir_path === absPath) {
				setDirRevision((n) => n + 1);
				// Invalidate only the changed directory in tree cache. The payload path is
				// absolute; tree cache keys are repo-relative, and `subdir` is exactly the
				// relative form of the watched `absPath` — deleting the absolute path never
				// matched a key, so the subtree stayed stale forever.
				setTreeCache((prev) => {
					if (!prev.has(subdir)) return prev;
					const next = new Map(prev);
					next.delete(subdir);
					return next;
				});
			}
		});

		onCleanup(() => {
			invoke("stop_dir_watcher", { path: absPath }).catch((err) => {
				appLogger.warn("app", `Failed to stop dir watcher for ${absPath}`, err);
			});
			unlisten.then((fn) => fn());
		});
	});

	// Tree-cache revalidation. TreeNode fetches a folder's children once, on first
	// expand, and never again while the key stays in treeCache — so re-listing the
	// root leaves every expanded subfolder frozen at its first read. In-app creates
	// hid this by wiping the whole cache via refresh(); externally written files
	// (an agent, the terminal) have no such path and so never appeared in tree view
	// while flat view — which renders straight off entries() — updated fine.
	//
	// Re-list each cached folder and swap in only the ones that actually changed:
	// wiping the cache instead would collapse every expanded folder to empty for a
	// frame, and handing back fresh arrays for unchanged folders would repaint the
	// whole tree on every watcher tick.
	let treeRevalidateGeneration = 0;
	createEffect(() => {
		if (!props.visible || viewMode() !== "tree") return;
		const fsRoot = root();
		if (!fsRoot) return;
		// The cache belongs to the root the listing effect last loaded, and that
		// effect resets it when the root changes. Effects re-run in an order Solid
		// reshuffles as subscribers come and go, so on a switch this one can run
		// first — and would re-list the previous repo's folders under the new root.
		if (fsRoot !== lastRepoPath) return;
		// Both signals: repo-changed is recursive but skips gitignored paths, the
		// dir watcher is non-recursive but sees them for the current directory.
		void (props.repoPath ? repositoriesStore.getRevision(props.repoPath) : 0);
		void dirRevision();
		void refreshTrigger();

		const cached = untrack(() => treeCache());
		if (cached.size === 0) return;
		const gen = ++treeRevalidateGeneration;

		void revalidateTreeCache(cached, (dir) => fb.listDirectory(fsRoot, dir)).then((next) => {
			if (gen !== treeRevalidateGeneration || next === cached) return;
			setTreeCache(next);
		});
	});

	// Search results from recursive Rust search (when query is active)
	const [searchResults, setSearchResults] = createSignal<DirEntry[]>([]);
	const [searching, setSearching] = createSignal(false);

	// Debounced recursive filename search — only fires in filename mode
	createEffect(() => {
		if (searchMode() !== "filename") return;
		const q = searchQuery().trim();
		const fsRoot = root();

		if (!q || !fsRoot) {
			setSearchResults([]);
			setSearching(false);
			return;
		}

		setSearching(true);
		const timer = setTimeout(async () => {
			try {
				const results = await fb.searchFiles(fsRoot, q);
				setSearchResults(results);
				setSelectedIndex(0);
			} catch (err) {
				appLogger.error("app", "File search failed", err);
				setSearchResults([]);
			} finally {
				setSearching(false);
			}
		}, 200);

		onCleanup(() => clearTimeout(timer));
	});

	// Content search — fires when in content mode and query changes
	createEffect(() => {
		if (searchMode() !== "content") return;
		const q = searchQuery().trim();
		const fsRoot = root();

		if (!q || q.length < 3 || !fsRoot) {
			resetContentMatches();
			setContentSearching(false);
			setContentStats({ filesSearched: 0, filesSkipped: 0, truncated: false });
			return;
		}

		// Track current search options as reactive deps
		const opts: ContentSearchOptions = {
			caseSensitive: caseSensitive(),
			useRegex: useRegex(),
			wholeWord: wholeWord(),
		};

		setContentSearching(true);
		resetContentMatches();
		setContentStats({ filesSearched: 0, filesSkipped: 0, truncated: false });

		let cancelled = false;
		let unlistenSearch: (() => void) | null = null;

		const timer = setTimeout(async () => {
			if (cancelled) return;

			try {
				// Subscribing and starting are one call: they share the search's
				// correlation id, without which this panel would collect the
				// command palette's matches too.
				const unlisten = await fb.searchContent(
					fsRoot,
					q,
					{
						onBatch: (batch) => {
							if (cancelled) return;
							appendContentMatches(batch.matches);
							setContentStats({
								filesSearched: batch.files_searched,
								filesSkipped: batch.files_skipped,
								truncated: batch.truncated,
							});
							if (batch.is_final) {
								setContentSearching(false);
							}
						},
						onError: (err) => {
							if (cancelled) return;
							appLogger.error("app", "Content search error", err);
							setContentSearching(false);
						},
					},
					opts,
				);
				if (cancelled) {
					unlisten();
					return;
				}
				unlistenSearch = unlisten;
			} catch (err) {
				if (!cancelled) {
					appLogger.error("app", "Content search failed", err);
					setContentSearching(false);
				}
			}
		}, 500);

		onCleanup(() => {
			cancelled = true;
			clearTimeout(timer);
			unlistenSearch?.();
		});
	});

	/** Visible entries: search results when query active, directory listing otherwise, sorted */
	const filteredEntries = createMemo(() => {
		const raw = searchQuery().trim() ? searchResults() : entries();
		if (sortBy() === "name") return raw; // already sorted by name from Rust
		// Sort by date: dirs first, then newest first
		return [...raw].sort((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || b.modified_at - a.modified_at);
	});

	/**
	 * Re-read the current directory after a mutation (create, delete, rename,
	 * duplicate, paste).
	 *
	 * The tree cache is dropped too, and deliberately in full rather than for the
	 * one affected parent: every mutation handler calls this, and a per-path
	 * variant only works if all of them pass the right path — the flat list was
	 * refreshing correctly while the tree kept serving stale children precisely
	 * because the tree had no such call at all. Expanded nodes re-read themselves
	 * (see TreeNode's effect), and a mutation is user-initiated and rare, so the
	 * extra listings cost nothing measurable.
	 */
	const refresh = () => {
		setTreeCache(new Map());
		setRefreshTrigger((n) => n + 1);
	};

	/**
	 * Every entry row on screen, in on-screen order: what a Shift+click range
	 * runs over, and the only rows a selection action may touch. The flat list
	 * (and any filename search) renders `filteredEntries()`; tree view renders it
	 * depth-first, descending into each expanded folder whose children are
	 * loaded, which is TreeNode's own render order. Content search shows no rows.
	 */
	const visibleRows = createMemo((): DirEntry[] => {
		if (searchMode() !== "filename") return [];
		const top = filteredEntries();
		if (viewMode() !== "tree" || searchQuery().trim()) return top;
		const expanded = expandedDirs();
		const cache = treeCache();
		const rows: DirEntry[] = [];
		const walk = (list: DirEntry[]) => {
			for (const entry of list) {
				rows.push(entry);
				if (entry.is_dir && expanded.has(entry.path)) walk(cache.get(entry.path) ?? []);
			}
		};
		walk(top);
		return rows;
	});

	/** The selected rows still on screen, in on-screen order. Rows inside a folder
	 *  collapsed since they were picked are left out: an action never touches a
	 *  file the user can no longer see. */
	const selectedRows = createMemo((): DirEntry[] => {
		const picked = selection();
		if (picked.size === 0) return [];
		return visibleRows().filter((e) => picked.has(e.path));
	});

	const selectOnly = (entry: DirEntry) => {
		setSelection(new Set([entry.path]));
		setSelectionAnchor(entry.path);
	};

	const clearSelection = () => {
		setSelection(EMPTY_PATHS);
		setSelectionAnchor(null);
	};

	// Rows aren't focusable and a click on one does not hand WebKit's focus to the
	// panel, but the copy/paste shortcuts only listen while the panel has focus.
	const focusPanel = () => panelRef?.focus({ preventScroll: true });

	/**
	 * Apply a click's modifiers to the selection: Cmd/Ctrl toggles the row, Shift
	 * selects the range from the anchor, Cmd/Ctrl+Shift adds that range. Returns
	 * true for any of those, and the caller must then neither open the file nor
	 * enter/expand the folder. A plain click returns false.
	 */
	const applySelectionClick = (entry: DirEntry, e: MouseEvent): boolean => {
		const toggle = e.metaKey || e.ctrlKey;
		if (!toggle && !e.shiftKey) return false;
		focusPanel();
		if (e.shiftKey) {
			const rows = visibleRows();
			const anchor = selectionAnchor();
			const from = anchor === null ? -1 : rows.findIndex((r) => r.path === anchor);
			const to = rows.findIndex((r) => r.path === entry.path);
			if (from < 0 || to < 0) {
				selectOnly(entry);
				return true;
			}
			const range = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map((r) => r.path);
			setSelection(new Set(toggle ? [...selection(), ...range] : range));
			return true;
		}
		const next = new Set(selection());
		if (next.has(entry.path)) next.delete(entry.path);
		else next.add(entry.path);
		setSelection(next);
		setSelectionAnchor(entry.path);
		return true;
	};

	// A selection belongs to the listing it was made in. Another root, folder,
	// search, search mode or view drops it, so a copy never picks up rows that
	// are no longer on screen.
	createEffect(on([root, currentSubdir, searchQuery, searchMode, viewMode], clearSelection, { defer: true }));

	const navigateInto = (entry: DirEntry) => {
		changeSubdir(entry.path);
	};

	const navigateUp = () => {
		const current = currentSubdir();
		if (current === "." || current === "") return;
		const parts = current.split("/");
		parts.pop();
		changeSubdir(parts.length === 0 ? "." : parts.join("/"));
	};

	const handleEntryClick = (entry: DirEntry) => {
		if (entry.is_dir) {
			navigateInto(entry);
		} else if (root()) {
			props.onFileOpen(root()!, entry.path);
		}
	};

	// Breadcrumb segments from currentSubdir
	const breadcrumbs = () => {
		const subdir = currentSubdir();
		if (subdir === "." || subdir === "") return [];
		return subdir.split("/");
	};

	const handleBreadcrumbClick = (index: number) => {
		const segments = breadcrumbs();
		if (index < 0) {
			changeSubdir(".");
		} else {
			changeSubdir(segments.slice(0, index + 1).join("/"));
		}
	};

	// Context menu actions
	const handleRename = (entry: DirEntry) => {
		setRenameTarget(entry);
		setRenameDialogVisible(true);
	};

	const handleDelete = (entry: DirEntry) => {
		setDeleteTarget(entry);
		setDeleteDialogVisible(true);
	};

	const confirmDelete = async () => {
		const entry = deleteTarget();
		if (!entry || !root()) return;
		setDeleteDialogVisible(false);
		try {
			await fb.deletePath(root()!, entry.path);
			refresh();
		} catch (err) {
			appLogger.error("app", "Failed to delete", err);
			toastsStore.add(t("fileBrowser.deleteFailed", "Couldn't delete"), String(err), "error");
		}
	};

	/** Compute the parent dir (relative to root) for creating a new item next to `entry`.
	 *  If entry is a folder → create inside it; if file → create as a sibling. */
	const parentDirFor = (entry: DirEntry | null): string => {
		if (!entry) return currentSubdir() === "." ? "" : currentSubdir();
		if (entry.is_dir) return entry.path;
		const idx = entry.path.lastIndexOf("/");
		return idx >= 0 ? entry.path.slice(0, idx) : "";
	};

	/** The folder the flat list shows, relative to root(); "" is the root. */
	const currentDirRel = () => (currentSubdir() === "." ? "" : currentSubdir());

	/**
	 * Where Cmd+V pastes. Tree view has no current folder of its own (its
	 * `currentSubdir` stays at the root), so, as in VS Code, it pastes where the
	 * last-clicked row is: into that folder, or beside that file. The flat list
	 * pastes into the folder it shows.
	 */
	const keyboardPasteDir = (): string => {
		if (viewMode() !== "tree" || searchQuery().trim()) return currentDirRel();
		const anchor = selectionAnchor();
		const row = anchor !== null && selection().has(anchor) ? visibleRows().find((e) => e.path === anchor) : undefined;
		return row ? parentDirFor(row) : currentDirRel();
	};

	const startInlineCreate = (kind: CreateKind, parent: string) => {
		// In tree view, expand the target folder so the inline input row is visible.
		if (viewMode() === "tree" && parent) {
			setExpandedDirs((prev) => (prev.has(parent) ? prev : new Set(prev).add(parent)));
		}
		setInlineCreate({ kind, parent });
	};

	const handleCreateConfirm = async (kind: CreateKind, parent: string, name: string) => {
		const fsRoot = root();
		if (!fsRoot || !name.trim()) return;
		const relPath = parent ? `${parent}/${name.trim()}` : name.trim();
		try {
			if (kind === "folder") {
				await fb.createDirectory(fsRoot, relPath);
				refresh();
			} else {
				await fb.createFile(fsRoot, relPath);
				refresh();
				// VS Code-style: open the new file in the editor so you can type right
				// away. Setting the active editor path also drives revealActiveFile,
				// which expands ancestors and scrolls the new row into view.
				props.onFileOpen(fsRoot, relPath);
			}
		} catch (err) {
			appLogger.error("app", `Failed to create ${kind}`, err);
			toastsStore.add(
				kind === "folder"
					? t("fileBrowser.createFolderFailed", "Couldn't create folder")
					: t("fileBrowser.createFileFailed", "Couldn't create file"),
				String(err),
				"error",
			);
		}
	};

	/** VS Code-style inline name input, rendered as a row in the listing.
	 *  Enter/blur commits, Escape cancels; duplicate names block commit with an
	 *  inline error. Remounts (and so resets) each time inlineCreate is set. */
	const InlineCreateRow: Component<{ depth?: number }> = (p) => {
		const [value, setValue] = createSignal("");
		let done = false;

		const req = () => inlineCreate();
		const isFolder = () => req()?.kind === "folder";

		// Known listing of the target dir, for duplicate-name validation. Empty
		// when we don't have it cached — the backend still refuses collisions.
		const siblings = (): DirEntry[] => {
			const parent = req()?.parent ?? "";
			const current = currentSubdir() === "." ? "" : currentSubdir();
			if (viewMode() === "tree" && parent !== "") return treeCache().get(parent) ?? [];
			return parent === current ? entries() : [];
		};
		const duplicate = () => {
			const v = value().trim();
			return !!v && siblings().some((e) => e.name === v);
		};

		// In flat view the row always renders in the current listing, so show
		// where the item actually lands when that's a different (deeper) dir.
		const prefix = () => {
			const parent = req()?.parent ?? "";
			const current = currentSubdir() === "." ? "" : currentSubdir();
			if (viewMode() === "tree" || parent === current) return "";
			return parent.startsWith(`${current}/`) ? parent.slice(current.length + 1) : parent;
		};

		const finish = (commit: boolean) => {
			if (done) return;
			done = true;
			const r = req();
			const v = value().trim();
			setInlineCreate(null);
			if (commit && r && v && !duplicate()) void handleCreateConfirm(r.kind, r.parent, v);
		};

		return (
			<div class={cx(s.entry, s.inlineCreateRow)} style={{ "padding-left": `${8 + (p.depth ?? 0) * 16}px` }}>
				<FileIcon name={isFolder() ? value() : value() || "file"} isDir={isFolder()} class={s.entryIcon} />
				<Show when={prefix()}>
					<span class={s.inlineCreatePrefix}>{prefix()}/</span>
				</Show>
				<div class={s.inlineCreateBox}>
					<input
						class={cx(s.inlineCreateInput, duplicate() && s.inlineCreateInputError)}
						value={value()}
						spellcheck={false}
						autocomplete="off"
						aria-label={
							isFolder() ? t("fileBrowser.newFolderTitle", "New Folder") : t("fileBrowser.newFileTitle", "New File")
						}
						ref={(el) => queueMicrotask(() => el.focus())}
						onInput={(e) => setValue(e.currentTarget.value)}
						onKeyDown={(e) => {
							e.stopPropagation();
							if (e.key === "Enter") {
								e.preventDefault();
								if (!duplicate()) finish(true);
							} else if (e.key === "Escape") {
								e.preventDefault();
								finish(false);
							}
						}}
						onBlur={() => finish(!duplicate())}
					/>
					<Show when={duplicate()}>
						<div class={s.inlineCreateError}>
							{t("fileBrowser.nameExists", "A file or folder with this name already exists here")}
						</div>
					</Show>
				</div>
			</div>
		);
	};

	const handleDuplicate = async (entry: DirEntry) => {
		if (!root()) return;
		// Build "name copy" / "name copy.ext" style suffix
		const idx = entry.name.lastIndexOf(".");
		const hasExt = !entry.is_dir && idx > 0;
		const base = hasExt ? entry.name.slice(0, idx) : entry.name;
		const ext = hasExt ? entry.name.slice(idx) : "";
		const parent = entry.path.lastIndexOf("/") >= 0 ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
		const dupName = `${base} copy${ext}`;
		const dupPath = parent ? `${parent}/${dupName}` : dupName;
		try {
			await fb.copyPath(root()!, entry.path, dupPath);
			refresh();
		} catch (err) {
			appLogger.error("app", "Failed to duplicate", err);
			toastsStore.add(t("fileBrowser.duplicateFailed", "Couldn't duplicate"), String(err), "error");
		}
	};

	const handleRevealInOS = async (entry: DirEntry) => {
		const fsRoot = root();
		if (!fsRoot) return;
		const abs = isAbsolutePath(entry.path) ? entry.path : joinPath(fsRoot, entry.path);
		try {
			const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
			await revealItemInDir(abs);
		} catch (err) {
			appLogger.error("app", "Failed to reveal in file manager", err);
		}
	};

	const handleAddToGitignore = async (entry: DirEntry) => {
		if (!root()) return;
		const pattern = entry.is_dir ? `${entry.path}/` : entry.path;
		try {
			await fb.addToGitignore(root()!, pattern);
			refresh();
		} catch (err) {
			appLogger.error("git", "Failed to add to .gitignore", err);
		}
	};

	/** Put the files among `picked` on the clipboard. A paste can only create
	 *  files, so folders stay behind. Returns how many files went on it. */
	const putOnClipboard = (picked: DirEntry[], mode: "copy" | "cut"): number => {
		const r = root();
		const files = picked.filter((e) => !e.is_dir);
		if (!r || files.length === 0) return 0;
		setClipboard({ entries: files, mode, sourceRoot: r });
		return files.length;
	};

	/**
	 * Cmd+C / Cmd+X. Acts on the selection; with none, on the row the flat list's
	 * arrow-key cursor is on (tree view draws no cursor, so there it does
	 * nothing). The context menu names its file count, so only this path has to
	 * say when folders were left out.
	 */
	const copyFromKeyboard = (mode: "copy" | "cut") => {
		let picked = selectedRows();
		if (picked.length === 0 && (viewMode() === "flat" || searchQuery().trim())) {
			const row = filteredEntries()[selectedIndex()];
			if (row) picked = [row];
		}
		if (picked.length === 0) return;
		const count = putOnClipboard(picked, mode);
		if (count === picked.length) return;
		toastsStore.add(
			count === 0
				? mode === "copy"
					? t("fileBrowser.foldersNotCopied", "Folders can't be copied")
					: t("fileBrowser.foldersNotCut", "Folders can't be cut")
				: mode === "copy"
					? t("fileBrowser.copiedFiles", "Copied {count}", { count: fileCount(count) })
					: t("fileBrowser.cutFiles", "Cut {count}", { count: fileCount(count) }),
			t("fileBrowser.onlyFilesCopied", "Only files can be copied or cut, so folders were left out."),
			"info",
		);
	};

	/**
	 * Paste the clipboard into `destRel`, a folder relative to root() ("" is the
	 * root; the default is the folder the flat list shows). One backend call
	 * pastes every file and never overwrites (see `paste_paths`), so a clean
	 * paste needs no toast: the pasted files come up selected, their folder
	 * expanded in tree view.
	 */
	const handlePaste = async (destRel: string = currentDirRel()) => {
		const clip = clipboard();
		const destRoot = root();
		if (!clip || !destRoot) return;
		// Absolute paths, so a paste can cross repos: the sources belong to
		// clip.sourceRoot, the destination to the repo on screen now.
		const sources = clip.entries.map((e) => (isAbsolutePath(e.path) ? e.path : joinPath(clip.sourceRoot, e.path)));
		const destDir = destRel ? joinPath(destRoot, destRel) : destRoot;
		let result: PasteResult;
		try {
			result = await fb.pastePaths(sources, destDir, clip.mode === "copy" ? "copy" : "move");
		} catch (err) {
			appLogger.error("app", `Failed to ${clip.mode === "copy" ? "copy" : "move"}`, err);
			toastsStore.add(
				clip.mode === "copy" ? t("fileBrowser.copyFailed", "Copy failed") : t("fileBrowser.moveFailed", "Move failed"),
				String(err),
				"error",
			);
			return;
		}
		// A cut is spent once anything moved. When nothing did (every name taken,
		// or pasted back into its own folder) it stays, ready to paste elsewhere.
		if (clip.mode === "cut" && result.pasted.length > 0) setClipboard(null);
		refresh();
		// The panel may have moved to another repo while the paste ran; its rows
		// are not the ones just pasted, so select and expand nothing there.
		if (result.pasted.length > 0 && root() === destRoot) {
			const tree = viewMode() === "tree" && !searchQuery().trim();
			if (tree && destRel) setExpandedDirs((prev) => (prev.has(destRel) ? prev : new Set(prev).add(destRel)));
			if (tree || destRel === currentDirRel()) {
				const pasted = result.pasted.map((name) => (destRel ? `${destRel}/${name}` : name));
				setSelection(new Set(pasted));
				setSelectionAnchor(pasted[0]);
			}
		}
		reportPasteProblems(result, clip.mode);
	};

	/** Name the files a paste left out. A paste that took everything says nothing. */
	const reportPasteProblems = (result: PasteResult, mode: "copy" | "cut") => {
		const problems = [
			...result.skipped.map((name) =>
				t("fileBrowser.pasteNameTaken", "{name}: a file with that name is already there", { name }),
			),
			...result.errors,
		];
		if (problems.length === 0) return;
		appLogger.warn("app", "Paste left files out", { skipped: result.skipped, errors: result.errors });
		const done = result.pasted.length;
		const counts = { done: String(done), total: String(done + problems.length) };
		const title =
			done === 0
				? mode === "copy"
					? t("fileBrowser.copyFailed", "Copy failed")
					: t("fileBrowser.moveFailed", "Move failed")
				: mode === "copy"
					? t("fileBrowser.copiedSome", "Copied {done} of {total} files", counts)
					: t("fileBrowser.movedSome", "Moved {done} of {total} files", counts);
		const more =
			problems.length > 3
				? ` \u00B7 ${t("fileBrowser.andMore", "and {count} more", { count: String(problems.length - 3) })}`
				: "";
		toastsStore.add(title, problems.slice(0, 3).join(" \u00B7 ") + more, done === 0 ? "error" : "warn");
	};

	const handleRenameConfirm = async (newName: string) => {
		const entry = renameTarget();
		if (!entry || !root()) return;
		// Build new path: same parent directory, new name
		const newPath = replaceBasename(entry.path, newName);
		try {
			await fb.renamePath(root()!, entry.path, newPath);
			refresh();
		} catch (err) {
			appLogger.error("app", "Failed to rename", err);
			toastsStore.add(t("fileBrowser.renameFailed", "Couldn't rename"), String(err), "error");
		}
	};

	// Pointer-based drag: internal moves via pointer events (HTML5 DnD and
	// startNativeDrag both broken in WKWebView with dragDropEnabled).
	// When the pointer leaves the file browser panel, hands off to native drag
	// for cross-app drops (Finder, Slack, etc.).
	let _ptrSrc: string | null = null;
	let _ptrActive = false;
	let _ptrSuppressClick = false;
	let _ptrHi: HTMLElement | null = null;
	let _ptrGhost: HTMLElement | null = null;
	let _ptrRaf = 0;

	const ptrCleanup = () => {
		if (_ptrRaf) {
			cancelAnimationFrame(_ptrRaf);
			_ptrRaf = 0;
		}
		_ptrHi?.classList.remove("drop-target-hover");
		_ptrHi = null;
		_ptrGhost?.remove();
		_ptrGhost = null;
		document.body.style.cursor = "";
	};

	const findDropFolder = (x: number, y: number, excludeSrc?: string | null): HTMLElement | null => {
		let cur: Element | null = document.elementFromPoint(x, y);
		while (cur) {
			const dt = (cur as HTMLElement).dataset;
			if (dt?.dropTarget === "folder" && dt.absPath && dt.absPath !== excludeSrc) return cur as HTMLElement;
			cur = cur.parentElement;
		}
		return null;
	};

	const ptrHighlight = (x: number, y: number) => {
		const target = findDropFolder(x, y, _ptrSrc);
		if (target === _ptrHi) return;
		_ptrHi?.classList.remove("drop-target-hover");
		_ptrHi = target;
		_ptrHi?.classList.add("drop-target-hover");
	};

	const ptrGhost = (name: string, x: number, y: number) => {
		if (!_ptrGhost) {
			_ptrGhost = document.createElement("div");
			_ptrGhost.className = "ptr-drag-ghost";
			document.body.appendChild(_ptrGhost);
		}
		_ptrGhost.textContent = name;
		_ptrGhost.style.left = `${x + 12}px`;
		_ptrGhost.style.top = `${y - 8}px`;
	};

	const handlePointerDragStart = (absPath: string, e: PointerEvent) => {
		if (e.button !== 0) return;
		// Must mark before drag threshold — Tauri's onDragDropEvent fires on any pointer
		// hold, and without this flag the OS drop handler in dragDrop.ts would treat an
		// internal file-browser drag as an external Finder drop (wrong dispatch path).
		markInternalDragStart();
		_ptrSrc = absPath;
		_ptrActive = false;
		const startX = e.clientX,
			startY = e.clientY;
		const name = absPath.slice(absPath.lastIndexOf("/") + 1);
		const panel = document.getElementById("file-browser-panel");

		const detachAll = () => {
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onAbort);
			window.removeEventListener("blur", onAbort);
		};

		const onMove = (me: PointerEvent) => {
			if (!_ptrActive) {
				if (Math.hypot(me.clientX - startX, me.clientY - startY) < 5) return;
				_ptrActive = true;
				document.body.style.cursor = "grabbing";
			}
			if (panel && !panel.contains(document.elementFromPoint(me.clientX, me.clientY))) {
				const src = _ptrSrc;
				detachAll();
				ptrCleanup();
				_ptrSrc = null;
				_ptrActive = false;
				markInternalDragEnd();
				if (src) startNativeDrag([src]);
				return;
			}
			if (!_ptrRaf) {
				_ptrRaf = requestAnimationFrame(() => {
					_ptrRaf = 0;
					ptrHighlight(me.clientX, me.clientY);
					ptrGhost(name, me.clientX, me.clientY);
				});
			}
		};

		const onUp = (ue: PointerEvent) => {
			markInternalDragEnd();
			detachAll();
			ptrCleanup();
			if (_ptrActive && _ptrSrc) {
				const target = findDropFolder(ue.clientX, ue.clientY);
				if (target?.dataset.absPath) performFileMove(_ptrSrc, target.dataset.absPath);
				_ptrSuppressClick = true;
				requestAnimationFrame(() => {
					_ptrSuppressClick = false;
				});
			}
			_ptrSrc = null;
			_ptrActive = false;
		};

		const onAbort = () => {
			markInternalDragEnd();
			detachAll();
			ptrCleanup();
			_ptrSrc = null;
			_ptrActive = false;
		};

		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
		document.addEventListener("pointercancel", onAbort);
		window.addEventListener("blur", onAbort);
	};

	const performFileMove = async (sourcePath: string, targetFolderAbsPath: string) => {
		const fsRoot = root();
		if (!fsRoot) return;

		const sourceDir = sourcePath.slice(0, sourcePath.lastIndexOf("/"));
		if (targetFolderAbsPath === sourceDir || targetFolderAbsPath === sourcePath) return;
		if (targetFolderAbsPath.startsWith(`${sourcePath}/`)) return;

		const prefix = fsRoot.endsWith("/") ? fsRoot : `${fsRoot}/`;
		const relSource = sourcePath.startsWith(prefix) ? sourcePath.slice(prefix.length) : sourcePath;
		const fileName = sourcePath.slice(sourcePath.lastIndexOf("/") + 1);
		const relTarget = targetFolderAbsPath.startsWith(prefix)
			? targetFolderAbsPath.slice(prefix.length)
			: targetFolderAbsPath;
		const relDest = `${relTarget}/${fileName}`;

		try {
			await fb.renamePath(fsRoot, relSource, relDest);
			refresh();
		} catch (err) {
			appLogger.error("app", "Failed to move file via drag", err);
		}
	};

	/** TreeNode's click hook. A selection gesture stays one; a plain click selects
	 *  just that row, then TreeNode opens the file or expands the folder. */
	const handleTreeRowClick = (entry: DirEntry, e: MouseEvent): boolean => {
		if (_ptrSuppressClick) return true;
		if (applySelectionClick(entry, e)) return true;
		selectOnly(entry);
		focusPanel();
		return false;
	};

	// Raw absolute path (VSCode "Copy Path" behavior — no ~ shortening)
	const handleCopyPath = (entry: DirEntry) => {
		const fsRoot = root();
		if (!fsRoot) return;
		const fullPath = `${fsRoot}/${entry.path}`;
		writeClipboard(fullPath).catch((err) => appLogger.error("app", "Failed to copy path", err));
	};

	// entry.path is already relative to the repo root (see DirEntry in types/fs.ts)
	const handleCopyRelativePath = (entry: DirEntry) => {
		writeClipboard(entry.path).catch((err) => appLogger.error("app", "Failed to copy relative path", err));
	};

	/**
	 * Menu for a right-click inside a multi-selection: what applies to every
	 * selected file at once. Single-item actions (rename, delete, reveal…) take a
	 * plain click on that row first, which selects it alone.
	 */
	const getSelectionMenuItems = (entry: DirEntry, picked: DirEntry[]): ContextMenuItem[] => {
		const mod = getModifierSymbol();
		const files = picked.filter((e) => !e.is_dir).length;
		const items: ContextMenuItem[] = [];
		if (files > 0) {
			items.push({
				label: t("fileBrowser.copySelected", "Copy {count}", { count: fileCount(files) }),
				shortcut: `${mod}C`,
				action: () => putOnClipboard(picked, "copy"),
			});
			items.push({
				label: t("fileBrowser.cutSelected", "Cut {count}", { count: fileCount(files) }),
				shortcut: `${mod}X`,
				action: () => putOnClipboard(picked, "cut"),
			});
		}
		items.push({
			label: t("fileBrowser.paste", "Paste"),
			shortcut: `${mod}V`,
			action: () => void handlePaste(parentDirFor(entry)),
			disabled: !clipboard(),
		});
		return items;
	};

	const getContextMenuItems = (entry: DirEntry): ContextMenuItem[] => {
		// Right-click inside a multi-selection: the menu acts on all of it.
		const picked = selectedRows();
		if (picked.length > 1 && picked.some((p) => p.path === entry.path)) return getSelectionMenuItems(entry, picked);

		const mod = getModifierSymbol();
		const items: ContextMenuItem[] = [];

		// Smart prompts with placement="file-context" — appear first when any exist.
		const fsRoot = root() ?? "";
		const abs = isAbsolutePath(entry.path) ? entry.path : joinPath(fsRoot, entry.path);
		const smartItem = fileContextSmartMenuItem({ absPath: abs, repoRoot: fsRoot, isDir: entry.is_dir }, smartPrompts, {
			separator: true,
		});
		if (smartItem) items.push(smartItem);

		const parentForNew = parentDirFor(entry);
		items.push({
			label: t("fileBrowser.newFolder", "New Folder\u2026"),
			action: () => startInlineCreate("folder", parentForNew),
		});
		items.push({
			label: t("fileBrowser.newFile", "New File\u2026"),
			action: () => startInlineCreate("file", parentForNew),
			separator: true,
		});

		items.push({
			label: t("fileBrowser.copyPath", "Copy Path"),
			action: () => handleCopyPath(entry),
		});
		items.push({
			label: t("fileBrowser.copyRelativePath", "Copy Relative Path"),
			action: () => handleCopyRelativePath(entry),
		});

		if (!entry.is_dir) {
			items.push({
				label: t("fileBrowser.copy", "Copy"),
				shortcut: `${mod}C`,
				action: () => putOnClipboard([entry], "copy"),
			});
			items.push({
				label: t("fileBrowser.cut", "Cut"),
				shortcut: `${mod}X`,
				action: () => putOnClipboard([entry], "cut"),
			});
		}

		// Into the right-clicked folder, or beside the right-clicked file (VS Code).
		items.push({
			label: t("fileBrowser.paste", "Paste"),
			shortcut: `${mod}V`,
			action: () => void handlePaste(parentDirFor(entry)),
			disabled: !clipboard(),
		});
		// The divider is a row of its own, not Paste's trailing `separator`: the
		// menu's shortcut matcher skips items that carry one, and ⌘V has to reach
		// Paste while the menu is open (the panel stands aside then).
		items.push({ label: "", separator: true, action: () => {} });

		if (!entry.is_dir) {
			items.push({
				label: t("fileBrowser.openDefault", "Open with Default App"),
				action: () => {
					const r = root();
					if (!r) return;
					import("@tauri-apps/plugin-opener").then(({ openPath }) => {
						const abs = isAbsolutePath(entry.path) ? entry.path : joinPath(r, entry.path);
						openPath(abs).catch((err) => appLogger.error("app", "Failed to open file with default app", err));
					});
				},
				separator: true,
			});
		}

		items.push({
			label: t("fileBrowser.duplicate", "Duplicate"),
			action: () => handleDuplicate(entry),
		});

		items.push({
			label: t("fileBrowser.rename", "Rename\u2026"),
			action: () => handleRename(entry),
		});

		items.push({
			label: t("fileBrowser.delete", "Delete"),
			action: () => handleDelete(entry),
			separator: true,
		});

		items.push({
			label: t("fileBrowser.revealInOS", "Reveal in File Manager"),
			action: () => handleRevealInOS(entry),
		});

		items.push({
			label: t("fileBrowser.addGitignore", "Add to .gitignore"),
			action: () => handleAddToGitignore(entry),
			disabled: entry.is_ignored,
			separator: true,
		});

		return items;
	};

	// Track which entry the context menu is for
	const [contextEntry, setContextEntry] = createSignal<DirEntry | null>(null);

	const handleContextMenu = (e: MouseEvent, entry: DirEntry) => {
		e.preventDefault();
		e.stopPropagation();
		// Right-clicking outside the selection selects just that row (Finder, VS
		// Code); right-clicking inside it keeps the selection for the menu to act on.
		if (!selection().has(entry.path)) selectOnly(entry);
		focusPanel();
		setContextEntry(entry);
		contextMenu.open(e);
	};

	/** Context menu for empty space in the listing (VS Code-style): create/paste
	 *  into the current directory. Row menus stopPropagation, so this only fires
	 *  on the background. */
	const getBackgroundMenuItems = (): ContextMenuItem[] => {
		const parent = currentSubdir() === "." ? "" : currentSubdir();
		return [
			{
				label: t("fileBrowser.newFolder", "New Folder…"),
				action: () => startInlineCreate("folder", parent),
			},
			{
				label: t("fileBrowser.newFile", "New File…"),
				action: () => startInlineCreate("file", parent),
				separator: true,
			},
			{
				label: t("fileBrowser.paste", "Paste"),
				shortcut: `${getModifierSymbol()}V`,
				action: () => void handlePaste(parent),
				disabled: !clipboard(),
			},
		];
	};

	const handleBackgroundContextMenu = (e: MouseEvent) => {
		// Listing operations don't apply to search results
		if (searchQuery().trim() || !root()) return;
		e.preventDefault();
		clearSelection();
		focusPanel();
		setContextEntry(null);
		contextMenu.open(e);
	};

	// Keyboard navigation
	createEffect(() => {
		if (!props.visible) return;

		const handleKeydown = (e: KeyboardEvent) => {
			// Only handle if the panel is focused (not terminal)
			const panel = document.getElementById("file-browser-panel");
			if (!panel?.contains(document.activeElement) && document.activeElement !== panel) return;

			// While its context menu is open the menu runs its own shortcuts (Cmd+C/X/V
			// trigger its items); handling them here as well would paste twice.
			if (contextMenu.visible()) return;

			// Let the search input handle its own keyboard events
			const isInputFocused = document.activeElement instanceof HTMLInputElement;

			const isMeta = e.metaKey || e.ctrlKey;
			const list = filteredEntries();

			// Copy/Cut/Paste shortcuts (work even with empty list for paste)
			if (!isInputFocused && isMeta && e.key === "c" && list.length > 0) {
				e.preventDefault();
				copyFromKeyboard("copy");
				return;
			}
			if (!isInputFocused && isMeta && e.key === "x" && list.length > 0) {
				e.preventDefault();
				copyFromKeyboard("cut");
				return;
			}
			if (!isInputFocused && isMeta && e.key === "v") {
				e.preventDefault();
				void handlePaste(keyboardPasteDir());
				return;
			}
			// Select every row on screen (in tree view, expanded folders' rows too)
			if (!isInputFocused && isMeta && e.key === "a" && visibleRows().length > 0) {
				e.preventDefault();
				const rows = visibleRows();
				setSelection(new Set(rows.map((r) => r.path)));
				if (!rows.some((r) => r.path === selectionAnchor())) setSelectionAnchor(rows[0].path);
				return;
			}

			// Don't capture navigation keys when typing in the search input
			if (isInputFocused) return;

			if (list.length === 0) return;

			// In the flat list the selection follows the arrow-key cursor, so the row
			// that looks selected is the one Cmd+C copies. Tree view draws no cursor.
			const followCursor = viewMode() === "flat" || !!searchQuery().trim();
			const moveCursor = (i: number) => {
				setSelectedIndex(i);
				if (followCursor && list[i]) selectOnly(list[i]);
			};

			switch (e.key) {
				case "ArrowUp":
					e.preventDefault();
					moveCursor(Math.max(0, selectedIndex() - 1));
					break;
				case "ArrowDown":
					e.preventDefault();
					moveCursor(Math.min(list.length - 1, selectedIndex() + 1));
					break;
				case "Escape":
					if (selection().size > 0) {
						e.preventDefault();
						clearSelection();
					}
					break;
				case "Enter": {
					e.preventDefault();
					const selected = list[selectedIndex()];
					if (selected) handleEntryClick(selected);
					break;
				}
				case "Backspace":
					e.preventDefault();
					navigateUp();
					break;
			}
		};

		document.addEventListener("keydown", handleKeydown);
		onCleanup(() => document.removeEventListener("keydown", handleKeydown));
	});

	// OS file drops are routed by Tauri's onDragDropEvent → dispatchTauriDrop, which
	// hit-tests via elementFromPoint and walks up to the nearest data-drop-target.
	// Marking the panel root as a "folder" target with the current directory means a
	// drop on empty panel space transfers into the current dir; drops on a folder row
	// win because that row is the inner-most match.
	const panelDropDir = () => {
		const dir = root();
		return dir ? joinPath(dir, currentSubdir()) : undefined;
	};

	return (
		<div
			ref={panelRef}
			id="file-browser-panel"
			class={cx(s.panel, mode() === "detached" && s.detached, !props.visible && s.hidden)}
			tabIndex={-1}
			data-drop-target={panelDropDir() ? "folder" : undefined}
			data-abs-path={panelDropDir()}
		>
			<Show when={mode() === "inline"}>
				<PanelResizeHandle panelId="file-browser-panel" />
			</Show>
			<div class={p.header}>
				<div class={p.headerLeft}>
					<span class={p.title}>{t("fileBrowser.title", "Files")}</span>
					<Show when={!loading() && entries().length > 0}>
						<span class={p.fileCountBadge}>{entries().length}</span>
					</Show>
					<span class={p.headerSep} />
					<div class={g.legend}>
						<span class={g.legendItem} title={t("fileBrowser.modified", "Modified (unstaged changes)")}>
							<span class={cx(g.dot, g.modified)} /> mod
						</span>
						<span class={g.legendItem} title={t("fileBrowser.staged", "Staged for commit")}>
							<span class={cx(g.dot, g.staged)} /> staged
						</span>
						<span class={g.legendItem} title={t("fileBrowser.untracked", "Untracked (new file)")}>
							<span class={cx(g.dot, g.untracked)} /> new
						</span>
					</div>
				</div>
				<PanelWindowControls panelId="file-browser" mode={mode()} onInlineClose={props.onClose} />
			</div>

			{/* Search filter with F/C mode toggle */}
			<div class={s.searchBar}>
				<button
					class={cx(s.modeToggle, searchMode() === "content" && s.modeToggleActive)}
					onClick={() => {
						const next = searchMode() === "filename" ? "content" : "filename";
						setSearchMode(next);
						// Clear results from the other mode
						if (next === "content") {
							setSearchResults([]);
						} else {
							resetContentMatches();
							setContentSearching(false);
							setContentStats({ filesSearched: 0, filesSkipped: 0, truncated: false });
						}
						setSelectedIndex(0);
					}}
					title={searchMode() === "filename" ? "Switch to content search" : "Switch to filename search"}
				>
					<Show when={searchMode() === "filename"} fallback={<ContentModeIcon />}>
						<FilenameModeIcon />
					</Show>
				</button>
				<input
					ref={searchInputRef}
					type="text"
					class={p.searchInput}
					data-focus-target="file-browser-search"
					data-repo-path={props.repoPath ?? ""}
					placeholder={
						searchMode() === "filename"
							? t("fileBrowser.search", "Search files\u2026 (*, ** wildcards)")
							: t("fileBrowser.searchContent", "Search in file contents\u2026")
					}
					value={searchQuery()}
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
					onInput={(e) => {
						setSearchQuery(e.currentTarget.value);
						setSelectedIndex(0);
					}}
				/>
				<Show when={searchMode() === "content"}>
					<button
						class={cx(s.toggleBtn, caseSensitive() && s.toggleActive)}
						onClick={() => setCaseSensitive((v) => !v)}
						title="Match Case"
					>
						<CaseSensitiveIcon />
					</button>
					<button
						class={cx(s.toggleBtn, useRegex() && s.toggleActive)}
						onClick={() => setUseRegex((v) => !v)}
						title="Use Regular Expression"
					>
						<RegexIcon />
					</button>
					<button
						class={cx(s.toggleBtn, wholeWord() && s.toggleActive)}
						onClick={() => setWholeWord((v) => !v)}
						title="Match Whole Word"
					>
						<WholeWordIcon />
					</button>
				</Show>
				<Show when={searchQuery()}>
					<button
						class={p.searchClear}
						onClick={() => {
							setSearchQuery("");
							setSelectedIndex(0);
							resetContentMatches();
							setContentSearching(false);
							setContentStats({ filesSearched: 0, filesSkipped: 0, truncated: false });
						}}
					>
						&times;
					</button>
				</Show>
			</div>

			{/* Toolbar: breadcrumb + sort */}
			<div class={s.toolbar}>
				<Show when={viewMode() === "flat"}>
					<div class={s.breadcrumb}>
						<span class={s.breadcrumbSegment} onClick={() => handleBreadcrumbClick(-1)}>
							/
						</span>
						<For each={breadcrumbs()}>
							{(segment, index) => (
								<>
									<Show when={index() > 0}>
										<span class={s.breadcrumbSep}>/</span>
									</Show>
									<span
										class={cx(s.breadcrumbSegment, index() === breadcrumbs().length - 1 && s.breadcrumbCurrent)}
										onClick={() => handleBreadcrumbClick(index())}
									>
										{segment}
									</span>
								</>
							)}
						</For>
					</div>
				</Show>
				<div class={s.sortControl}>
					{/* Flat/tree toggle */}
					<button
						class={cx(s.viewModeBtn, viewMode() === "flat" && s.viewModeBtnActive)}
						onClick={() => uiStore.setFileBrowserViewMode("flat")}
						title="List view"
					>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
							<path d="M2 3h12v1H2zm0 3h12v1H2zm0 3h12v1H2zm0 3h12v1H2z" />
						</svg>
					</button>
					<button
						class={cx(s.viewModeBtn, viewMode() === "tree" && s.viewModeBtnActive)}
						onClick={() => {
							uiStore.setFileBrowserViewMode("tree");
							setCurrentSubdir(".");
							setSearchQuery("");
						}}
						title="Tree view"
					>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
							<path d="M2 2h3v1H2zm4 2h5v1H6zm4 2h4v1h-4zM6 8h5v1H6zM2 10h3v1H2zm4 2h5v1H6z" />
						</svg>
					</button>
					<button
						class={s.sortTrigger}
						onClick={() => setSortDropdownOpen((v) => !v)}
						title={`${t("fileBrowser.sortBy", "Sort by")} ${sortBy()}`}
					>
						<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
							<path d="M1 2h14L9.5 8.5V13l-3 1.5V8.5z" />
						</svg>
					</button>
					<Dropdown
						items={[
							{ id: "name", label: t("fileBrowser.sortName", "Name") },
							{ id: "date", label: t("fileBrowser.sortDate", "Date") },
						]}
						selected={sortBy()}
						visible={sortDropdownOpen()}
						onSelect={(id) => {
							setSortBy(id as SortMode);
							setSortDropdownOpen(false);
						}}
						onClose={() => setSortDropdownOpen(false)}
					/>
				</div>
			</div>

			{/* Content search status bar */}
			<Show when={searchMode() === "content" && searchQuery().trim().length >= 3}>
				<div
					class={cx(
						s.searchStatus,
						contentStats().truncated && s.searchStatusTruncated,
						contentSearching() && s.searchStatusSearching,
					)}
				>
					<Show
						when={contentSearching()}
						fallback={
							contentMatchCount() > 0
								? `${contentMatchCount()} match${contentMatchCount() !== 1 ? "es" : ""} in ${contentMatchGroups.length} file${contentMatchGroups.length !== 1 ? "s" : ""}${contentStats().truncated ? " (results limited)" : ""}${contentStats().filesSkipped > 0 ? ` \u00B7 ${contentStats().filesSkipped} skipped` : ""}`
								: "No matches"
						}
					>
						{"Searching\u2026"}
					</Show>
				</div>
			</Show>

			<div
				class={p.content}
				ref={contentRef}
				onContextMenu={handleBackgroundContextMenu}
				onClick={(e) => {
					// A plain click on empty space below (or beside) the rows deselects,
					// as in Finder. A modifier click that just missed a row does not.
					if (e.target !== e.currentTarget || _ptrSuppressClick) return;
					if (!e.metaKey && !e.ctrlKey && !e.shiftKey) clearSelection();
				}}
			>
				<Show when={loading() || (searching() && searchMode() === "filename")}>
					<div class={s.empty}>
						{searching() ? t("fileBrowser.searching", "Searching\u2026") : t("fileBrowser.loading", "Loading...")}
					</div>
				</Show>

				<Show when={error()}>
					<div class={cx(s.empty, s.error)}>
						{t("fileBrowser.error", "Error:")} {error()}
					</div>
				</Show>

				{/* Content search results */}
				<Show when={searchMode() === "content" && searchQuery().trim().length >= 3}>
					<Show when={!contentSearching() && contentMatchCount() === 0}>
						<div class={s.empty}>{t("fileBrowser.noMatches", "No matches")}</div>
					</Show>
					<For each={contentMatchGroups}>
						{(group) => (
							<div class={s.contentGroup}>
								<div
									class={s.contentGroupHeader}
									onClick={() => {
										if (root() && group.matches.length > 0) {
											props.onFileOpen(root()!, group.path, group.matches[0].line_number);
										}
									}}
								>
									<span>{group.path}</span>
									<span class={s.contentGroupCount}>
										{group.matches.length} match{group.matches.length !== 1 ? "es" : ""}
									</span>
								</div>
								<For each={group.matches}>
									{(match) => (
										<div
											class={s.contentMatch}
											onClick={() => {
												if (root()) {
													props.onFileOpen(root()!, match.path, match.line_number);
												}
											}}
										>
											<span class={s.contentMatchLine}>{match.line_number}</span>
											<span class={s.contentMatchText}>
												{match.match_start > 0 ? match.line_text.slice(0, match.match_start) : ""}
												<span class={s.contentMatchHighlight}>
													{match.line_text.slice(match.match_start, match.match_end)}
												</span>
												{match.match_end < match.line_text.length ? match.line_text.slice(match.match_end) : ""}
											</span>
										</div>
									)}
								</For>
							</div>
						)}
					</For>
				</Show>

				{/* Filename mode: directory listing or filename search results */}
				<Show when={searchMode() === "filename"}>
					{/* Tree view (only when no active search query) */}
					<Show when={viewMode() === "tree" && !searchQuery().trim()}>
						{/* Inline create at the tree root; deeper parents render inside their TreeNode */}
						<Show when={inlineCreate()?.parent === ""}>
							<InlineCreateRow depth={0} />
						</Show>
						<Show when={!loading() && !error() && filteredEntries().length === 0 && !inlineCreate()}>
							<div class={s.empty}>
								{!root()
									? t("fileBrowser.noRepo", "No repository selected")
									: t("fileBrowser.emptyDir", "Empty directory")}
							</div>
						</Show>
						<Show when={!loading() && !error() && filteredEntries().length > 0}>
							<For each={filteredEntries()}>
								{(entry) => (
									<TreeNode
										entry={entry}
										depth={0}
										repoPath={root() ?? ""}
										fsRoot={root() ?? ""}
										activePath={activeFilePath()}
										expandedDirs={expandedDirs()}
										onToggleExpand={toggleExpand}
										onFileOpen={props.onFileOpen}
										onContextMenu={handleContextMenu}
										onPointerDragStart={handlePointerDragStart}
										childrenCache={treeCache()}
										onChildrenLoaded={onChildrenLoaded}
										isSelected={(path) => selection().has(path)}
										isCut={(path) => cutPaths().has(path)}
										onRowClick={handleTreeRowClick}
										inlineCreateParent={inlineCreate()?.parent ?? null}
										renderInlineCreate={(depth) => <InlineCreateRow depth={depth} />}
									/>
								)}
							</For>
						</Show>
					</Show>

					{/* Flat list view (default, or when searching) */}
					<Show when={viewMode() === "flat" || searchQuery().trim()}>
						{/* Inline create row — shown at the top of the current listing */}
						<Show when={inlineCreate()}>
							<InlineCreateRow />
						</Show>
						{/* Go up entry when in a subdirectory and not searching — shown even when the
						    directory is empty so the user is never stranded without a way back. */}
						<Show
							when={
								!loading() &&
								!searching() &&
								!error() &&
								!searchQuery().trim() &&
								currentSubdir() !== "." &&
								currentSubdir() !== ""
							}
						>
							<div
								class={cx(s.entry, s.entryParent)}
								role="button"
								tabIndex={0}
								onClick={navigateUp}
								onKeyDown={onClickKeyDown(navigateUp)}
							>
								<span class={s.entryIcon}>
									<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
										<path d="M8 2L2 8l6 6V10h6V6H8V2z" />
									</svg>
								</span>
								<span class={s.entryName}>..</span>
							</div>
						</Show>

						<Show when={!loading() && !searching() && !error() && filteredEntries().length === 0 && !inlineCreate()}>
							<div class={s.empty}>
								{!root()
									? t("fileBrowser.noRepo", "No repository selected")
									: searchQuery()
										? t("fileBrowser.noMatches", "No matches")
										: t("fileBrowser.emptyDir", "Empty directory")}
							</div>
						</Show>

						<Show when={!loading() && !searching() && !error() && filteredEntries().length > 0}>
							<For each={filteredEntries()}>
								{(entry, index) => {
									const isSearch = !!searchQuery().trim();
									const absPath = () => (isAbsolutePath(entry.path) ? entry.path : joinPath(root() ?? "", entry.path));
									return (
										<div
											class={cx(
												s.entry,
												entry.is_dir && s.entryDir,
												selectedIndex() === index() && s.entrySelected,
												!entry.is_dir && entry.path === activeFilePath() && s.entryActive,
												selection().has(entry.path) && s.entryPicked,
												entry.is_ignored && s.entryIgnored,
												cutPaths().has(entry.path) && s.entryCut,
											)}
											data-drop-target={entry.is_dir ? "folder" : undefined}
											data-abs-path={entry.is_dir ? absPath() : undefined}
											onPointerDown={(e) => handlePointerDragStart(absPath(), e)}
											onClick={(e) => {
												if (_ptrSuppressClick) return;
												setSelectedIndex(index());
												if (applySelectionClick(entry, e)) return;
												selectOnly(entry);
												focusPanel();
												handleEntryClick(entry);
											}}
											onContextMenu={(e) => handleContextMenu(e, entry)}
										>
											<FileIcon name={entry.name} isDir={entry.is_dir} class={s.entryIcon} />
											<span class={s.entryName} title={fileTooltip(entry)}>
												{isSearch ? entry.path : entry.name}
											</span>
											<Show when={entry.git_status}>
												<span class={cx(g.dot, getStatusClass(entry.git_status))} title={entry.git_status} />
											</Show>
											<Show when={!entry.is_dir && entry.size > 0}>
												<span class={s.entrySize}>{formatSize(entry.size)}</span>
											</Show>
										</div>
									);
								}}
							</For>
						</Show>
					</Show>
				</Show>
			</div>

			{/* Context menu */}
			<ContextMenu
				items={contextEntry() ? getContextMenuItems(contextEntry()!) : getBackgroundMenuItems()}
				x={contextMenu.position().x}
				y={contextMenu.position().y}
				visible={contextMenu.visible()}
				onClose={contextMenu.close}
			/>

			{/* Rename dialog */}
			<PromptDialog
				visible={renameDialogVisible()}
				title={t("fileBrowser.renameTitle", "Rename")}
				placeholder={t("fileBrowser.renamePlaceholder", "New name")}
				defaultValue={renameTarget()?.name || ""}
				confirmLabel={t("fileBrowser.renameConfirm", "Rename")}
				onClose={() => setRenameDialogVisible(false)}
				onConfirm={handleRenameConfirm}
			/>

			{/* Delete confirmation dialog */}
			<ConfirmDialog
				visible={deleteDialogVisible()}
				title={deleteTarget()?.is_dir ? "Delete Folder" : "Delete File"}
				message={`Permanently delete "${deleteTarget()?.name ?? ""}"${deleteTarget()?.is_dir ? " and all its contents" : ""}?`}
				confirmLabel="Delete"
				kind="warning"
				onClose={() => setDeleteDialogVisible(false)}
				onConfirm={confirmDelete}
			/>
		</div>
	);
};

export default FileBrowserPanel;
