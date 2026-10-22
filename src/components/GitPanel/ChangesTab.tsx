import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	For,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { invoke } from "../../invoke";
import { isMacOS } from "../../platform";
import { appLogger } from "../../stores/appLogger";
import { isDiffStatus } from "../../stores/diffTabs";
import { promptLibraryStore } from "../../stores/promptLibrary";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import { cx, globToRegex } from "../../utils";
import { joinPath } from "../../utils/pathUtils";
import { fileContextSmartMenuItem } from "../../utils/promptContext";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu";
import { FileIcon } from "../FileBrowserPanel/FileIcon";
import {
	IconAlert,
	IconCheck,
	IconClose,
	IconFolder,
	IconGit,
	IconMinus,
	IconPlus,
	IconSparkle,
	IconUndo,
} from "../icons";
import { SmartButtonStrip } from "../SmartButtonStrip/SmartButtonStrip";
import { EmptyState } from "../shared/EmptyState";
import { SearchField } from "../shared/SearchField";
import { SectionAction, SectionHeader } from "../shared/SectionHeader";
import { Spinner } from "../shared/Spinner";
import s from "./ChangesTab.module.css";
import type { OpenDiffFn } from "./GitPanel";
import type { CommitLogEntry, WorkingTreeStatus } from "./types";

/** Unified file entry for rendering */
interface FileEntry {
	path: string;
	status: string;
	additions: number;
	deletions: number;
}

type Section = "staged" | "unstaged";

export interface ChangesTabProps {
	repoPath: string | null;
	/** Repo key for store operations (getRevision). Falls back to repoPath. */
	storeRepoPath?: string | null;
	onFileSelect?: (path: string) => void;
	onOpenDiff: OpenDiffFn;
}

/** The commit field grows from 2 lines to 8 (19px line height), then scrolls. */
const FIELD_MIN_H = 38;
const FIELD_MAX_H = 152;
/** How long the Commit pill says "Committed" after a commit lands. */
const COMMITTED_FLASH_MS = 2400;
/** The longest a row waits for the list to re-read after a stage / unstage / discard. */
const BUSY_SAFETY_MS = 4000;

/** The status letter, its colour class and the word its tooltip spells out. */
function statusInfo(status: string): { letter: string; word: string; cls: string } {
	switch (status) {
		case "M":
			return { letter: "M", word: "Modified", cls: s.statusM };
		case "T":
			return { letter: "T", word: "Type changed", cls: s.statusM };
		case "A":
			return { letter: "A", word: "Added", cls: s.statusA };
		case "D":
			return { letter: "D", word: "Deleted", cls: s.statusD };
		case "R":
			return { letter: "R", word: "Renamed", cls: s.statusR };
		case "C":
			return { letter: "C", word: "Copied", cls: s.statusR };
		case "?":
			return { letter: "U", word: "Untracked", cls: s.statusUntracked };
		default:
			return { letter: status.slice(0, 1) || "?", word: "Changed", cls: s.statusUntracked };
	}
}

/**
 * Basename and parent folder (no trailing separator) of a status path, `/` or
 * `\`. A collapsed untracked directory (`providers/`) names the directory.
 */
function splitPath(filePath: string): { dir: string; base: string } {
	const path = isDirEntry(filePath) ? filePath.slice(0, -1) : filePath;
	const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	if (lastSep === -1) return { dir: "", base: path };
	return { dir: path.slice(0, lastSep), base: path.slice(lastSep + 1) };
}

/**
 * True for collapsed untracked-directory entries. `git status` (without
 * `--untracked-files=all`) reports a wholly-untracked directory as a single
 * trailing-slash path (e.g. `providers/`) — that's not a file, so it has no
 * diff. Until the backend expands these into individual files, treat them as
 * non-diffable so a plain click doesn't open an empty "No changes" tab.
 */
export function isDirEntry(filePath: string): boolean {
	return filePath.endsWith("/") || filePath.endsWith("\\");
}

export const ChangesTab: Component<ChangesTabProps> = (props) => {
	const [staged, setStaged] = createSignal<FileEntry[]>([]);
	const [unstaged, setUnstaged] = createSignal<FileEntry[]>([]);
	/** The checked-out branch, from the same get_working_tree_status answer (null: detached). */
	const [branch, setBranch] = createSignal<string | null>(null);
	/** The first status answer for this repo has arrived (until then, no "No changes" flash). */
	const [loaded, setLoaded] = createSignal(false);
	const [statusError, setStatusError] = createSignal<string | null>(null);
	const [stagedExpanded, setStagedExpanded] = createSignal(true);
	const [unstagedExpanded, setUnstagedExpanded] = createSignal(true);
	const [confirmDiscard, setConfirmDiscard] = createSignal<FileEntry | null>(null);
	const [confirmDiscardAll, setConfirmDiscardAll] = createSignal(false);
	const [focusedIndex, setFocusedIndex] = createSignal(-1);
	/** The row cursor was last moved by the keyboard — only then does it draw its ring. */
	const [keyboardNav, setKeyboardNav] = createSignal(false);
	const [filterQuery, setFilterQuery] = createSignal("");
	// Multi-select: tracks selected file paths with their section
	const [selectedKeys, setSelectedKeys] = createSignal<Set<string>>(new Set());
	let lastClickedIndex = -1; // anchor for shift-click range select
	let containerRef: HTMLDivElement | undefined;
	let listRef: HTMLDivElement | undefined;
	const ctxMenu = createContextMenu();
	const [ctxMenuItems, setCtxMenuItems] = createSignal<ContextMenuItem[]>([]);
	/** Repo key for store operations (revision tracking). May differ from repoPath in worktrees. */
	const storeKey = () => props.storeRepoPath || props.repoPath;
	/** Plain directories have no git index: no composer, no status queries. */
	const isGitRepo = () => {
		const key = storeKey();
		return !!key && repositoriesStore.isGitRepo(key);
	};

	const filterActive = () => filterQuery().trim() !== "";
	const filterRe = createMemo(() => {
		const q = filterQuery().trim();
		return q ? globToRegex(q) : null;
	});

	/** Filtered staged files (glob wildcard support) */
	const filteredStaged = createMemo(() => {
		const re = filterRe();
		return re ? staged().filter((f) => re.test(f.path)) : staged();
	});

	/** Filtered unstaged files (glob wildcard support) */
	const filteredUnstaged = createMemo(() => {
		const re = filterRe();
		return re ? unstaged().filter((f) => re.test(f.path)) : unstaged();
	});

	const hasChanges = () => staged().length > 0 || unstaged().length > 0;
	const hasTrackedUnstaged = () => unstaged().some((f) => f.status !== "?");
	const noFilterMatch = () => filterActive() && filteredStaged().length === 0 && filteredUnstaged().length === 0;

	/**
	 * Rows waiting on git (stage, unstage, discard): a spinner holds their actions'
	 * place until the list re-reads — the repo watcher's debounce can keep a staged
	 * row in place for half a second after git is done.
	 */
	const [busyKeys, setBusyKeys] = createSignal<ReadonlySet<string>>(new Set());
	const busyTimers = new Set<ReturnType<typeof setTimeout>>();
	onCleanup(() => {
		for (const t of busyTimers) clearTimeout(t);
	});

	/** Run a git mutation with `keys` busy; on success they stay busy until the next status answer. */
	async function whileBusy(keys: string[], op: () => Promise<unknown>): Promise<void> {
		const mark = (on: boolean) =>
			setBusyKeys((prev) => {
				const next = new Set(prev);
				for (const k of keys) {
					if (on) next.add(k);
					else next.delete(k);
				}
				return next;
			});
		mark(true);
		try {
			await op();
		} catch (err) {
			mark(false);
			throw err;
		}
		// Never strand a spinner when no re-read follows (nothing changed on disk).
		const timer = setTimeout(() => {
			busyTimers.delete(timer);
			mark(false);
		}, BUSY_SAFETY_MS);
		busyTimers.add(timer);
	}

	// Commit section signals
	const [commitMsg, setCommitMsg] = createSignal("");
	const [isAmend, setIsAmend] = createSignal(false);
	/** The commit Amend rewrites — its short hash names it in the placeholder and the tooltip. */
	const [lastCommit, setLastCommit] = createSignal<{ hash: string; subject: string } | null>(null);
	const [committing, setCommitting] = createSignal(false);
	const [commitError, setCommitError] = createSignal<string | null>(null);
	/** Set for a moment after a commit lands: the Commit pill says "Committed" / "Amended". */
	const [justCommitted, setJustCommitted] = createSignal<"commit" | "amend" | null>(null);
	// Stores the user-typed message when switching to amend mode
	let savedDraftMsg = "";
	let successTimeout: ReturnType<typeof setTimeout> | undefined;
	let commitTextareaRef: HTMLTextAreaElement | undefined;

	const smartPrompts = useSmartPrompts();
	const { canExecute: canExecPrompt, executeSmartPrompt } = smartPrompts;
	const [generating, setGenerating] = createSignal(false);
	let generateGeneration = 0;

	// Listen for generated commit messages from headless smart prompts
	const handleCommitMsg = (e: Event) => {
		const detail = (e as CustomEvent<string>).detail;
		if (detail) {
			setCommitMsg(detail.trim());
			setJustCommitted(null);
		}
	};
	window.addEventListener("smart-prompt:commit-message", handleCommitMsg);

	onCleanup(() => {
		if (successTimeout) clearTimeout(successTimeout);
		window.removeEventListener("smart-prompt:commit-message", handleCommitMsg);
	});

	// The field follows its text however it changes: typing, a generated message,
	// Amend loading the last subject, the draft coming back, a commit clearing it.
	createEffect(
		on(
			commitMsg,
			() => {
				if (commitTextareaRef) autoResize(commitTextareaRef);
			},
			{ defer: true },
		),
	);

	// Fetch working tree status on mount and revision changes
	let fetchedFor: string | null = null;
	createEffect(() => {
		const repoPath = props.repoPath;
		if (!repoPath) {
			setStaged([]);
			setUnstaged([]);
			setLoaded(false);
			return;
		}
		// A different repository: forget the last one's branch, error and selection.
		if (repoPath !== fetchedFor) {
			if (fetchedFor !== null) {
				setSelectedKeys(new Set<string>());
				setFocusedIndex(-1);
				lastClickedIndex = -1;
			}
			fetchedFor = repoPath;
			setStaged([]);
			setUnstaged([]);
			setBranch(null);
			setStatusError(null);
			setLoaded(false);
		}

		// Subscribe to revision changes
		void repositoriesStore.getRevision(storeKey() || repoPath);

		// Plain directories have no git index — asking would fail on every revision bump.
		if (!repositoriesStore.isGitRepo(storeKey() || repoPath)) {
			setStaged([]);
			setUnstaged([]);
			return;
		}

		let cancelled = false;
		onCleanup(() => {
			cancelled = true;
		});

		invoke<WorkingTreeStatus>("get_working_tree_status", { path: repoPath })
			.then((status) => {
				if (cancelled) return;
				setBranch(status.branch ?? null);
				setStaged(
					status.staged.map((e) => ({
						path: e.path,
						status: e.status,
						additions: e.additions ?? 0,
						deletions: e.deletions ?? 0,
					})),
				);

				// Combine unstaged (tracked changes) and untracked into one list
				const combined: FileEntry[] = [
					...status.unstaged.map((e) => ({
						path: e.path,
						status: e.status,
						additions: e.additions ?? 0,
						deletions: e.deletions ?? 0,
					})),
					...status.untracked.map((p) => ({ path: p, status: "?", additions: 0, deletions: 0 })),
				];
				setUnstaged(combined);
				setStatusError(null);
				setLoaded(true);
				setBusyKeys(new Set<string>());
			})
			.catch((err) => {
				if (cancelled) return;
				appLogger.error("git", "Failed to get working tree status", err);
				setStaged([]);
				setUnstaged([]);
				setStatusError(typeof err === "string" ? err : String(err));
				setLoaded(true);
			});
	});

	// --- Actions ---

	async function stageFile(filePath: string) {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		try {
			await whileBusy([makeKey("unstaged", filePath)], () =>
				invoke("git_stage_files", { path: repoPath, files: [filePath] }),
			);
		} catch (err) {
			appLogger.error("git", `Failed to stage ${filePath}`, err);
			toastsStore.add("Stage failed", `Could not stage "${filePath}": ${String(err)}`, "error", true);
		}
	}

	async function unstageFile(filePath: string) {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		try {
			await whileBusy([makeKey("staged", filePath)], () =>
				invoke("git_unstage_files", { path: repoPath, files: [filePath] }),
			);
		} catch (err) {
			appLogger.error("git", `Failed to unstage ${filePath}`, err);
			toastsStore.add("Unstage failed", `Could not unstage "${filePath}": ${String(err)}`, "error", true);
		}
	}

	async function discardFile(filePath: string) {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		try {
			await whileBusy([makeKey("unstaged", filePath)], () =>
				invoke("git_discard_files", { path: repoPath, files: [filePath] }),
			);
			// git restore only touches the working tree (not .git/index) for tracked
			// modified files, so repo_watcher routes via WORKING_TREE_DEBOUNCE
			// (1500ms) instead of GIT_STATE_DEBOUNCE (500ms). Bump revision so the
			// UI updates immediately. (#1378-ce1c)
			repositoriesStore.bumpRevision(repoPath);
		} catch (err) {
			appLogger.error("git", `Failed to discard ${filePath}`, err);
			toastsStore.add("Discard failed", `Could not discard "${filePath}": ${String(err)}`, "error", true);
		}
	}

	async function stageAll() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		const files = unstaged().map((f) => f.path);
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("unstaged", f)),
				() => invoke("git_stage_files", { path: repoPath, files }),
			);
		} catch (err) {
			appLogger.error("git", "Failed to stage all files", err);
			toastsStore.add("Stage failed", `Could not stage all files: ${String(err)}`, "error", true);
		}
	}

	async function unstageAll() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		const files = staged().map((f) => f.path);
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("staged", f)),
				() => invoke("git_unstage_files", { path: repoPath, files }),
			);
		} catch (err) {
			appLogger.error("git", "Failed to unstage all files", err);
			toastsStore.add("Unstage failed", `Could not unstage all files: ${String(err)}`, "error", true);
		}
	}

	async function discardAll() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		// Only discard tracked modified files, not untracked
		const files = unstaged()
			.filter((f) => f.status !== "?")
			.map((f) => f.path);
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("unstaged", f)),
				() => invoke("git_discard_files", { path: repoPath, files }),
			);
			repositoriesStore.bumpRevision(repoPath); // see discardFile (#1378-ce1c)
		} catch (err) {
			appLogger.error("git", "Failed to discard all files", err);
			toastsStore.add("Discard failed", `Could not discard all files: ${String(err)}`, "error", true);
		}
	}

	function openDiff(file: FileEntry, section: Section) {
		if (!props.repoPath || !isDiffStatus(file.status) || isDirEntry(file.path)) return;
		props.onOpenDiff(
			props.repoPath,
			file.path,
			file.status,
			section === "staged" ? "staged" : undefined,
			file.status === "?" || undefined,
		);
	}

	// --- Multi-select helpers ---

	/** Unique key for a file entry (section:path) to distinguish staged vs unstaged */
	const makeKey = (section: Section, path: string) => `${section}:${path}`;

	function handleFileClick(e: MouseEvent, flatIndex: number, section: Section, file: FileEntry) {
		const key = makeKey(section, file.path);
		const files = visibleFiles();

		if (e.shiftKey && lastClickedIndex >= 0) {
			// Range select: from lastClickedIndex to flatIndex
			const start = Math.min(lastClickedIndex, flatIndex);
			const end = Math.max(lastClickedIndex, flatIndex);
			const next = new Set(selectedKeys());
			for (let i = start; i <= end; i++) {
				if (i < files.length) next.add(makeKey(files[i].section, files[i].file.path));
			}
			setSelectedKeys(next);
		} else if (e.metaKey || e.ctrlKey) {
			// Toggle select
			const next = new Set(selectedKeys());
			if (next.has(key)) next.delete(key);
			else next.add(key);
			setSelectedKeys(next);
			lastClickedIndex = flatIndex;
		} else {
			// Single select
			setSelectedKeys(new Set([key]));
			lastClickedIndex = flatIndex;
		}
		setKeyboardNav(false);
		setFocusedIndex(flatIndex);
	}

	/** Get selected files for a given section */
	function getSelectedInSection(section: Section): string[] {
		const prefix = `${section}:`;
		return [...selectedKeys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
	}

	async function stageSelected() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		const files = getSelectedInSection("unstaged");
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("unstaged", f)),
				() => invoke("git_stage_files", { path: repoPath, files }),
			);
			setSelectedKeys(new Set<string>());
		} catch (err) {
			appLogger.error("git", "Failed to stage selected files", err);
			toastsStore.add("Stage failed", `Could not stage selected files: ${String(err)}`, "error", true);
		}
	}

	async function unstageSelected() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		const files = getSelectedInSection("staged");
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("staged", f)),
				() => invoke("git_unstage_files", { path: repoPath, files }),
			);
			setSelectedKeys(new Set<string>());
		} catch (err) {
			appLogger.error("git", "Failed to unstage selected files", err);
			toastsStore.add("Unstage failed", `Could not unstage selected files: ${String(err)}`, "error", true);
		}
	}

	async function discardSelected() {
		const repoPath = props.repoPath;
		if (!repoPath) return;
		const files = getSelectedInSection("unstaged").filter((p) => {
			const entry = unstaged().find((f) => f.path === p);
			return entry && entry.status !== "?"; // Only discard tracked files
		});
		if (files.length === 0) return;
		try {
			await whileBusy(
				files.map((f) => makeKey("unstaged", f)),
				() => invoke("git_discard_files", { path: repoPath, files }),
			);
			setSelectedKeys(new Set<string>());
			repositoriesStore.bumpRevision(repoPath); // see discardFile (#1378-ce1c)
		} catch (err) {
			appLogger.error("git", "Failed to discard selected files", err);
			toastsStore.add("Discard failed", `Could not discard selected files: ${String(err)}`, "error", true);
		}
	}

	function buildContextMenuItems(section: Section, file: FileEntry): ContextMenuItem[] {
		const sel = selectedKeys();
		const key = makeKey(section, file.path);
		// If right-clicked file is not in selection, select only it
		const effectiveSelection = sel.has(key) ? sel : new Set([key]);
		const stagedPaths = [...effectiveSelection].filter((k) => k.startsWith("staged:"));
		const unstagedPaths = [...effectiveSelection].filter((k) => k.startsWith("unstaged:"));
		const items: ContextMenuItem[] = [];

		if (unstagedPaths.length > 0) {
			const count = unstagedPaths.length;
			items.push({
				label: count > 1 ? `Stage ${count} files` : "Stage",
				shortcut: "Space",
				action: () => {
					if (!sel.has(key)) setSelectedKeys(new Set<string>([key]));
					stageSelected();
				},
			});
		}
		if (stagedPaths.length > 0) {
			const count = stagedPaths.length;
			items.push({
				label: count > 1 ? `Unstage ${count} files` : "Unstage",
				shortcut: "Space",
				action: () => {
					if (!sel.has(key)) setSelectedKeys(new Set<string>([key]));
					unstageSelected();
				},
			});
		}
		if (isDiffStatus(file.status) && !isDirEntry(file.path)) {
			items.push({ label: "Open diff", shortcut: "Enter", action: () => openDiff(file, section) });
		}
		if (unstagedPaths.length > 0) {
			const trackable = unstagedPaths.filter((k) => {
				const p = k.slice("unstaged:".length);
				const entry = unstaged().find((f) => f.path === p);
				return entry && entry.status !== "?";
			});
			if (trackable.length > 0) {
				items.push({ separator: true, label: "", action: () => {} });
				items.push({
					label: trackable.length > 1 ? `Discard ${trackable.length} files` : "Discard changes",
					shortcut: "⌫",
					action: () => {
						if (!sel.has(key)) setSelectedKeys(new Set<string>([key]));
						if (trackable.length === 1) {
							setConfirmDiscard(unstaged().find((f) => f.path === trackable[0].slice("unstaged:".length)) ?? null);
						} else {
							discardSelected();
						}
					},
				});
			}
		}

		// Add to .gitignore
		if (effectiveSelection.size === 1) {
			items.push({ separator: true, label: "", action: () => {} });
			items.push({
				label: "Add to .gitignore",
				action: async () => {
					if (!props.repoPath) return;
					try {
						await invoke("add_to_gitignore", { repoPath: props.repoPath, pattern: file.path });
					} catch (err) {
						appLogger.error("git", "Failed to add to .gitignore", err);
					}
				},
			});
		}

		// Smart prompts with placement="file-context" — only when right-clicked a single file.
		if (effectiveSelection.size === 1) {
			const repoRoot = props.repoPath;
			const abs = repoRoot ? joinPath(repoRoot, file.path) : file.path;
			const smartItem = fileContextSmartMenuItem({ absPath: abs, repoRoot, isDir: false }, smartPrompts, {
				separator: true,
			});
			if (smartItem) items.push(smartItem);
		}

		return items;
	}

	function handleContextMenu(e: MouseEvent, flatIndex: number, section: Section, file: FileEntry) {
		e.preventDefault();
		e.stopPropagation();
		// If the right-clicked file is not selected, select only it
		const key = makeKey(section, file.path);
		if (!selectedKeys().has(key)) {
			setSelectedKeys(new Set([key]));
			lastClickedIndex = flatIndex;
		}
		setKeyboardNav(false);
		setFocusedIndex(flatIndex);
		setCtxMenuItems(buildContextMenuItems(section, file));
		ctxMenu.open(e);
	}

	// --- Composer ---

	const shortcut = isMacOS() ? "⌘↵" : "Ctrl+Enter";
	const shortHash = () => lastCommit()?.hash.slice(0, 7) ?? "";

	/** Names the shortcut, and the branch (or the commit Amend rewrites). */
	const placeholder = () => {
		if (isAmend())
			return shortHash() ? `Message (${shortcut} to amend ${shortHash()})` : `Message (${shortcut} to amend)`;
		const b = branch();
		return b ? `Message (${shortcut} to commit on ${b})` : `Message (${shortcut} to commit)`;
	};

	/** Why Commit can't run right now, or null when it can. */
	const commitBlockReason = (): string | null => {
		if (!isAmend() && staged().length === 0) return "Stage files to commit, or turn on Amend";
		// git refuses an empty message, amend or not (`commit -m ""` aborts).
		if (!commitMsg().trim()) return "Write a commit message";
		return null;
	};

	/** The pill looks disabled only at rest; busy and just-committed keep their fill. */
	const commitBlocked = () => !committing() && !justCommitted() && commitBlockReason() !== null;

	const commitLabel = () => {
		if (committing()) return isAmend() ? "Amending…" : "Committing…";
		const done = justCommitted();
		if (done) return done === "amend" ? "Amended" : "Committed";
		return isAmend() ? "Amend" : "Commit";
	};

	const commitTitle = () => {
		if (committing() || justCommitted()) return undefined;
		const reason = commitBlockReason();
		if (reason) return reason;
		if (isAmend()) return `${shortHash() ? `Amend ${shortHash()}` : "Amend the last commit"} (${shortcut})`;
		const n = staged().length;
		const b = branch();
		return `Commit ${n} staged ${n === 1 ? "file" : "files"}${b ? ` to ${b}` : ""} (${shortcut})`;
	};

	const generateTitle = () => {
		if (generating()) return "Stop generating";
		return hasChanges() ? "Generate a message from the changes" : "No changes to describe";
	};

	async function generateCommitMsg() {
		const prompt = promptLibraryStore.getSmartByPlacement("git-changes").find((p) => p.id === "smart-commit-msg");
		if (!prompt) return;
		const check = canExecPrompt(prompt);
		if (!check.ok) {
			setCommitError(check.reason ?? "Cannot generate commit message");
			return;
		}
		setCommitError(null);
		setGenerating(true);
		const gen = ++generateGeneration;
		try {
			const result = await executeSmartPrompt(prompt);
			if (gen !== generateGeneration) return;
			if (!result.ok) setCommitError(result.reason ?? "Failed to generate commit message");
		} catch (err) {
			if (gen !== generateGeneration) return;
			setCommitError(String(err));
		} finally {
			if (gen === generateGeneration) setGenerating(false);
		}
	}

	function cancelGenerate() {
		generateGeneration++;
		setGenerating(false);
		setCommitError(null);
	}

	function handleGenerateClick() {
		if (generating()) cancelGenerate();
		else if (hasChanges()) void generateCommitMsg();
	}

	async function doCommit() {
		const repoPath = props.repoPath;
		if (!repoPath || committing() || commitBlockReason()) return;
		const amend = isAmend();
		const msg = commitMsg().trim();
		// The field is disabled while git runs, which drops its focus; hand it back after.
		const fieldHadFocus = !!commitTextareaRef && document.activeElement === commitTextareaRef;

		setCommitting(true);
		setCommitError(null);
		setJustCommitted(null);
		try {
			await invoke<string>("git_commit", {
				path: repoPath,
				message: msg,
				amend: amend || null,
			});
			setCommitMsg("");
			setIsAmend(false);
			savedDraftMsg = "";
			setJustCommitted(amend ? "amend" : "commit");
			if (successTimeout) clearTimeout(successTimeout);
			successTimeout = setTimeout(() => setJustCommitted(null), COMMITTED_FLASH_MS);
		} catch (err) {
			const errStr = typeof err === "string" ? err : String(err);
			setCommitError(errStr);
			appLogger.error("git", "Commit failed", err);
		} finally {
			setCommitting(false);
			if (fieldHadFocus) commitTextareaRef?.focus();
		}
	}

	async function toggleAmend() {
		if (committing()) return;
		const next = !isAmend();
		if (next) {
			// Save current draft before overwriting with last commit message
			savedDraftMsg = commitMsg();
			setLastCommit(null);
			if (props.repoPath) {
				try {
					const log = await invoke<CommitLogEntry[]>("get_commit_log", {
						path: props.repoPath,
						count: 1,
					});
					if (log.length > 0) {
						setLastCommit({ hash: log[0].hash, subject: log[0].subject });
						setCommitMsg(log[0].subject);
					}
				} catch (err) {
					appLogger.error("git", "Failed to fetch last commit for amend", err);
				}
			}
		} else {
			// Restore previously typed message
			setCommitMsg(savedDraftMsg);
			savedDraftMsg = "";
		}
		setIsAmend(next);
		setCommitError(null);
		setJustCommitted(null);
	}

	function handleCommitKeyDown(e: KeyboardEvent) {
		// Cmd+Enter (Mac) or Ctrl+Enter (others) to commit
		if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void doCommit();
		}
	}

	/** Size the field to its text between 2 and 8 lines; scroll past that. */
	function autoResize(el: HTMLTextAreaElement) {
		el.style.height = "auto";
		const natural = el.scrollHeight;
		el.style.height = `${Math.max(FIELD_MIN_H, Math.min(natural, FIELD_MAX_H))}px`;
		el.style.overflowY = natural > FIELD_MAX_H ? "auto" : "hidden";
	}

	function handleConfirmDiscard() {
		const file = confirmDiscard();
		if (file) {
			discardFile(file.path);
			setConfirmDiscard(null);
		}
	}

	function handleConfirmDiscardAll() {
		discardAll();
		setConfirmDiscardAll(false);
	}

	// --- Keyboard ---

	/** The rows as drawn (filter and collapsed sections applied), for keyboard navigation */
	function visibleFiles(): { file: FileEntry; section: Section }[] {
		const result: { file: FileEntry; section: Section }[] = [];
		if (stagedExpanded()) {
			for (const f of filteredStaged()) result.push({ file: f, section: "staged" });
		}
		if (unstagedExpanded()) {
			for (const f of filteredUnstaged()) result.push({ file: f, section: "unstaged" });
		}
		return result;
	}

	/** Keep the keyboard cursor's row in view. */
	function revealFocused() {
		listRef?.querySelector<HTMLElement>("[data-focused]")?.scrollIntoView({ block: "nearest" });
	}

	function moveFocus(index: number) {
		setKeyboardNav(true);
		setFocusedIndex(index);
		revealFocused();
	}

	function handleListKeyDown(e: KeyboardEvent) {
		// Fields, and buttons (composer, section headers, row actions), keep their own keys.
		const target = e.target as HTMLElement | null;
		if (target?.closest("input, textarea, select, button, [contenteditable='true']")) return;

		const files = visibleFiles();
		if (files.length === 0) return;

		const idx = focusedIndex();

		if (e.key === "ArrowDown") {
			e.preventDefault();
			moveFocus(Math.min(idx + 1, files.length - 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			moveFocus(Math.max(idx - 1, 0));
			return;
		}

		if (idx < 0 || idx >= files.length) return;
		const { file, section } = files[idx];

		if (e.key === " ") {
			e.preventDefault();
			if (section === "unstaged") stageFile(file.path);
			else unstageFile(file.path);
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			openDiff(file, section);
			return;
		}
		// Discard is for tracked changes only: git restore has nothing to restore for an untracked file.
		if ((e.key === "Delete" || e.key === "Backspace") && section === "unstaged" && file.status !== "?") {
			e.preventDefault();
			setConfirmDiscard(file);
			return;
		}
	}

	/** ArrowDown walks from the filter into the list; Esc on an empty filter hands focus to it. */
	function handleFilterKeyDown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			if (visibleFiles().length === 0) return;
			e.preventDefault();
			e.stopPropagation();
			containerRef?.focus({ preventScroll: true });
			moveFocus(0);
			return;
		}
		if (e.key === "Escape" && filterQuery() === "") {
			e.preventDefault();
			e.stopPropagation();
			containerRef?.focus({ preventScroll: true });
		}
	}

	// --- Rendering helpers ---

	function renderFileEntry(file: FileEntry, section: Section, index: () => number) {
		const { dir, base } = splitPath(file.path);
		const key = makeKey(section, file.path);
		const status = statusInfo(file.status);
		const selected = () => selectedKeys().has(key);
		const picked = () => selected() && selectedKeys().size > 1;
		const cursor = () => focusedIndex() === index();
		const busy = () => busyKeys().has(key);
		return (
			<div
				class={cx(
					s.fileEntry,
					selected() && s.fileSelected,
					picked() && s.filePicked,
					cursor() && keyboardNav() && s.fileFocused,
					busy() && s.fileBusy,
				)}
				aria-busy={busy() || undefined}
				title={file.path}
				data-focused={cursor() ? "" : undefined}
				onClick={(e) => {
					handleFileClick(e, index(), section, file);
					// Open diff on plain click (no modifier)
					if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
						openDiff(file, section);
						props.onFileSelect?.(file.path);
					}
				}}
				onContextMenu={(e) => handleContextMenu(e, index(), section, file)}
			>
				<Show when={isDirEntry(file.path)} fallback={<FileIcon name={base} isDir={false} class={s.fileIcon} />}>
					<span class={cx(s.fileIcon, s.dirIcon)}>
						<IconFolder size={16} />
					</span>
				</Show>
				<span class={s.fileLabel}>
					<span class={cx(s.fileName, file.status === "D" && s.fileNameDeleted)}>{base}</span>
					<Show when={dir}>
						<span class={s.fileDir}>{dir}</span>
					</Show>
				</span>
				<span class={s.fileTrail}>
					<Show when={file.status !== "?" && (file.additions > 0 || file.deletions > 0)}>
						<span class={s.diffStats}>
							<Show when={file.additions > 0}>
								<span class={s.diffAdd}>+{file.additions}</span>
							</Show>
							<Show when={file.deletions > 0}>
								<span class={s.diffDel}>−{file.deletions}</span>
							</Show>
						</span>
					</Show>
					<span class={s.actions}>
						<Show when={section === "staged"}>
							<button
								type="button"
								class={s.actionBtn}
								title="Unstage"
								aria-label="Unstage"
								onClick={(e) => {
									e.stopPropagation();
									unstageFile(file.path);
								}}
							>
								<IconMinus size={16} />
							</button>
						</Show>
						<Show when={section === "unstaged"}>
							<Show when={file.status !== "?"}>
								<button
									type="button"
									class={cx(s.actionBtn, s.actionBtnDanger)}
									title="Discard changes"
									aria-label="Discard changes"
									onClick={(e) => {
										e.stopPropagation();
										setConfirmDiscard(file);
									}}
								>
									<IconUndo size={16} />
								</button>
							</Show>
							<button
								type="button"
								class={s.actionBtn}
								title="Stage"
								aria-label="Stage"
								onClick={(e) => {
									e.stopPropagation();
									stageFile(file.path);
								}}
							>
								<IconPlus size={16} />
							</button>
						</Show>
					</span>
					<Show when={busy()}>
						<span class={s.rowSpinner}>
							<Spinner size={14} />
						</span>
					</Show>
				</span>
				<span class={cx(s.statusLetter, status.cls)} title={status.word}>
					{status.letter}
				</span>
			</div>
		);
	}

	return (
		<div class={s.container} ref={containerRef} onKeyDown={handleListKeyDown} tabIndex={-1}>
			<Switch>
				<Match when={!props.repoPath}>
					<EmptyState
						icon={IconGit}
						title="No repository"
						description="Open a repository in the sidebar to see its changes."
					/>
				</Match>
				<Match when={!isGitRepo()}>
					<EmptyState
						icon={IconGit}
						title="Not a Git repository"
						description="This folder isn't under version control."
					/>
				</Match>
				<Match when={props.repoPath}>
					{/* Composer — the field, then one row of controls; errors under the card */}
					<div class={s.commitSection} onKeyDown={handleCommitKeyDown}>
						<div class={s.composer}>
							<textarea
								ref={(el) => {
									commitTextareaRef = el;
									requestAnimationFrame(() => autoResize(el));
								}}
								class={s.commitTextarea}
								data-focus-target="git-commit"
								data-repo-path={props.repoPath ?? ""}
								aria-label="Commit message"
								placeholder={placeholder()}
								rows={2}
								value={commitMsg()}
								onInput={(e) => {
									setCommitMsg(e.currentTarget.value);
									setJustCommitted(null);
									if (commitError()) setCommitError(null);
								}}
								disabled={committing()}
							/>
							<div class={s.composerRow}>
								<button
									type="button"
									class={s.generateBtn}
									aria-disabled={!generating() && !hasChanges() ? "true" : undefined}
									aria-busy={generating() || undefined}
									aria-label={generateTitle()}
									title={generateTitle()}
									onClick={handleGenerateClick}
								>
									<Show when={generating()} fallback={<IconSparkle size={16} />}>
										<Spinner size={14} />
									</Show>
								</button>
								<button
									type="button"
									class={cx(s.amendToggle, isAmend() && s.amendToggleOn)}
									aria-pressed={isAmend()}
									title={isAmend() ? "Stop amending" : "Amend the last commit"}
									disabled={committing()}
									onClick={() => void toggleAmend()}
								>
									<Show when={isAmend()}>
										<IconCheck size={14} />
									</Show>
									Amend
								</button>
								<div class={s.smartSlot}>
									<SmartButtonStrip
										appearance="chip"
										class={s.smartChip}
										placement="git-changes"
										repoPath={props.repoPath ?? ""}
										defaultPromptId="smart-commit"
										onError={(msg) => setCommitError(msg || null)}
									/>
								</div>
								<button
									type="button"
									class={s.commitBtn}
									aria-disabled={commitBlocked() || undefined}
									aria-busy={committing() || undefined}
									title={commitTitle()}
									onClick={() => void doCommit()}
								>
									<Show when={committing()}>
										<Spinner size={13} />
									</Show>
									<Show when={!committing() && justCommitted()}>
										<IconCheck size={14} />
									</Show>
									{commitLabel()}
								</button>
							</div>
						</div>
						<Show when={commitError()}>
							<div class={s.commitError} role="alert">
								<IconAlert size={14} class={s.errorIcon} />
								<div class={s.errorMessage}>{commitError()}</div>
								<button
									type="button"
									class={s.errorDismiss}
									title="Dismiss"
									aria-label="Dismiss"
									onClick={() => setCommitError(null)}
								>
									<IconClose size={12} stroke={2} />
								</button>
							</div>
						</Show>
					</div>

					<Switch>
						<Match when={statusError()}>
							<EmptyState
								tone="error"
								icon={IconAlert}
								title="Couldn't read the working tree"
								description={statusError() ?? ""}
							/>
						</Match>
						<Match when={loaded() && !hasChanges()}>
							<EmptyState
								icon={IconCheck}
								title="No changes"
								description={
									branch() ? `The working tree matches ${branch()}.` : "The working tree matches the last commit."
								}
							/>
						</Match>
						<Match when={hasChanges()}>
							<div class={s.filterRow}>
								<SearchField
									value={filterQuery()}
									onInput={setFilterQuery}
									placeholder="Filter files"
									title="* matches within a folder, ** across folders"
									inputClass={s.filterInput}
									onKeyDown={handleFilterKeyDown}
								/>
							</div>
							<div class={s.list} ref={listRef}>
								{/* Staged */}
								<Show when={filteredStaged().length > 0}>
									<SectionHeader
										label="Staged"
										count={filterActive() ? `${filteredStaged().length}/${staged().length}` : staged().length}
										open={stagedExpanded()}
										onToggle={() => setStagedExpanded((v) => !v)}
										actions={
											<SectionAction title="Unstage all" onClick={() => void unstageAll()}>
												<IconMinus size={16} />
											</SectionAction>
										}
									/>
									<Show when={stagedExpanded()}>
										<For each={filteredStaged()}>{(file, i) => renderFileEntry(file, "staged", i)}</For>
									</Show>
								</Show>

								{/* Unstaged (tracked changes + untracked) */}
								<Show when={filteredUnstaged().length > 0}>
									<SectionHeader
										label="Unstaged"
										count={filterActive() ? `${filteredUnstaged().length}/${unstaged().length}` : unstaged().length}
										open={unstagedExpanded()}
										onToggle={() => setUnstagedExpanded((v) => !v)}
										actions={
											<>
												<Show when={hasTrackedUnstaged()}>
													<SectionAction title="Discard all" tone="danger" onClick={() => setConfirmDiscardAll(true)}>
														<IconUndo size={16} />
													</SectionAction>
												</Show>
												<SectionAction title="Stage all" onClick={() => void stageAll()}>
													<IconPlus size={16} />
												</SectionAction>
											</>
										}
									/>
									<Show when={unstagedExpanded()}>
										<For each={filteredUnstaged()}>
											{(file, i) =>
												renderFileEntry(file, "unstaged", () => (stagedExpanded() ? filteredStaged().length : 0) + i())
											}
										</For>
									</Show>
								</Show>

								<Show when={noFilterMatch()}>
									<EmptyState size="compact" title={`No files match “${filterQuery().trim()}”`} />
								</Show>
							</div>
						</Match>
					</Switch>
				</Match>
			</Switch>

			{/* Context menu */}
			<ContextMenu
				items={ctxMenuItems()}
				visible={ctxMenu.visible()}
				x={ctxMenu.position().x}
				y={ctxMenu.position().y}
				onClose={ctxMenu.close}
			/>

			{/* Discard single file confirmation */}
			<ConfirmDialog
				visible={confirmDiscard() !== null}
				title="Discard changes"
				message={`Discard all changes to "${confirmDiscard()?.path ?? ""}"?\nThis cannot be undone.`}
				confirmLabel="Discard"
				kind="warning"
				onClose={() => setConfirmDiscard(null)}
				onConfirm={handleConfirmDiscard}
			/>

			{/* Discard all confirmation */}
			<ConfirmDialog
				visible={confirmDiscardAll()}
				title="Discard all changes"
				message="Discard all tracked working tree changes?\nThis cannot be undone."
				confirmLabel="Discard all"
				kind="warning"
				onClose={() => setConfirmDiscardAll(false)}
				onConfirm={handleConfirmDiscardAll}
			/>
		</div>
	);
};

export default ChangesTab;
