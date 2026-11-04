import {
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
	untrack,
} from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ContentSearchOptions } from "../../hooks/useFileBrowser";
import { useFileBrowser } from "../../hooks/useFileBrowser";
import { onFolderDropComplete } from "../../hooks/useFileDrop";
import { initMouseDrag, isHoldPointer } from "../../hooks/useMouseDrag";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { t } from "../../i18n";
import { invoke, listen } from "../../invoke";
import { getModifierSymbol } from "../../platform";
import { appLogger } from "../../stores/appLogger";
import { diffTabsStore } from "../../stores/diffTabs";
import { markInternalDragEnd, markInternalDragStart, startNativeDrag } from "../../stores/dragDrop";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import { uiStore } from "../../stores/ui";
import type { ContentMatch, DeleteResult, DirEntry, PasteResult } from "../../types/fs";
import { cx } from "../../utils";
import { writeClipboard } from "../../utils/clipboard";
import { openLocalPath } from "../../utils/openUrl";
import {
	isAbsolutePath,
	joinPath,
	pathBasename,
	pathDirname,
	pathStartsWith,
	replaceBasename,
} from "../../utils/pathUtils";
import { fileContextSmartMenuItem } from "../../utils/promptContext";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu";
import {
	IconAlert,
	IconArrowDownUp,
	IconCaseSensitive,
	IconChevronRight,
	IconFiles,
	IconFolder,
	IconList,
	IconListTree,
	IconPlus,
	IconRegex,
	IconSearch,
	IconTextSearch,
	IconWholeWord,
} from "../icons";
import { PromptDialog } from "../PromptDialog";
import { EmptyState } from "../shared/EmptyState";
import g from "../shared/git-status.module.css";
import p from "../shared/panel.module.css";
import { SearchField, SearchFieldToggle } from "../shared/SearchField";
import { Spinner } from "../shared/Spinner";
import { Dropdown } from "../ui/Dropdown";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import { PanelWindowControls } from "../ui/PanelWindowControls";
import s from "./FileBrowserPanel.module.css";
import { FileIcon } from "./FileIcon";
import { fileTooltip, getStatusClass, matchPreview, statusLabel } from "./fileUtils";
import { TreeNode } from "./TreeNode";
import { entriesEqual, revalidateTreeCache } from "./treeRevalidate";

export interface FileBrowserPanelProps {
	visible: boolean;
	repoPath: string | null;
	/** Effective filesystem root (worktree path when on a linked worktree) */
	fsRoot?: string | null;
	onClose: () => void;
	onFileOpen: (repoPath: string, filePath: string, line?: number) => void;
	mode?: "inline" | "detached";
}

/** Shared empty set: clearing the selection allocates nothing. */
const EMPTY_PATHS: ReadonlySet<string> = new Set();

/** "1 file", "3 folders", "4 items": menu labels and dialogs about a selection. */
const itemCount = (entries: readonly DirEntry[]) => {
	const n = entries.length;
	const folders = entries.filter((e) => e.is_dir).length;
	const noun = folders === 0 ? "file" : folders === n ? "folder" : "item";
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
};

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

	// The external folder belongs to the repository it was opened from: picking
	// another repository or worktree returns the browser to it.
	createEffect(
		on(
			() => [props.repoPath, props.fsRoot],
			() => uiStore.setFileBrowserExternalRoot(null),
			{ defer: true },
		),
	);

	/** The active markdown-panel tab when a file on disk backs it — a markdown tab
	 * or an HTML preview. The other md types (virtual, plugin panels, dashboards,
	 * pr-diff) carry no path to highlight. */
	const activeMdFileTab = () => {
		const tab = mdTabsStore.getActive();
		return tab && (tab.type === "file" || tab.type === "html-preview") ? tab : null;
	};

	/** Relative path of the file shown in the active editor, diff, markdown or
	 * HTML-preview tab, when it lives under the root this browser shows — for
	 * highlighting it in the tree like VS Code. Editor-first: opening a diff clears
	 * the editor's active id, so editor-first precedence resolves the visible tab
	 * correctly, and the markdown panel is the same fallback the Toolbar uses for
	 * `focusedFilePath`. Null otherwise. */
	const activeFilePath = createMemo(() => {
		const tab = editorTabsStore.getActive() ?? diffTabsStore.getActive() ?? activeMdFileTab();
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
	/** What the open Delete dialog will delete: one row, or a selection as it
	 *  stood when the dialog opened. */
	const [deleteTargets, setDeleteTargets] = createSignal<DirEntry[]>([]);

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
	/** The flat list's arrow-key cursor is drawn only once the keyboard moves it;
	 *  a pointer press hides it again (a mouse user never sees a stray ring). */
	const [keyboardCursor, setKeyboardCursor] = createSignal(false);
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
							e.is_ignored !== c.is_ignored ||
							e.symlink_target !== c.symlink_target ||
							e.symlink_target_kind !== c.symlink_target_kind
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

	// A nonrecursive watch must cover every directory whose children are visible,
	// not just the flat listing. Keep unchanged watches when another node expands.
	const watchedDirs = new Map<string, string>();
	// Re-list a cached directory in place and swap its children in only when they
	// changed. Dropping the key instead (TreeNode then re-fetches) would blank an
	// expanded folder and flash its spinner on every watcher tick.
	const relistGeneration = new Map<string, number>();
	const invalidateDirectory = (subdir: string) => {
		const fsRoot = root();
		if (!fsRoot || !untrack(treeCache).has(subdir)) return;
		const gen = (relistGeneration.get(subdir) ?? 0) + 1;
		relistGeneration.set(subdir, gen);
		const settle = (children: DirEntry[] | null) => {
			if (relistGeneration.get(subdir) !== gen || root() !== fsRoot) return;
			setTreeCache((prev) => {
				const current = prev.get(subdir);
				if (!current || (children && entriesEqual(current, children))) return prev;
				const next = new Map(prev);
				if (children) next.set(subdir, children);
				else next.delete(subdir); // gone or unreadable: TreeNode re-fetches if it reappears
				return next;
			});
		};
		fb.listDirectory(fsRoot, subdir).then(settle, () => settle(null));
	};
	const stopDirectoryWatch = (path: string) => {
		invoke("stop_dir_watcher", { path }).catch((err) => {
			appLogger.warn("app", `Failed to stop dir watcher for ${path}`, err);
		});
	};
	createEffect(() => {
		if (!props.visible || !root() || searchQuery().trim()) return;
		const unlisten = listen<{ dir_path: string }>("dir-changed", (event) => {
			const subdir = watchedDirs.get(event.payload.dir_path);
			if (subdir === undefined) return;
			if (subdir === currentSubdir()) setDirRevision((n) => n + 1);
			invalidateDirectory(subdir);
		});
		onCleanup(() => unlisten.then((fn) => fn()));
	});

	createEffect(() => {
		const desired = new Map<string, string>();
		const fsRoot = root();
		if (props.visible && fsRoot && !searchQuery().trim()) {
			const subdir = currentSubdir();
			desired.set(subdir === "." || subdir === "" ? fsRoot : joinPath(fsRoot, subdir), subdir);
			if (viewMode() === "tree") {
				const expanded = expandedDirs();
				const cache = treeCache();
				const visit = (children: DirEntry[]) => {
					for (const entry of children) {
						if (!entry.is_dir || !expanded.has(entry.path)) continue;
						desired.set(joinPath(fsRoot, entry.path), entry.path);
						visit(cache.get(entry.path) ?? []);
					}
				};
				visit(entries());
			}
		}
		for (const path of watchedDirs.keys()) {
			if (desired.has(path)) continue;
			watchedDirs.delete(path);
			stopDirectoryWatch(path);
		}
		for (const [path, subdir] of desired) {
			if (watchedDirs.has(path)) continue;
			watchedDirs.set(path, subdir);
			// A collapsed or hidden directory may have changed while unwatched.
			invalidateDirectory(subdir);
			invoke("start_dir_watcher", { path }).catch((err) => {
				appLogger.warn("app", `Dir watcher failed for ${path}: ${err}`);
			});
		}
	});

	onCleanup(() => {
		for (const path of watchedDirs.keys()) stopDirectoryWatch(path);
		watchedDirs.clear();
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
		return raw.toSorted((a, b) => (b.is_dir ? 1 : 0) - (a.is_dir ? 1 : 0) || b.modified_at - a.modified_at);
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

	onCleanup(
		onFolderDropComplete((request) => {
			const fsRoot = root();
			if (!fsRoot || request.connectionId !== repositoriesStore.getConnectionId(props.repoPath ?? "")) return;
			if (
				pathStartsWith(request.destDir, fsRoot) ||
				(request.mode === "move" && request.paths.some((path) => pathStartsWith(path, fsRoot)))
			) {
				refresh();
			}
		}),
	);

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

	const handleDelete = (picked: DirEntry[]) => {
		if (picked.length === 0) return;
		setDeleteTargets(picked);
		setDeleteDialogVisible(true);
	};

	/** One backend call deletes every target (see `delete_paths`): a symlink goes
	 *  itself, never what it points at. Whatever went stops being selected or on
	 *  the clipboard. */
	const confirmDelete = async () => {
		const picked = deleteTargets();
		const r = root();
		if (picked.length === 0 || !r) return;
		setDeleteDialogVisible(false);
		let result: DeleteResult;
		try {
			result = await fb.deletePaths(
				r,
				picked.map((e) => e.path),
			);
		} catch (err) {
			appLogger.error("app", "Failed to delete", err);
			toastsStore.add(t("fileBrowser.deleteFailed", "Couldn't delete"), String(err), "error");
			return;
		}
		if (result.deleted.length > 0 && root() === r) {
			const gone = new Set(result.deleted);
			if ([...selection()].some((path) => gone.has(path))) clearSelection();
			const clip = clipboard();
			if (clip?.sourceRoot === r && clip.entries.some((e) => gone.has(e.path))) {
				const left = clip.entries.filter((e) => !gone.has(e.path));
				setClipboard(left.length > 0 ? { ...clip, entries: left } : null);
			}
		}
		refresh();
		if (result.errors.length > 0) {
			appLogger.warn("app", "Delete left paths behind", { errors: result.errors });
			const more =
				result.errors.length > 3
					? ` \u00B7 ${t("fileBrowser.andMore", "and {count} more", { count: String(result.errors.length - 3) })}`
					: "";
			toastsStore.add(
				result.deleted.length === 0
					? t("fileBrowser.deleteFailed", "Couldn't delete")
					: t("fileBrowser.deletedSome", "Deleted {done} of {total}", {
							done: String(result.deleted.length),
							total: String(picked.length),
						}),
				result.errors.slice(0, 3).join(" \u00B7 ") + more,
				result.deleted.length === 0 ? "error" : "warn",
			);
		}
	};

	/** The Delete dialog's title and question, for one row or a selection. */
	const deleteDialogTitle = () => {
		const picked = deleteTargets();
		if (picked.length > 1) return t("fileBrowser.deleteSelectedTitle", "Delete {count}", { count: itemCount(picked) });
		return picked[0]?.is_dir ? "Delete folder" : "Delete file";
	};
	const deleteDialogMessage = () => {
		const picked = deleteTargets();
		if (picked.length > 1) {
			return picked.some((e) => e.is_dir)
				? t("fileBrowser.deleteSelectedWithFolders", "Permanently delete {count}, folders with all their contents?", {
						count: itemCount(picked),
					})
				: t("fileBrowser.deleteSelectedMessage", "Permanently delete {count}?", {
						count: itemCount(picked),
					});
		}
		const entry = picked[0];
		return `Permanently delete "${entry?.name ?? ""}"${entry?.is_dir ? " and all its contents" : ""}?`;
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
	const InlineCreateRow: Component<{ depth?: number }> = (row) => {
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
			<div class={cx(s.entry, s.inlineCreateRow)} style={{ "--depth": String(row.depth ?? 0) }}>
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

	/** Put `picked` on the clipboard, files and folders alike. A row inside a
	 *  picked folder (tree view) is left out: it already travels with the
	 *  folder, and pasting it again would land a second copy beside it. */
	const putOnClipboard = (picked: DirEntry[], mode: "copy" | "cut") => {
		const r = root();
		if (!r || picked.length === 0) return;
		const folders = picked.filter((e) => e.is_dir).map((e) => `${e.path}/`);
		const entries = picked.filter((e) => !folders.some((f) => e.path.startsWith(f)));
		setClipboard({ entries, mode, sourceRoot: r });
	};

	/**
	 * Cmd+C / Cmd+X. Acts on the selection; with none, on the row the flat list's
	 * arrow-key cursor is on (tree view draws no cursor, so there it does
	 * nothing).
	 */
	const copyFromKeyboard = (mode: "copy" | "cut") => {
		let picked = selectedRows();
		if (picked.length === 0 && (viewMode() === "flat" || searchQuery().trim())) {
			const row = filteredEntries()[selectedIndex()];
			if (row) picked = [row];
		}
		putOnClipboard(picked, mode);
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
				t("fileBrowser.pasteNameTaken", "{name}: something with that name is already there", { name }),
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
					? t("fileBrowser.copiedSome", "Copied {done} of {total}", counts)
					: t("fileBrowser.movedSome", "Moved {done} of {total}", counts);
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

	// Touch and pen: a swipe is a scroll, never a file move (the move is irreversible).
	// initMouseDrag arms the drag only after a hold and bails out on movement before that.
	const handleHoldDragStart = (absPath: string, e: PointerEvent) => {
		// The hold arms the drag without movement: a release in place or finger jitter
		// (the context-menu gesture) must not drop the file on the folder under the
		// finger, so a drop needs displacement beyond the touch slop and a pointer off
		// the source row (whose nearest folder is the panel root).
		const sourceRow = e.currentTarget as HTMLElement;
		const slop = 10;
		let moved = false;
		const end = () => {
			markInternalDragEnd();
			ptrCleanup();
			_ptrSrc = null;
		};
		initMouseDrag(e, e.currentTarget as HTMLElement, {
			onStart: () => {
				markInternalDragStart();
				_ptrSrc = absPath;
			},
			onMove: (x, y) => {
				if (Math.abs(x - e.clientX) + Math.abs(y - e.clientY) > slop) moved = true;
				ptrHighlight(x, y);
			},
			onDrop: (x, y) => {
				const target = moved && !sourceRow.contains(document.elementFromPoint(x, y)) ? findDropFolder(x, y) : null;
				end();
				if (target?.dataset.absPath) performFileMove(absPath, target.dataset.absPath);
				_ptrSuppressClick = true;
				requestAnimationFrame(() => {
					_ptrSuppressClick = false;
				});
			},
			onCancel: end,
		});
	};

	const handlePointerDragStart = (absPath: string, e: PointerEvent) => {
		if (isHoldPointer(e)) return handleHoldDragStart(absPath, e);
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

	// Raw absolute paths, one per line (VSCode "Copy Path" behavior — no ~ shortening)
	const handleCopyPath = (picked: DirEntry[]) => {
		const fsRoot = root();
		if (!fsRoot) return;
		const paths = picked.map((e) => (isAbsolutePath(e.path) ? e.path : `${fsRoot}/${e.path}`));
		writeClipboard(paths.join("\n")).catch((err) => appLogger.error("app", "Failed to copy path", err));
	};

	// entry.path is already relative to the repo root (see DirEntry in types/fs.ts)
	const handleCopyRelativePath = (picked: DirEntry[]) => {
		writeClipboard(picked.map((e) => e.path).join("\n")).catch((err) =>
			appLogger.error("app", "Failed to copy relative path", err),
		);
	};

	/**
	 * Menu for a right-click inside a multi-selection: what applies to every
	 * selected file and folder at once. Single-item actions (rename, duplicate,
	 * reveal…) take a plain click on that row first, which selects it alone.
	 */
	const getSelectionMenuItems = (entry: DirEntry, picked: DirEntry[]): ContextMenuItem[] => {
		const mod = getModifierSymbol();
		const count = itemCount(picked);
		return [
			{
				label: t("fileBrowser.copySelected", "Copy {count}", { count }),
				shortcut: `${mod}C`,
				action: () => putOnClipboard(picked, "copy"),
			},
			{
				label: t("fileBrowser.cutSelected", "Cut {count}", { count }),
				shortcut: `${mod}X`,
				action: () => putOnClipboard(picked, "cut"),
			},
			{
				label: t("fileBrowser.paste", "Paste"),
				shortcut: `${mod}V`,
				action: () => void handlePaste(parentDirFor(entry)),
				disabled: !clipboard(),
			},
			// A divider row of its own, as in the single-row menu: ⌘V must reach Paste.
			{ label: "", separator: true, action: () => {} },
			{ label: t("fileBrowser.copyPaths", "Copy paths"), action: () => handleCopyPath(picked) },
			{
				label: t("fileBrowser.copyRelativePaths", "Copy relative paths"),
				action: () => handleCopyRelativePath(picked),
				separator: true,
			},
			{
				label: t("fileBrowser.deleteSelected", "Delete {count}\u2026", { count }),
				action: () => handleDelete(picked),
			},
		];
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
			label: t("fileBrowser.newFolder", "New folder\u2026"),
			action: () => startInlineCreate("folder", parentForNew),
		});
		items.push({
			label: t("fileBrowser.newFile", "New file\u2026"),
			action: () => startInlineCreate("file", parentForNew),
			separator: true,
		});

		items.push({
			label: t("fileBrowser.copyPath", "Copy path"),
			action: () => handleCopyPath([entry]),
		});
		items.push({
			label: t("fileBrowser.copyRelativePath", "Copy relative path"),
			action: () => handleCopyRelativePath([entry]),
		});

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
				label: t("fileBrowser.openDefault", "Open with default app"),
				action: () => {
					const r = root();
					if (!r) return;
					const abs = isAbsolutePath(entry.path) ? entry.path : joinPath(r, entry.path);
					openLocalPath(abs);
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
			action: () => handleDelete([entry]),
			separator: true,
		});

		items.push({
			label: t("fileBrowser.revealInOS", "Reveal in file manager"),
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
				label: t("fileBrowser.newFolder", "New folder\u2026"),
				action: () => startInlineCreate("folder", parent),
			},
			{
				label: t("fileBrowser.newFile", "New file\u2026"),
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

			if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Backspace") {
				setKeyboardCursor(true);
			}

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

	/** The listing's own folder name — the breadcrumb's first segment. */
	const rootName = () => {
		const r = root() ?? "";
		return pathBasename(r) || r || "/";
	};

	/** The breadcrumb names the folder the flat list shows; a search is not in a folder. */
	const showBreadcrumb = () =>
		!!root() && viewMode() === "flat" && searchMode() === "filename" && !searchQuery().trim();

	/** The listing's width, kept current across panel resizes. */
	const [listWidth, setListWidth] = createSignal(0);
	onMount(() => {
		if (!contentRef || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setListWidth(contentRef?.clientWidth ?? 0));
		ro.observe(contentRef);
		onCleanup(() => ro.disconnect());
	});

	/**
	 * How many characters of a matching line show before its match
	 * (matchPreview): about 45 % of what fits beside the line number, so the
	 * match stays on screen at any panel width. 86px is the match row's insets,
	 * line number and gap; 11px mono runs ~6.6px a character. 16 until the
	 * listing has been measured.
	 */
	const matchLead = createMemo(() => {
		const w = listWidth();
		return w > 0 ? Math.max(8, Math.round(((w - 86) / 6.6) * 0.45)) : 16;
	});

	// Keep the folder on screen in view when the path is wider than the panel —
	// after each move and each resize — and fade whichever end is clipped.
	let breadcrumbEl: HTMLElement | undefined;
	const [crumbClip, setCrumbClip] = createSignal(
		{ start: false, end: false },
		{ equals: (a, b) => a.start === b.start && a.end === b.end },
	);
	const measureCrumb = () => {
		const el = breadcrumbEl;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		setCrumbClip({ start: el.scrollLeft > 0.5, end: el.scrollLeft < max - 0.5 });
	};
	createEffect(() => {
		void currentSubdir();
		void listWidth();
		if (!showBreadcrumb()) return;
		requestAnimationFrame(() => {
			if (!breadcrumbEl) return;
			breadcrumbEl.scrollLeft = breadcrumbEl.scrollWidth;
			measureCrumb();
		});
	});

	const showTree = () => {
		uiStore.setFileBrowserViewMode("tree");
		setCurrentSubdir(".");
		setSearchQuery("");
	};

	/** Filename ⇄ content search; each mode's results go with it. */
	const toggleSearchMode = () => {
		const next = searchMode() === "filename" ? "content" : "filename";
		setSearchMode(next);
		if (next === "content") {
			setSearchResults([]);
		} else {
			resetContentSearch();
		}
		setSelectedIndex(0);
	};

	/** What clearing the field (its × or Esc) resets besides the query. */
	const resetContentSearch = () => {
		resetContentMatches();
		setContentSearching(false);
		setContentStats({ filesSearched: 0, filesSkipped: 0, truncated: false });
	};

	const contentStatusText = () => {
		const count = contentMatchCount();
		if (count === 0) return t("fileBrowser.noMatches", "No matches");
		const files = contentMatchGroups.length;
		const stats = contentStats();
		return `${count} match${count !== 1 ? "es" : ""} in ${files} file${files !== 1 ? "s" : ""}${stats.truncated ? " (results limited)" : ""}${stats.filesSkipped > 0 ? ` \u00B7 ${stats.filesSkipped} skipped` : ""}`;
	};

	/** A row of the flat list or of the filename results (the tree draws TreeNode). */
	const FlatRow: Component<{ entry: DirEntry; index: number; result?: boolean }> = (row) => {
		const absPath = () => (isAbsolutePath(row.entry.path) ? row.entry.path : joinPath(root() ?? "", row.entry.path));
		const dir = () => (row.result ? pathDirname(row.entry.path) : "");
		return (
			<div
				class={cx(
					s.entry,
					row.result && s.entryResult,
					selectedIndex() === row.index && s.entrySelected,
					!row.entry.is_dir && row.entry.path === activeFilePath() && s.entryActive,
					selection().has(row.entry.path) && s.entryPicked,
					row.entry.is_ignored && s.entryIgnored,
					cutPaths().has(row.entry.path) && s.entryCut,
				)}
				title={fileTooltip(row.entry)}
				data-drop-target={row.entry.is_dir ? "folder" : undefined}
				data-abs-path={row.entry.is_dir ? absPath() : undefined}
				onPointerDown={(e) => handlePointerDragStart(absPath(), e)}
				onClick={(e) => {
					if (_ptrSuppressClick) return;
					setSelectedIndex(row.index);
					if (applySelectionClick(row.entry, e)) return;
					selectOnly(row.entry);
					focusPanel();
					handleEntryClick(row.entry);
				}}
				onContextMenu={(e) => handleContextMenu(e, row.entry)}
			>
				<FileIcon
					name={row.entry.name}
					isDir={row.entry.is_dir}
					isLink={row.entry.symlink_target_kind !== undefined}
					class={s.entryIcon}
				/>
				<span class={s.entryName}>
					{row.entry.name}
					<Show when={row.entry.symlink_target_kind}>
						<span class={s.entryLink}>
							{row.entry.symlink_target_kind} link → {row.entry.symlink_target ?? "Target unavailable"}
						</span>
					</Show>
				</span>
				<Show when={dir()}>
					<span class={s.entryDir}>{dir()}</span>
				</Show>
				<Show when={row.entry.git_status}>
					<span
						class={cx(g.dot, getStatusClass(row.entry.git_status), s.entryDot)}
						title={statusLabel(row.entry.git_status)}
					/>
				</Show>
			</div>
		);
	};

	/** The empty folder, with the one thing to do in it. */
	const EmptyFolder = () => (
		<EmptyState
			icon={IconFolder}
			title={t("fileBrowser.emptyDir", "This folder is empty")}
			action={
				<button type="button" class={s.emptyAction} onClick={() => startInlineCreate("file", currentDirRel())}>
					<IconPlus size={14} />
					{t("fileBrowser.newFileAction", "New file")}
				</button>
			}
		/>
	);

	return (
		<div
			ref={panelRef}
			id="file-browser-panel"
			class={cx(s.panel, mode() === "detached" && s.detached, !props.visible && s.hidden)}
			tabIndex={-1}
			data-drop-target={panelDropDir() ? "folder" : undefined}
			data-abs-path={panelDropDir()}
			data-drop-connection-id={repositoriesStore.getConnectionId(props.repoPath ?? "")}
			onPointerDown={() => setKeyboardCursor(false)}
		>
			<Show when={mode() === "inline"}>
				<PanelResizeHandle panelId="file-browser-panel" />
			</Show>
			<div class={p.header}>
				<div class={p.headerLeft}>
					<span class={p.title}>{t("fileBrowser.title", "Files")}</span>
				</div>
				<div class={s.headerTools}>
					<button
						type="button"
						class={cx(s.headerBtn, viewMode() === "flat" && s.headerBtnOn)}
						onClick={() => uiStore.setFileBrowserViewMode("flat")}
						title="List view"
						aria-label="List view"
						aria-pressed={viewMode() === "flat"}
					>
						<IconList size={16} />
					</button>
					<button
						type="button"
						class={cx(s.headerBtn, viewMode() === "tree" && s.headerBtnOn)}
						onClick={showTree}
						title="Tree view"
						aria-label="Tree view"
						aria-pressed={viewMode() === "tree"}
					>
						<IconListTree size={16} />
					</button>
					<div class={s.sortControl}>
						<button
							type="button"
							class={cx(s.headerBtn, sortDropdownOpen() && s.headerBtnOn)}
							onClick={() => setSortDropdownOpen((v) => !v)}
							title={`${t("fileBrowser.sortBy", "Sort by")} ${sortBy()}`}
							aria-label={`${t("fileBrowser.sortBy", "Sort by")} ${sortBy()}`}
							aria-haspopup="menu"
							aria-expanded={sortDropdownOpen()}
						>
							<IconArrowDownUp size={16} />
						</button>
						<Dropdown
							class={s.sortMenu}
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
					<span class={s.headerSep} />
					<PanelWindowControls panelId="file-browser" mode={mode()} onInlineClose={props.onClose} />
				</div>
			</div>

			{/* Browsing a folder outside the repository ("Open Folder…"): say where, and the way back */}
			<Show when={uiStore.state.fileBrowserExternalRoot}>
				{(externalRoot) => (
					<div class={s.externalRoot} data-testid="external-root-banner">
						<IconFolder size={14} class={s.externalRootIcon} />
						<span class={s.externalRootPath} title={externalRoot()}>
							{externalRoot()}
						</span>
						<button
							type="button"
							class={s.externalRootBack}
							title={t("fileBrowser.backToRepo", "Back to the active repository")}
							onClick={() => uiStore.setFileBrowserExternalRoot(null)}
						>
							{t("fileBrowser.backToRepoLabel", "Back to repository")}
						</button>
					</div>
				)}
			</Show>

			{/* Search: filename (glob) or content, with the content options inside the field */}
			<div class={s.searchBar}>
				<SearchField
					ref={searchInputRef}
					value={searchQuery()}
					onInput={(value) => {
						setSearchQuery(value);
						setSelectedIndex(0);
					}}
					onClear={resetContentSearch}
					placeholder={
						searchMode() === "filename"
							? t("fileBrowser.search", "Search files")
							: t("fileBrowser.searchContent", "Search in files")
					}
					title={
						searchMode() === "filename"
							? t("fileBrowser.searchHint", "* matches within a folder, ** across folders")
							: t("fileBrowser.searchContentHint", "Searches file contents \u00B7 at least 3 characters")
					}
					disabled={!root()}
					data-focus-target="file-browser-search"
					data-repo-path={props.repoPath ?? ""}
					trailing={
						<>
							<Show when={searchMode() === "content"}>
								<SearchFieldToggle
									active={caseSensitive()}
									title="Match case"
									onClick={() => setCaseSensitive((v) => !v)}
								>
									<IconCaseSensitive size={14} />
								</SearchFieldToggle>
								<SearchFieldToggle
									active={wholeWord()}
									title="Match whole word"
									onClick={() => setWholeWord((v) => !v)}
								>
									<IconWholeWord size={14} />
								</SearchFieldToggle>
								<SearchFieldToggle
									active={useRegex()}
									title="Use regular expression"
									onClick={() => setUseRegex((v) => !v)}
								>
									<IconRegex size={14} />
								</SearchFieldToggle>
							</Show>
							<SearchFieldToggle
								class={s.modeToggle}
								active={searchMode() === "content"}
								title={searchMode() === "filename" ? "Switch to content search" : "Switch to filename search"}
								onClick={toggleSearchMode}
							>
								<IconTextSearch size={14} />
							</SearchFieldToggle>
						</>
					}
				/>
			</div>

			{/* Flat view: where the list is, root first; each segment jumps there */}
			<Show when={showBreadcrumb()}>
				<nav
					class={cx(s.breadcrumb, crumbClip().start && s.breadcrumbFadeStart, crumbClip().end && s.breadcrumbFadeEnd)}
					ref={breadcrumbEl}
					aria-label="Folder"
					onScroll={measureCrumb}
				>
					<span
						class={cx(s.breadcrumbSegment, breadcrumbs().length === 0 && s.breadcrumbCurrent)}
						title={root() ?? undefined}
						onClick={() => handleBreadcrumbClick(-1)}
					>
						{rootName()}
					</span>
					<For each={breadcrumbs()}>
						{(segment, index) => (
							<>
								<IconChevronRight size={12} class={s.breadcrumbSep} />
								<span
									class={cx(s.breadcrumbSegment, index() === breadcrumbs().length - 1 && s.breadcrumbCurrent)}
									onClick={() => handleBreadcrumbClick(index())}
								>
									{segment}
								</span>
							</>
						)}
					</For>
				</nav>
			</Show>

			{/* Content search status. A finished search that found nothing says so in
			    the listing's empty state instead, not twice. */}
			<Show
				when={
					searchMode() === "content" &&
					searchQuery().trim().length >= 3 &&
					(contentSearching() || contentMatchCount() > 0)
				}
			>
				<div
					class={cx(
						s.searchStatus,
						contentStats().truncated && s.searchStatusTruncated,
						contentSearching() && s.searchStatusSearching,
					)}
				>
					<Show when={contentSearching()}>
						<Spinner size={12} />
					</Show>
					<span class={s.searchStatusText}>
						<Show when={contentSearching()} fallback={contentStatusText()}>
							{"Searching\u2026"}
						</Show>
					</span>
				</div>
			</Show>

			<div
				class={cx(p.content, s.listing, selectedRows().length > 1 && s.listingMulti, keyboardCursor() && s.listingKeys)}
				ref={contentRef}
				onContextMenu={handleBackgroundContextMenu}
				onClick={(e) => {
					// A plain click on empty space below (or beside) the rows deselects,
					// as in Finder. A modifier click that just missed a row does not.
					if (e.target !== e.currentTarget || _ptrSuppressClick) return;
					if (!e.metaKey && !e.ctrlKey && !e.shiftKey) clearSelection();
				}}
			>
				<Switch>
					<Match when={!root()}>
						<EmptyState
							icon={IconFiles}
							title={t("fileBrowser.noRepo", "No folder open")}
							description={t("fileBrowser.noRepoHint", "Pick a repository in the sidebar.")}
						/>
					</Match>

					{/* Content search: matches grouped by file */}
					<Match when={searchMode() === "content"}>
						<Show
							when={searchQuery().trim().length >= 3}
							fallback={
								<EmptyState
									icon={IconTextSearch}
									title={t("fileBrowser.contentHintTitle", "Search file contents")}
									description={t("fileBrowser.contentHint", "Type at least 3 characters.")}
								/>
							}
						>
							<Show when={!contentSearching() && contentMatchCount() === 0}>
								<EmptyState
									icon={IconTextSearch}
									title={t("fileBrowser.noMatches", "No matches")}
									description={`Nothing in this folder contains \u201C${searchQuery().trim()}\u201D.`}
								/>
							</Show>
							<For each={contentMatchGroups}>
								{(group) => (
									<div class={s.contentGroup}>
										<div
											class={s.contentGroupHeader}
											title={group.path}
											onClick={() => {
												if (root() && group.matches.length > 0) {
													props.onFileOpen(root()!, group.path, group.matches[0].line_number);
												}
											}}
										>
											<FileIcon name={pathBasename(group.path)} isDir={false} class={s.entryIcon} />
											<span class={s.contentGroupName}>{pathBasename(group.path)}</span>
											<Show when={pathDirname(group.path)}>
												<span class={s.contentGroupDir}>{pathDirname(group.path)}</span>
											</Show>
											<span class={s.contentGroupCount}>
												{group.matches.length} match{group.matches.length !== 1 ? "es" : ""}
											</span>
										</div>
										<For each={group.matches}>
											{(match) => {
												const preview = createMemo(() =>
													matchPreview(match.line_text, match.match_start, match.match_end, matchLead()),
												);
												return (
													<div
														class={s.contentMatch}
														title={match.line_text.trim()}
														onClick={() => {
															if (root()) {
																props.onFileOpen(root()!, match.path, match.line_number);
															}
														}}
													>
														<span class={s.contentMatchLine}>{match.line_number}</span>
														<span class={s.contentMatchText}>
															{preview().before}
															<span class={s.contentMatchHighlight}>{preview().hit}</span>
															{preview().after}
														</span>
													</div>
												);
											}}
										</For>
									</div>
								)}
							</For>
						</Show>
					</Match>

					{/* Filename search: flat results across the whole folder. The last
					    results stay up while the next query runs, so typing never flashes. */}
					<Match when={searchQuery().trim()}>
						<Show when={inlineCreate()}>
							<InlineCreateRow />
						</Show>
						<Show
							when={filteredEntries().length > 0}
							fallback={
								<Show
									when={!searching()}
									fallback={<EmptyState loading title={t("fileBrowser.searching", "Searching\u2026")} />}
								>
									<Show when={!inlineCreate()}>
										<EmptyState icon={IconSearch} title={`No files match \u201C${searchQuery().trim()}\u201D`} />
									</Show>
								</Show>
							}
						>
							<For each={filteredEntries()}>{(entry, index) => <FlatRow entry={entry} index={index()} result />}</For>
						</Show>
					</Match>

					<Match when={error()}>
						<EmptyState
							tone="error"
							icon={IconAlert}
							title={t("fileBrowser.error", "Couldn't read this folder")}
							description={error() ?? ""}
						/>
					</Match>

					<Match when={loading()}>
						<EmptyState loading title={t("fileBrowser.loading", "Loading\u2026")} />
					</Match>

					{/* Tree view */}
					<Match when={viewMode() === "tree"}>
						{/* Inline create at the tree root; deeper parents render inside their TreeNode */}
						<Show when={inlineCreate()?.parent === ""}>
							<InlineCreateRow depth={0} />
						</Show>
						<Show
							when={filteredEntries().length > 0}
							fallback={
								<Show when={!inlineCreate()}>
									<EmptyFolder />
								</Show>
							}
						>
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
					</Match>

					{/* Flat list: the folder the breadcrumb names */}
					<Match when={true}>
						{/* Inline create row — shown at the top of the current listing */}
						<Show when={inlineCreate()}>
							<InlineCreateRow />
						</Show>
						<Show
							when={filteredEntries().length > 0}
							fallback={
								<Show when={!inlineCreate()}>
									<EmptyFolder />
								</Show>
							}
						>
							<For each={filteredEntries()}>{(entry, index) => <FlatRow entry={entry} index={index()} />}</For>
						</Show>
					</Match>
				</Switch>
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
				title={deleteDialogTitle()}
				message={deleteDialogMessage()}
				confirmLabel="Delete"
				kind="warning"
				onClose={() => setDeleteDialogVisible(false)}
				onConfirm={confirmDelete}
			/>
		</div>
	);
};

export default FileBrowserPanel;
