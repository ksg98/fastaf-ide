import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { BaseRefOption } from "../../hooks/useRepository";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import { cx } from "../../utils";
import { branchListsEqual } from "../../utils/branchListsEqual";
import { writeClipboard } from "../../utils/clipboard";
import { remoteUrlToGitHub } from "../../utils/githubUrl";
import { handleOpenUrl } from "../../utils/openUrl";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu/ContextMenu";
import {
	IconAlert,
	IconBranch,
	IconCheck,
	IconChevronDown,
	IconChevronRight,
	IconCommit,
	IconGit,
	IconMore,
	IconPlus,
	IconRefresh,
} from "../icons";
import { SmartButtonStrip } from "../SmartButtonStrip/SmartButtonStrip";
import { EmptyState } from "../shared/EmptyState";
import { SearchField } from "../shared/SearchField";
import { SectionHeader } from "../shared/SectionHeader";
import { Dropdown, type DropdownItem } from "../ui/Dropdown";
import s from "./BranchesTab.module.css";
import type { BranchDetail } from "./types";

/** Mirrors Rust `GitCommandResult` — run_git_command never throws; it returns
 *  success=false with stderr populated on git failure (e.g. merge conflict). */
interface GitCommandResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exit_code: number;
}

/** Detects git's "Already up to date." no-op message across merge/pull/push. */
function isAlreadyUpToDate(output: string): boolean {
	return /already up.to.date/i.test(output);
}

export interface BranchesTabProps {
	repoPath: string | null;
}

// --- Dates -------------------------------------------------------------------------------

/** git's `%(committerdate:iso8601)`: "2026-10-21 17:46:46 -0700". */
const GIT_ISO8601 = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/;

/**
 * git prints `%(committerdate:iso8601)` as "2026-10-21 17:46:46 -0700" — close to
 * ISO 8601 but not it, and JavaScriptCore (the app's WKWebView) parses it as
 * Invalid Date, so every age label and the stale dimming silently vanished.
 * Rewrite it to "2026-10-21T17:46:46-07:00"; any other string passes through.
 */
export function normalizeGitDate(raw: string): string {
	return raw.trim().replace(GIT_ISO8601, "$1T$2$3:$4");
}

/** A git date as epoch ms, or null when it is missing or unparseable. */
export function parseGitDate(raw: string | null | undefined): number | null {
	if (!raw) return null;
	const ms = new Date(normalizeGitDate(raw)).getTime();
	return Number.isNaN(ms) ? null : ms;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** A branch whose last commit is older than this reads as stale (its name dims). */
const STALE_MS = 30 * DAY_MS;

/** How long ago `ms` was, as a branch row's age: "now", "25m", "3h", "2d", "3w", "4mo", "1y". */
export function shortAge(ms: number, now: number = Date.now()): string {
	const diff = Math.max(0, now - ms);
	if (diff < MINUTE_MS) return "now";
	if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}m`;
	if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`;
	const days = Math.floor(diff / DAY_MS);
	if (days < 7) return `${days}d`;
	if (days < 35) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

/** True when the last commit (epoch ms) is more than 30 days old. */
export function isStale(ms: number | null, now: number = Date.now()): boolean {
	return ms !== null && now - ms > STALE_MS;
}

/** Build a multi-line tooltip string with full branch commit info */
function branchTooltip(branch: BranchDetail): string {
	const parts: string[] = [branch.name];
	const when = parseGitDate(branch.last_commit_date);
	if (when !== null) {
		parts.push(`Last commit: ${new Date(when).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`);
	}
	if (branch.last_commit_author) {
		parts.push(`Author: ${branch.last_commit_author}`);
	}
	if (branch.last_commit_message) {
		parts.push(`Message: ${branch.last_commit_message}`);
	}
	if (branch.is_merged) parts.push("Merged");
	return parts.join("\n");
}

/** A group of branches sharing a common prefix (text before the first "/") */
interface BranchGroup {
	prefix: string;
	branches: BranchDetail[];
}

/** One section's rows: branches without a prefix first, then the prefix groups. */
interface SectionLayout {
	ungrouped: BranchDetail[];
	groups: BranchGroup[];
}

/**
 * Split a branch list into ungrouped (no "/") and prefix groups.
 * Groups are sorted alphabetically; ungrouped branches come first.
 */
function groupBranchesByPrefix(branchList: BranchDetail[]): SectionLayout {
	const ungrouped: BranchDetail[] = [];
	const groupMap = new Map<string, BranchDetail[]>();

	for (const b of branchList) {
		const slashIdx = b.name.indexOf("/");
		if (slashIdx === -1) {
			ungrouped.push(b);
		} else {
			const prefix = b.name.slice(0, slashIdx + 1);
			let list = groupMap.get(prefix);
			if (!list) {
				list = [];
				groupMap.set(prefix, list);
			}
			list.push(b);
		}
	}

	const groups: BranchGroup[] = Array.from(groupMap.entries())
		.map(([prefix, branches]) => ({ prefix, branches }))
		.sort((a, b) => a.prefix.localeCompare(b.prefix));

	return { ungrouped, groups };
}

/** The list's three sections, in display order. */
type Section = "recent" | "local" | "remote";

/** Identity of one visible row. A branch can show twice (Recent and Local), so the
 *  key carries the section: selection and rename belong to the row, not the name. */
function rowKey(section: Section, branch: BranchDetail): string {
	return `${section}:${branch.name}`;
}

/** Keys that type into a field rather than drive the list. */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return (
		target.tagName === "INPUT" ||
		target.tagName === "SELECT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable
	);
}

const sameNames = (a: string[], b: string[]) => a.length === b.length && a.every((name, i) => name === b[i]);

// --- Dialog state types ---

/** Which confirm dialog is open, and what action it performs */
type DialogKind =
	| { type: "delete"; branch: BranchDetail }
	| { type: "merge"; branch: BranchDetail; currentBranch: string }
	| { type: "rebase"; branch: BranchDetail; currentBranch: string }
	| { type: "deleteMerged"; branches: BranchDetail[] };

/** Checkout dirty-worktree state: need to choose stash/force/cancel */
interface DirtyCheckoutState {
	branchName: string;
	isRemote: boolean;
}

/** Create-branch form state */
interface CreateBranchState {
	name: string;
	checkout: boolean;
	startPoint: string | null;
}

export const BranchesTab: Component<BranchesTabProps> = (props) => {
	const [branches, setBranches] = createSignal<BranchDetail[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [recentNames, setRecentNames] = createSignal<string[]>([], { equals: sameNames });
	/** Short hash of a detached HEAD (no local branch is current), for the context strip. */
	const [detachedAt, setDetachedAt] = createSignal<string | null>(null);
	const [search, setSearch] = createSignal("");
	const [recentExpanded, setRecentExpanded] = createSignal(true);
	const [localExpanded, setLocalExpanded] = createSignal(true);
	const [remoteExpanded, setRemoteExpanded] = createSignal(true);

	// Prefix folding: group branches by prefix (e.g. "feature/") when enabled
	const [foldingEnabled, setFoldingEnabled] = createSignal(true);
	// Set of group keys that are collapsed. Key format: "local:<prefix>" or "remote:<prefix>"
	const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set());
	const [optionsOpen, setOptionsOpen] = createSignal(false);

	// Context menu state: the branch and the row it was opened on
	const ctxMenu = createContextMenu();
	const [ctxTarget, setCtxTarget] = createSignal<{ branch: BranchDetail; key: string } | null>(null);

	// Keyboard / click selection: the key of one row (see rowKey), or null. Starts at
	// null, so no row can match it by accident (bug: index -1 matched every row the
	// filter had hidden from the flat list).
	const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
	/** The selection was last moved by the keyboard. Only then does it draw its focus
	 *  ring: a click or a right-click marks the row without one (as in Changes, Log
	 *  and Stashes). */
	const [keyboardNav, setKeyboardNav] = createSignal(false);

	// Rename inline state: the row being renamed and the branch's current name
	const [renaming, setRenaming] = createSignal<{ key: string; name: string } | null>(null);
	const [renameValue, setRenameValue] = createSignal("");

	// Create-branch inline form
	const [creating, setCreating] = createSignal(false);
	const [createState, setCreateState] = createSignal<CreateBranchState>({ name: "", checkout: true, startPoint: null });
	const [createBaseRefs, setCreateBaseRefs] = createSignal<BaseRefOption[]>([]);

	// Dirty-worktree checkout dialog
	const [dirtyCheckout, setDirtyCheckout] = createSignal<DirtyCheckoutState | null>(null);

	// Generic confirm dialog state
	const [dialog, setDialog] = createSignal<DialogKind | null>(null);

	// Container ref for focus management
	let containerRef: HTMLDivElement | undefined;
	let searchInputRef: HTMLInputElement | undefined;
	let renameInputRef: HTMLInputElement | undefined;
	let createInputRef: HTMLInputElement | undefined;
	/** Rendered rows by key, so keyboard selection can scroll its row into view. */
	const rowEls = new Map<string, HTMLElement>();

	/** `git rev-parse --short HEAD`, for a detached HEAD; null when git can't say. */
	async function readHeadHash(repoPath: string): Promise<string | null> {
		try {
			const res = await invoke<GitCommandResult>("run_git_command", {
				path: repoPath,
				args: ["rev-parse", "--short", "HEAD"],
			});
			return res.success ? res.stdout.trim() || null : null;
		} catch {
			return null;
		}
	}

	async function fetchBranches(repoPath: string) {
		if (branches().length === 0) setLoading(true);
		setLoadError(null);
		try {
			const [result, recent] = await Promise.all([
				invoke<BranchDetail[]>("get_branches_detail", { path: repoPath }),
				invoke<string[]>("get_recent_branches", { path: repoPath, limit: 5 }).catch((err) => {
					appLogger.warn("git", "Failed to load recent branches", err);
					return [] as string[];
				}),
			]);
			// No local branch is current: HEAD is detached. Name its commit in the
			// strip — read before anything renders, so "Detached HEAD" never flashes.
			const detached = result.length > 0 && !result.some((b) => b.is_current && !b.is_remote);
			const head = detached ? await readHeadHash(repoPath) : null;
			// A reply for a repo the tab has since left must not overwrite the new one.
			if (props.repoPath !== repoPath) return;
			// Early-bail: skip setBranches when a revision bump produced an identical
			// list (e.g. staging a file bumps the repo revision but the branches are
			// unchanged) so Solid doesn't re-reconcile identical rows.
			if (!branchListsEqual(branches(), result)) setBranches(result);
			setRecentNames(recent);
			setDetachedAt(head);
		} catch (err) {
			if (props.repoPath !== repoPath) return;
			appLogger.error("git", "Failed to load branches", err);
			setBranches([]);
			setRecentNames([]);
			setDetachedAt(null);
			setLoadError(String(err));
		} finally {
			// A stale reply leaves the loading state to the fetch that replaced it.
			if (props.repoPath === repoPath) setLoading(false);
		}
	}

	// Re-fetch when repo changes or revision bumps
	createEffect(
		on(
			() => {
				const repoPath = props.repoPath;
				const rev = repoPath ? repositoriesStore.getRevision(repoPath) : 0;
				return `${repoPath ?? ""}:${rev}`;
			},
			() => {
				const repoPath = props.repoPath;
				if (repoPath) void fetchBranches(repoPath);
				else {
					setBranches([]);
					setLoading(false);
					setLoadError(null);
					setDetachedAt(null);
				}
			},
		),
	);

	// Reset selection only when the active repo changes
	createEffect(
		on(
			() => props.repoPath,
			() => {
				setSelectedKey(null);
				setRenaming(null);
				setCreating(false);
				setOptionsOpen(false);
			},
		),
	);

	const query = createMemo(() => search().trim().toLowerCase());
	const matchesQuery = (b: BranchDetail) => {
		const q = query();
		return q === "" || b.name.toLowerCase().includes(q);
	};
	/** A section's count: the total, or "shown/total" while the filter is on. */
	const countLabel = (shown: number, total: number) => (query() ? `${shown}/${total}` : total);

	const localBranches = createMemo(() => branches().filter((b) => !b.is_remote));
	const remoteBranches = createMemo(() => branches().filter((b) => b.is_remote));
	const currentBranch = createMemo(() => localBranches().find((b) => b.is_current));

	/** Local branches merged into main and safe to delete (not current, not main). */
	const mergedBranches = createMemo(() => localBranches().filter((b) => b.is_merged && !b.is_current && !b.is_main));

	/** Recently checked-out local branches, newest first — without the current one,
	 *  which the context strip already shows. */
	const recentBranches = createMemo(() => {
		const names = recentNames();
		if (names.length === 0) return [];
		const byName = new Map(localBranches().map((b) => [b.name, b]));
		return names.map((name) => byName.get(name)).filter((b): b is BranchDetail => b !== undefined && !b.is_current);
	});

	// The filter applies to every section; a section with no match hides.
	const filteredRecent = createMemo(() => recentBranches().filter(matchesQuery));
	const filteredLocal = createMemo(() => localBranches().filter(matchesQuery));
	const filteredRemote = createMemo(() => remoteBranches().filter(matchesQuery));

	const layoutOf = (list: BranchDetail[]): SectionLayout =>
		foldingEnabled() ? groupBranchesByPrefix(list) : { ungrouped: list, groups: [] };
	const localLayout = createMemo(() => layoutOf(filteredLocal()));
	const remoteLayout = createMemo(() => layoutOf(filteredRemote()));

	/** Branches are loaded and listable: the strip, the toolbar and the form show. */
	const hasBranches = () => !loading() && !loadError() && branches().length > 0;

	const showRecent = () => filteredRecent().length > 0;
	const showLocal = () => (query() ? filteredLocal().length > 0 : localBranches().length > 0);
	const showRemote = () => filteredRemote().length > 0;
	const noMatches = () => query() !== "" && !showRecent() && !showLocal() && !showRemote();

	const isGroupOpen = (section: Section, prefix: string) => !collapsedGroups().has(`${section}:${prefix}`);

	/** Every row the list shows, in display order: what ↑ / ↓ walk through. Built from
	 *  the same layouts the list renders, so the keyboard order is the visual order
	 *  and rows in collapsed sections or groups are skipped. */
	const visibleRows = createMemo((): string[] => {
		const keys: string[] = [];
		const addLayout = (section: Section, layout: SectionLayout) => {
			for (const b of layout.ungrouped) keys.push(rowKey(section, b));
			for (const g of layout.groups) {
				if (!isGroupOpen(section, g.prefix)) continue;
				for (const b of g.branches) keys.push(rowKey(section, b));
			}
		};
		if (showRecent() && recentExpanded()) for (const b of filteredRecent()) keys.push(rowKey("recent", b));
		if (showLocal() && localExpanded()) addLayout("local", localLayout());
		if (showRemote() && remoteExpanded()) addLayout("remote", remoteLayout());
		return keys;
	});

	function registerRow(key: string, el: HTMLElement) {
		rowEls.set(key, el);
		onCleanup(() => {
			if (rowEls.get(key) === el) rowEls.delete(key);
		});
	}

	/** Select a row from the keyboard and keep it in view. */
	function selectRow(key: string) {
		setSelectedKey(key);
		setKeyboardNav(true);
		rowEls.get(key)?.scrollIntoView?.({ block: "nearest" });
	}

	/** Select a row with the pointer: marked, but no keyboard ring. */
	function pickRow(key: string) {
		setSelectedKey(key);
		setKeyboardNav(false);
	}

	// --- Checkout ---

	async function doCheckout(branch: BranchDetail, stash = false, force = false) {
		if (!props.repoPath) return;
		try {
			if (branch.is_remote) {
				const localName = branch.name.replace(/^origin\//, "");
				await invoke("checkout_remote_branch", { repoPath: props.repoPath, branchName: localName });
			} else {
				await invoke("switch_branch", {
					repoPath: props.repoPath,
					branchName: branch.name,
					force,
					stash,
				});
			}
			repositoriesStore.bumpGitRevision(props.repoPath);
			appLogger.info("git", `Switched to branch: ${branch.name}`);
		} catch (err) {
			const errStr = typeof err === "string" ? err : String(err);
			if (!force && !stash && errStr.toLowerCase().includes("dirty")) {
				setDirtyCheckout({ branchName: branch.name, isRemote: branch.is_remote });
			} else {
				appLogger.error("git", `Failed to switch to ${branch.name}`, err);
			}
		}
	}

	async function handleCheckout(branch: BranchDetail) {
		if (!props.repoPath) return;
		if (branch.is_current) return;
		await doCheckout(branch);
	}

	async function handleDirtyCheckoutStash() {
		const state = dirtyCheckout();
		if (!state || !props.repoPath) return;
		setDirtyCheckout(null);
		const branch = branches().find((b) => b.name === state.branchName);
		if (!branch) return;
		await doCheckout(branch, true, false);
	}

	async function handleDirtyCheckoutForce() {
		const state = dirtyCheckout();
		if (!state || !props.repoPath) return;
		setDirtyCheckout(null);
		const branch = branches().find((b) => b.name === state.branchName);
		if (!branch) return;
		await doCheckout(branch, false, true);
	}

	// --- Create Branch ---

	function startCreate() {
		// Already open: put the caret back in the name instead of wiping it.
		if (creating()) {
			createInputRef?.focus();
			return;
		}
		setCreating(true);
		setCreateState({ name: "", checkout: true, startPoint: null });
		// Fetch base ref options for the "from" dropdown
		if (props.repoPath) {
			invoke<BaseRefOption[]>("list_base_ref_options", { repoPath: props.repoPath })
				.then(setCreateBaseRefs)
				.catch(() => setCreateBaseRefs([]));
		}
		// Focus input on next tick
		requestAnimationFrame(() => createInputRef?.focus());
	}

	async function doCreateBranch() {
		if (!props.repoPath) return;
		const state = createState();
		const name = state.name.trim();
		if (!name) {
			setCreating(false);
			containerRef?.focus();
			return;
		}
		try {
			await invoke("create_branch", {
				path: props.repoPath,
				name,
				startPoint: state.startPoint,
				checkout: state.checkout,
			});
			// Only close the form once the branch actually exists — on failure the
			// form stays open so the user can correct the name and retry.
			setCreating(false);
			containerRef?.focus();
			repositoriesStore.bumpGitRevision(props.repoPath);
			appLogger.info("git", `Created branch: ${name}`);
		} catch (err) {
			appLogger.error("git", `Failed to create branch ${name}`, err);
			toastsStore.add("Create branch failed", `Could not create "${name}": ${String(err)}`, "error", true);
		}
	}

	function cancelCreate() {
		setCreating(false);
		setCreateState({ name: "", checkout: true, startPoint: null });
		setCreateBaseRefs([]);
		containerRef?.focus();
	}

	/** Enter in the name creates; Esc anywhere in the form cancels. */
	function handleCreateKeyDown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			cancelCreate();
			return;
		}
		if (e.key === "Enter" && e.target === createInputRef) {
			e.preventDefault();
			void doCreateBranch();
		}
	}

	// --- Delete Branch ---

	function startDelete(branch: BranchDetail) {
		if (!props.repoPath) return;
		if (branch.is_current) {
			appLogger.warn("git", "Cannot delete the currently checked-out branch");
			return;
		}
		if (branch.is_main) {
			appLogger.warn("git", "Cannot delete the main branch");
			return;
		}
		setDialog({ type: "delete", branch });
	}

	/** Delete a local branch by name. Returns true on success. force=false → `git
	 *  branch -d` (refuses unmerged); force=true → `-D`. Toasts on failure. */
	async function deleteBranchByName(name: string, force: boolean): Promise<boolean> {
		if (!props.repoPath) return false;
		try {
			await invoke("delete_branch", { path: props.repoPath, name, force });
			repositoriesStore.bumpGitRevision(props.repoPath);
			return true;
		} catch (err) {
			appLogger.error("git", `Failed to delete branch ${name}`, err);
			toastsStore.add("Delete failed", `Could not delete "${name}": ${String(err)}`, "error", true);
			return false;
		}
	}

	async function doDeleteBranch(force: boolean) {
		const d = dialog();
		if (d?.type !== "delete" || !props.repoPath) return;
		const { branch } = d;
		setDialog(null);
		if (await deleteBranchByName(branch.name, force)) {
			appLogger.info("git", `Deleted branch: ${branch.name}`);
			toastsStore.add("Branch deleted", `Removed "${branch.name}"`, "info");
			setSelectedKey(null);
		}
	}

	function startDeleteMerged() {
		const merged = mergedBranches();
		if (merged.length === 0) return;
		setDialog({ type: "deleteMerged", branches: merged });
	}

	async function doDeleteMerged() {
		const d = dialog();
		if (d?.type !== "deleteMerged") return;
		const targets = d.branches;
		setDialog(null);
		let deleted = 0;
		for (const branch of targets) {
			// -d (safe): refuses any branch that isn't actually merged, so a stale
			// is_merged flag can never cause data loss.
			if (await deleteBranchByName(branch.name, false)) deleted++;
		}
		setSelectedKey(null);
		appLogger.info("git", `Deleted ${deleted}/${targets.length} merged branches`);
		if (deleted > 0) {
			toastsStore.add(
				"Merged branches deleted",
				`Removed ${deleted} merged branch${deleted === 1 ? "" : "es"}`,
				"info",
			);
		}
		if (deleted < targets.length) {
			toastsStore.add(
				"Some branches kept",
				`${targets.length - deleted} could not be deleted (not fully merged?)`,
				"warn",
				true,
			);
		}
	}

	// --- Rename Branch ---

	function startRename(branch: BranchDetail, key: string) {
		setRenaming({ key, name: branch.name });
		setRenameValue(branch.name);
		requestAnimationFrame(() => renameInputRef?.select());
	}

	async function doRenameBranch() {
		if (!props.repoPath) return;
		const oldName = renaming()?.name;
		if (!oldName) return;
		const newName = renameValue().trim();
		setRenaming(null);
		containerRef?.focus();
		if (!newName || newName === oldName) return;
		try {
			await invoke("rename_branch", { path: props.repoPath, oldName, newName });
			repositoriesStore.bumpGitRevision(props.repoPath);
			appLogger.info("git", `Renamed branch ${oldName} to ${newName}`);
		} catch (err) {
			appLogger.error("git", `Failed to rename branch ${oldName}`, err);
		}
	}

	function cancelRename() {
		setRenaming(null);
		setRenameValue("");
		containerRef?.focus();
	}

	function handleRenameKeyDown(e: KeyboardEvent) {
		if (e.key === "Enter") {
			e.preventDefault();
			void doRenameBranch();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelRename();
		}
	}

	// --- Merge ---

	function startMerge(branch: BranchDetail) {
		if (!props.repoPath) return;
		const cur = currentBranch();
		if (!cur) return;
		if (branch.is_current) {
			appLogger.warn("git", "Cannot merge the current branch into itself");
			return;
		}
		setDialog({ type: "merge", branch, currentBranch: cur.name });
	}

	async function doMerge() {
		const d = dialog();
		if (d?.type !== "merge" || !props.repoPath) return;
		const { branch } = d;
		const target = currentBranch()?.name ?? "current";
		setDialog(null);

		let res: GitCommandResult;
		try {
			res = await invoke<GitCommandResult>("run_git_command", { path: props.repoPath, args: ["merge", branch.name] });
		} catch (err) {
			appLogger.error("git", `Merge of ${branch.name} failed`, err);
			toastsStore.add("Merge failed", `Could not run merge for "${branch.name}"`, "error", true);
			return;
		}
		repositoriesStore.bumpGitRevision(props.repoPath);

		// run_git_command never throws on git failure — inspect success explicitly.
		if (!res.success) {
			const detail = (res.stderr || res.stdout).trim();
			appLogger.error("git", `Merge of ${branch.name} failed`, detail);
			toastsStore.add("Merge failed", detail || `"${branch.name}" could not be merged (conflict?)`, "error", true);
			return;
		}

		if (isAlreadyUpToDate(res.stdout)) {
			appLogger.info("git", `${branch.name} already merged into ${target}`);
			toastsStore.add("Already up to date", `"${branch.name}" is already merged into "${target}".`, "info");
			return;
		}

		appLogger.info("git", `Merged ${branch.name} into ${target}`);
		// Offer one-click cleanup of the now-merged branch (auto-delete after local
		// merge). Never for main/current — delete_branch refuses those anyway.
		const canDelete = !branch.is_main && !branch.is_current;
		toastsStore.add(
			"Merged",
			`"${branch.name}" → "${target}"`,
			"info",
			false,
			canDelete
				? {
						label: `Delete "${branch.name}"`,
						onClick: () => {
							void deleteBranchByName(branch.name, false).then((ok) => {
								if (ok) toastsStore.add("Branch deleted", `Removed merged branch "${branch.name}"`, "info");
							});
						},
					}
				: undefined,
		);
	}

	// --- Rebase ---

	function startRebase(branch: BranchDetail) {
		if (!props.repoPath) return;
		const cur = currentBranch();
		if (!cur) return;
		if (branch.is_current) {
			appLogger.warn("git", "Cannot rebase current branch onto itself");
			return;
		}
		setDialog({ type: "rebase", branch, currentBranch: cur.name });
	}

	async function doRebase() {
		const d = dialog();
		if (d?.type !== "rebase" || !props.repoPath) return;
		const { branch } = d;
		setDialog(null);
		await runGitAction(["rebase", branch.name], "Rebase failed", `Could not rebase onto "${branch.name}"`, () =>
			appLogger.info("git", `Rebased current branch onto ${branch.name}`),
		);
	}

	// --- Push / Pull / Fetch ---

	/**
	 * Run a git subcommand via `run_git_command`, bump the repo revision, and
	 * surface failures via toast. `run_git_command` never throws on git failure —
	 * it returns success=false with stderr — so we inspect the result explicitly
	 * (mirrors doMerge). Both the invoke throwing (backend/IPC error) and a
	 * git non-zero exit surface a toast. `onSuccess` runs only on success.
	 */
	async function runGitAction(
		args: string[],
		failTitle: string,
		failMessage: string,
		onSuccess?: () => void,
	): Promise<void> {
		if (!props.repoPath) return;
		let res: GitCommandResult;
		try {
			res = await invoke<GitCommandResult>("run_git_command", { path: props.repoPath, args });
		} catch (err) {
			appLogger.error("git", `${failTitle}: ${String(err)}`, err);
			toastsStore.add(failTitle, failMessage, "error", true);
			return;
		}
		repositoriesStore.bumpGitRevision(props.repoPath);
		if (!res.success) {
			const detail = (res.stderr || res.stdout).trim();
			appLogger.error("git", `${failTitle}: ${detail}`);
			toastsStore.add(failTitle, detail || failMessage, "error", true);
			return;
		}
		onSuccess?.();
	}

	async function doPush(branch: BranchDetail) {
		const args = branch.upstream ? ["push"] : ["push", "-u", "origin", branch.name];
		await runGitAction(args, "Push failed", `Could not push "${branch.name}"`, () =>
			appLogger.info("git", `Pushed ${branch.name}`),
		);
	}

	async function doPull(branch: BranchDetail) {
		if (!props.repoPath) return;
		if (!branch.is_current) {
			appLogger.warn("git", "Pull only works for the currently checked-out branch");
			return;
		}
		await runGitAction(["pull"], "Pull failed", `Could not pull "${branch.name}"`, () =>
			appLogger.info("git", `Pulled ${branch.name}`),
		);
	}

	async function openBranchOnGitHub(branch: BranchDetail) {
		if (!props.repoPath) return;
		try {
			const remoteUrl = await invoke<string | null>("get_remote_url", { path: props.repoPath });
			if (!remoteUrl) return;
			const ghBase = remoteUrlToGitHub(remoteUrl);
			if (!ghBase) return;
			// Strip remote prefix: "origin/feature-branch" → "feature-branch"
			const branchName = branch.name.replace(/^[^/]+\//, "");
			handleOpenUrl(`${ghBase}/tree/${encodeURIComponent(branchName)}`);
		} catch (err) {
			appLogger.error("git", "Failed to open branch on GitHub", err);
		}
	}

	async function doFetch(branch: BranchDetail) {
		await runGitAction(["fetch", "origin", branch.name], "Fetch failed", `Could not fetch "${branch.name}"`, () =>
			appLogger.info("git", `Fetched ${branch.name}`),
		);
	}

	// --- Compare branches ---

	/** Compare selected branch against the current branch; logs file-level diff summary */
	async function doCompare(branch: BranchDetail) {
		if (!props.repoPath) return;
		const cur = currentBranch();
		if (!cur) {
			appLogger.warn("git", "No current branch to compare against");
			return;
		}
		try {
			const result = await invoke<{ success: boolean; stdout: string; stderr: string }>("run_git_command", {
				path: props.repoPath,
				args: ["diff", "--name-status", `${cur.name}...${branch.name}`],
			});
			if (result.success) {
				const lines = result.stdout.trim().split("\n").filter(Boolean);
				if (lines.length === 0) {
					appLogger.info("git", `Compare ${cur.name}...${branch.name}: no differences`);
				} else {
					appLogger.info("git", `Compare ${cur.name}...${branch.name}: ${lines.length} file(s) differ`, {
						files: lines,
					});
				}
			} else {
				appLogger.warn("git", `Compare failed: ${result.stderr.trim().split("\n")[0]}`);
			}
		} catch (err) {
			appLogger.error("git", `Compare failed for ${branch.name}`, err);
		}
	}

	// --- Prefix group toggle ---

	function toggleGroup(key: string) {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}

	// --- Update from base ---

	async function doUpdateFromBase(branch: BranchDetail) {
		if (!props.repoPath) return;
		try {
			const result = await invoke<string>("update_from_base", {
				path: props.repoPath,
				branchName: branch.name,
				strategy: "rebase",
			});
			appLogger.info("git", result);
			repositoriesStore.bumpGitRevision(props.repoPath);
		} catch (err) {
			appLogger.error("git", `Update from base failed for ${branch.name}`, err);
		}
	}

	// --- Context menu ---

	function openContextMenu(e: MouseEvent, branch: BranchDetail, key: string) {
		setCtxTarget({ branch, key });
		// The row the menu acts on stays marked while the menu is open.
		pickRow(key);
		ctxMenu.open(e);
	}

	function buildContextMenuItems(target: { branch: BranchDetail; key: string }): ContextMenuItem[] {
		const { branch, key } = target;
		const cur = currentBranch();
		const isCurrent = branch.is_current;
		const sep: ContextMenuItem = { separator: true, label: "", action: () => undefined };

		const copyName: ContextMenuItem = {
			label: "Copy name",
			action: () => void writeClipboard(branch.name),
		};

		if (branch.is_remote) {
			return [
				{ label: "Checkout (create local)", shortcut: "\u23CE", action: () => void handleCheckout(branch) },
				sep,
				{ label: "Fetch", shortcut: "f", action: () => void doFetch(branch) },
				{ label: "Compare with current", action: () => void doCompare(branch), disabled: !cur },
				sep,
				{ label: "Open on GitHub", action: () => void openBranchOnGitHub(branch) },
				copyName,
			];
		}

		if (isCurrent) {
			return [
				{ label: "Push", shortcut: "\u21E7P", action: () => void doPush(branch) },
				{ label: "Pull", shortcut: "p", action: () => void doPull(branch) },
				{ label: "Fetch", shortcut: "f", action: () => void doFetch(branch) },
				{ label: "Update from base (rebase)", action: () => void doUpdateFromBase(branch) },
				sep,
				{ label: "Rename", shortcut: "\u21E7R", action: () => startRename(branch, key) },
				sep,
				copyName,
			];
		}

		const items: ContextMenuItem[] = [
			{ label: "Checkout", shortcut: "\u23CE", action: () => void handleCheckout(branch) },
			{ label: "Merge into current", shortcut: "\u21E7M", action: () => startMerge(branch), disabled: !cur },
			{ label: "Rebase onto", shortcut: "r", action: () => startRebase(branch), disabled: !cur },
			{ label: "Compare with current", action: () => void doCompare(branch), disabled: !cur },
			sep,
			{ label: "Push", shortcut: "\u21E7P", action: () => void doPush(branch) },
			{ label: "Pull", shortcut: "p", action: () => void doPull(branch) },
			{ label: "Fetch", shortcut: "f", action: () => void doFetch(branch) },
			{ label: "Update from base (rebase)", action: () => void doUpdateFromBase(branch) },
		];

		if (!branch.is_main) {
			items.push(sep);
			items.push({ label: "Rename", shortcut: "\u21E7R", action: () => startRename(branch, key) });
			items.push({ label: "Delete", shortcut: "d", action: () => startDelete(branch) });
		}

		items.push(sep);
		items.push(copyName);

		return items;
	}

	// --- Branch options menu ---

	function optionItems(): DropdownItem[] {
		const merged = mergedBranches().length;
		return [
			{
				id: "group",
				label: "Group by prefix",
				icon: <span class={s.menuMark}>{foldingEnabled() ? <IconCheck size={14} /> : null}</span>,
			},
			{ id: "divider", label: "", divider: true },
			{
				id: "delete-merged",
				label: merged > 0 ? `Delete ${merged} merged branch${merged === 1 ? "" : "es"}…` : "Delete merged branches…",
				disabled: merged === 0,
				icon: <span class={s.menuMark} />,
			},
		];
	}

	function handleOption(id: string) {
		setOptionsOpen(false);
		if (id === "group") setFoldingEnabled((v) => !v);
		else if (id === "delete-merged") startDeleteMerged();
	}

	// --- Keyboard navigation ---

	function handleKeyDown(e: KeyboardEvent) {
		// The filter, the create form and the rename field handle their own keys; a
		// key one of them already acted on (Esc that cancelled the form) stops here.
		if (e.defaultPrevented || isTextEntry(e.target)) return;

		if (e.key === "Escape" && optionsOpen()) {
			e.preventDefault();
			setOptionsOpen(false);
			return;
		}

		const rows = visibleRows();
		const idx = rows.indexOf(selectedKey() ?? "");

		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (rows.length === 0) return;
			selectRow(rows[idx < rows.length - 1 ? idx + 1 : 0]);
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (rows.length === 0) return;
			selectRow(rows[idx <= 0 ? rows.length - 1 : idx - 1]);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			if (search()) {
				setSearch("");
				return;
			}
			setSelectedKey(null);
			return;
		}
		if (e.key === "/") {
			e.preventDefault();
			searchInputRef?.focus();
			return;
		}
		// Branch actions are mouse-first (context menu / New button).
		// Only arrow nav + "/" + Escape are handled here — no letter-key shortcuts.
	}

	/** The filter's own keys: ↓ hands over to the list, Esc on an empty field leaves it.
	 *  (Esc on a non-empty field clears it — SearchField does that itself.) */
	function handleSearchKeyDown(e: KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			const first = visibleRows()[0];
			if (first) selectRow(first);
			containerRef?.focus();
			return;
		}
		if (e.key === "Escape" && search() === "") {
			e.preventDefault();
			containerRef?.focus();
		}
	}

	// Focus container ONCE when branches first load so keyboard nav works
	// immediately. Must NOT re-run on every refresh: this effect tracks
	// loading()/branches(), which change on each repo-changed reload — without
	// the guard it would steal focus back from the terminal on every refresh,
	// hijacking keystrokes (n/d/r/p…) and paste while the panel is open.
	let didAutoFocus = false;
	createEffect(() => {
		if (didAutoFocus) return;
		if (!loading() && branches().length > 0) {
			didAutoFocus = true;
			containerRef?.focus();
		}
	});

	// --- Dialog helpers ---

	const dialogData = createMemo(() => {
		const d = dialog();
		if (!d) return null;
		if (d.type === "delete") {
			const { branch } = d;
			const info = branch.is_merged
				? "This branch is merged into main."
				: "This branch has unmerged commits. Delete refuses to remove it; Force delete discards them.";
			return {
				title: `Delete branch “${branch.name}”?`,
				message: info,
				branch,
			};
		}
		if (d.type === "merge") {
			const { branch, currentBranch: cur } = d;
			return {
				title: `Merge into ${cur}`,
				message: `Merge “${branch.name}” into “${cur}”?`,
				branch,
			};
		}
		if (d.type === "rebase") {
			const { branch, currentBranch: cur } = d;
			return {
				title: `Rebase ${cur}`,
				message: `Rebase the current branch “${cur}” onto “${branch.name}”?`,
				branch,
			};
		}
		if (d.type === "deleteMerged") {
			const names = d.branches.map((b) => b.name);
			const preview = names.slice(0, 8).join(", ");
			const more = names.length > 8 ? `, +${names.length - 8} more` : "";
			return {
				title: `Delete ${names.length} merged branch${names.length === 1 ? "" : "es"}?`,
				message: `These branches are merged into main and will be removed (git branch -d): ${preview}${more}`,
				branch: d.branches[0],
			};
		}
		return null;
	});

	// --- Render helpers ---

	/** The current branch (or a detached HEAD), its upstream and sync state, and Create PR. */
	const renderContext = () => (
		<div class={s.context}>
			<Show
				when={currentBranch()}
				fallback={
					<>
						<span class={s.contextIcon}>
							<IconCommit size={14} />
						</span>
						<span class={s.contextLabel}>
							<span class={s.contextName}>
								<Show when={detachedAt()} fallback="Detached HEAD">
									{(hash) => (
										<>
											Detached at <span class={s.contextHash}>{hash()}</span>
										</>
									)}
								</Show>
							</span>
						</span>
					</>
				}
			>
				{(cur) => (
					<>
						<span class={s.contextIcon}>
							<IconBranch size={14} />
						</span>
						<span class={s.contextLabel}>
							<span class={s.contextName} title={cur().name}>
								{cur().name}
							</span>
							<Show when={cur().upstream}>
								{(upstream) => (
									<span class={s.contextUpstream} title={`Tracking ${upstream()}`}>
										{`\u2002\u2192 ${upstream()}`}
									</span>
								)}
							</Show>
							<Show when={(cur().ahead ?? 0) > 0 || (cur().behind ?? 0) > 0}>
								<span class={s.contextSync}>
									<Show when={(cur().ahead ?? 0) > 0}>
										<span class={s.ahead} title={`${cur().ahead} ahead of ${cur().upstream ?? "upstream"}`}>
											&#x2191;{cur().ahead}
										</span>
									</Show>
									<Show when={(cur().behind ?? 0) > 0}>
										<span class={s.behind} title={`${cur().behind} behind ${cur().upstream ?? "upstream"}`}>
											&#x2193;{cur().behind}
										</span>
									</Show>
								</span>
							</Show>
						</span>
					</>
				)}
			</Show>
			<span class={s.contextAction}>
				<SmartButtonStrip
					appearance="chip"
					placement="git-branches"
					repoPath={props.repoPath ?? ""}
					defaultPromptId="smart-create-pr"
					onError={(msg) => {
						if (msg) toastsStore.add("Couldn't run the prompt", msg, "error");
					}}
				/>
			</span>
		</div>
	);

	/** The filter, New branch and the options menu. */
	const renderToolbar = () => (
		<div class={s.toolbar}>
			<SearchField
				value={search()}
				onInput={(value) => setSearch(value)}
				placeholder="Filter branches"
				title="Filter branches (press / from the list)"
				ref={(el) => {
					searchInputRef = el;
				}}
				class={s.filterField}
				onKeyDown={handleSearchKeyDown}
				data-focus-target="git-branches-search"
				data-repo-path={props.repoPath ?? ""}
			/>
			<button
				type="button"
				class={cx(s.iconBtn, creating() && s.iconBtnOn)}
				title="New branch"
				aria-label="New branch"
				aria-expanded={creating()}
				onClick={startCreate}
			>
				<IconPlus size={16} />
			</button>
			<span class={s.optionsAnchor}>
				<button
					type="button"
					class={cx(s.iconBtn, optionsOpen() && s.iconBtnOn)}
					title="Branch options"
					aria-label="Branch options"
					aria-haspopup="menu"
					aria-expanded={optionsOpen()}
					onClick={() => setOptionsOpen((v) => !v)}
				>
					<IconMore size={16} />
				</button>
				<Dropdown
					items={optionItems()}
					visible={optionsOpen()}
					onSelect={handleOption}
					onClose={() => setOptionsOpen(false)}
				/>
			</span>
		</div>
	);

	/** New branch: the name on its own line (bug: the start-point select squeezed it to
	 *  ~16px), then where it starts, whether to switch to it, Cancel and Create. */
	const renderCreateForm = () => {
		const refsOf = (kind: string) => createBaseRefs().filter((r) => r.kind === kind);
		const name = () => createState().name.trim();
		return (
			<div class={s.createForm} onKeyDown={handleCreateKeyDown}>
				<input
					ref={createInputRef}
					class={s.inlineInput}
					placeholder="New branch name"
					aria-label="New branch name"
					value={createState().name}
					onInput={(e) => setCreateState((p) => ({ ...p, name: e.currentTarget.value }))}
					autocomplete="off"
					autocorrect="off"
					spellcheck={false}
				/>
				<div class={s.createRow}>
					<label class={s.baseChip} title="Start point">
						<span class={s.createFrom}>from</span>
						<span class={s.baseLabel}>{createState().startPoint ?? "HEAD"}</span>
						<IconChevronDown size={14} class={s.baseChevron} />
						<select
							class={s.baseSelect}
							aria-label="Start point"
							value={createState().startPoint ?? ""}
							onChange={(e) => setCreateState((p) => ({ ...p, startPoint: e.currentTarget.value || null }))}
						>
							<option value="">HEAD</option>
							<Show when={refsOf("local").length > 0}>
								<optgroup label="Local">
									<For each={refsOf("local")}>
										{(ref) => (
											<option value={ref.name}>
												{ref.name}
												{ref.is_default ? " (default)" : ""}
											</option>
										)}
									</For>
								</optgroup>
							</Show>
							<Show when={refsOf("remote").length > 0}>
								<optgroup label="Remote">
									<For each={refsOf("remote")}>{(ref) => <option value={ref.name}>{ref.name}</option>}</For>
								</optgroup>
							</Show>
						</select>
					</label>
					<button
						type="button"
						class={cx(s.toggleChip, createState().checkout && s.toggleChipOn)}
						aria-pressed={createState().checkout}
						title={createState().checkout ? "Stay on the current branch" : "Switch to the new branch after creating it"}
						onClick={() => setCreateState((p) => ({ ...p, checkout: !p.checkout }))}
					>
						<Show when={createState().checkout}>
							<IconCheck size={14} />
						</Show>
						Check out
					</button>
					<span class={s.createActions}>
						<button type="button" class={s.textBtn} onClick={cancelCreate}>
							Cancel
						</button>
						<button
							type="button"
							class={s.primaryPill}
							aria-disabled={name() === "" || undefined}
							title={name() === "" ? "Type a name for the branch" : `Create ${name()}`}
							onClick={() => {
								if (name() !== "") void doCreateBranch();
							}}
						>
							Create
						</button>
					</span>
				</div>
			</div>
		);
	};

	function renderBranchRow(branch: BranchDetail, section: Section, prefix?: string) {
		const key = rowKey(section, branch);
		const isLocal = !branch.is_remote;
		const when = parseGitDate(branch.last_commit_date);
		// Inside a prefix group the prefix is the group's label; the row shows the rest.
		const label = prefix ? branch.name.slice(prefix.length) : branch.name;
		const isRenaming = () => renaming()?.key === key;
		// While renaming, the field is the row's state: no tint behind a bordered box.
		const isSelected = () => selectedKey() === key && !isRenaming();
		return (
			<div
				ref={(el) => registerRow(key, el)}
				class={cx(
					s.branchRow,
					prefix !== undefined && s.branchRowNested,
					isStale(when) && s.branchRowStale,
					isSelected() && s.branchRowSelected,
					isSelected() && keyboardNav() && s.branchRowFocused,
				)}
				title={branchTooltip(branch)}
				onClick={() => {
					pickRow(key);
					containerRef?.focus();
				}}
				onContextMenu={(e) => openContextMenu(e, branch, key)}
			>
				<span class={s.branchSlot}>
					<Show when={isLocal && branch.is_current}>
						<IconCheck size={14} />
					</Show>
				</span>
				<Show
					when={isLocal && isRenaming()}
					fallback={<span class={cx(s.branchName, isLocal && branch.is_current && s.branchNameCurrent)}>{label}</span>}
				>
					<input
						ref={renameInputRef}
						class={cx(s.inlineInput, s.renameInput)}
						aria-label={`Rename ${branch.name}`}
						value={renameValue()}
						onInput={(e) => setRenameValue(e.currentTarget.value)}
						onKeyDown={handleRenameKeyDown}
						onClick={(e) => e.stopPropagation()}
						onDblClick={(e) => e.stopPropagation()}
						autocomplete="off"
						autocorrect="off"
						spellcheck={false}
					/>
				</Show>
				<span class={s.branchMeta}>
					<Show when={isLocal && (branch.ahead ?? 0) > 0}>
						<span class={s.ahead} title={`${branch.ahead} ahead of ${branch.upstream ?? "upstream"}`}>
							&#x2191;{branch.ahead}
						</span>
					</Show>
					<Show when={isLocal && (branch.behind ?? 0) > 0}>
						<span class={s.behind} title={`${branch.behind} behind ${branch.upstream ?? "upstream"}`}>
							&#x2193;{branch.behind}
						</span>
					</Show>
					<Show when={isLocal && (branch.base_behind ?? 0) > 0}>
						<span class={s.baseBehind} title={`${branch.base_behind} behind ${branch.base_branch ?? "main"}`}>
							&#x21E3;{branch.base_behind}
						</span>
					</Show>
					<Show when={branch.is_merged}>
						<span class={s.merged}>Merged</span>
					</Show>
					<Show when={when !== null}>
						<span class={s.age}>{shortAge(when as number)}</span>
					</Show>
				</span>
			</div>
		);
	}

	/** A section's rows: branches without a prefix, then each prefix group. */
	function renderLayout(section: "local" | "remote", layout: () => SectionLayout) {
		return (
			<>
				<For each={layout().ungrouped}>{(b) => renderBranchRow(b, section)}</For>
				<For each={layout().groups.map((g) => g.prefix)}>
					{(prefix) => {
						const key = `${section}:${prefix}`;
						const group = () => layout().groups.find((g) => g.prefix === prefix);
						const open = () => isGroupOpen(section, prefix);
						return (
							<>
								{/* tabIndex 0: WebKit leaves a plain <button> out of the Tab order
								    unless "keyboard navigation" is on in macOS; the old headers
								    (tabIndex 0 divs) were reachable, so these stay reachable. */}
								<button
									type="button"
									class={s.groupHeader}
									tabIndex={0}
									aria-expanded={open()}
									onClick={() => toggleGroup(key)}
								>
									<span class={s.groupSlot}>
										<IconChevronRight size={14} class={cx(s.groupChevron, open() && s.groupChevronOpen)} />
									</span>
									<span class={s.groupPrefix}>{prefix}</span>
									<span class={s.groupCount}>{group()?.branches.length ?? 0}</span>
								</button>
								<Show when={open()}>
									<div class={s.groupChildren}>
										<For each={group()?.branches ?? []}>{(b) => renderBranchRow(b, section, prefix)}</For>
									</div>
								</Show>
							</>
						);
					}}
				</For>
			</>
		);
	}

	const renderList = () => (
		<Show
			when={!loadError()}
			fallback={
				<EmptyState
					tone="error"
					icon={IconAlert}
					title="Couldn't load branches"
					description={loadError() ?? ""}
					action={
						<button
							type="button"
							class={s.emptyAction}
							onClick={() => {
								if (props.repoPath) void fetchBranches(props.repoPath);
							}}
						>
							<IconRefresh size={14} />
							Retry
						</button>
					}
				/>
			}
		>
			<Show when={!loading()} fallback={<EmptyState loading title="Loading branches…" />}>
				<Show when={branches().length > 0} fallback={<EmptyState icon={IconBranch} title="No branches" />}>
					<Show
						when={!noMatches()}
						fallback={<EmptyState size="compact" title={`No branches match “${search().trim()}”`} />}
					>
						<Show when={showRecent()}>
							<div class={s.section} role="group" aria-label="Recent branches">
								<SectionHeader
									label="Recent"
									count={countLabel(filteredRecent().length, recentBranches().length)}
									open={recentExpanded()}
									onToggle={() => setRecentExpanded((v) => !v)}
								/>
								<Show when={recentExpanded()}>
									<For each={filteredRecent()}>{(b) => renderBranchRow(b, "recent")}</For>
								</Show>
							</div>
						</Show>
						<Show when={showLocal()}>
							<div class={s.section} role="group" aria-label="Local branches">
								<SectionHeader
									label="Local"
									count={countLabel(filteredLocal().length, localBranches().length)}
									open={localExpanded()}
									onToggle={() => setLocalExpanded((v) => !v)}
								/>
								<Show when={localExpanded()}>{renderLayout("local", localLayout)}</Show>
							</div>
						</Show>
						<Show when={showRemote()}>
							<div class={s.section} role="group" aria-label="Remote branches">
								<SectionHeader
									label="Remote"
									count={countLabel(filteredRemote().length, remoteBranches().length)}
									open={remoteExpanded()}
									onToggle={() => setRemoteExpanded((v) => !v)}
								/>
								<Show when={remoteExpanded()}>{renderLayout("remote", remoteLayout)}</Show>
							</div>
						</Show>
					</Show>
				</Show>
			</Show>
		</Show>
	);

	// Cleanup on unmount
	onCleanup(() => {
		setDialog(null);
		setDirtyCheckout(null);
	});

	return (
		<div ref={containerRef} class={s.container} tabIndex={-1} onKeyDown={handleKeyDown}>
			<Show
				when={props.repoPath}
				fallback={
					<EmptyState
						icon={IconGit}
						title="No repository"
						description="Open a repository in the sidebar to see its branches."
					/>
				}
			>
				{/* Nothing to act on while loading, after an error or in a repo with no
				    branches: the list's state fills the tab on its own. */}
				<Show when={hasBranches()}>
					{renderContext()}
					{renderToolbar()}
					<Show when={creating()}>{renderCreateForm()}</Show>
				</Show>
				<div class={s.list}>{renderList()}</div>
			</Show>

			{/* Uncommitted changes in the way of a checkout */}
			<ConfirmDialog
				visible={dirtyCheckout() !== null}
				title="Uncommitted changes"
				message={`The working tree has uncommitted changes. How do you want to switch to “${dirtyCheckout()?.branchName ?? ""}”?`}
				confirmLabel="Stash and switch"
				discardLabel="Force switch"
				kind="warning"
				onClose={() => setDirtyCheckout(null)}
				onDiscard={handleDirtyCheckoutForce}
				onConfirm={handleDirtyCheckoutStash}
			/>

			{/* Delete branch: Delete (-d, refuses unmerged), Force delete (-D) when unmerged */}
			<ConfirmDialog
				visible={dialog()?.type === "delete"}
				title={dialogData()?.title ?? ""}
				message={dialogData()?.message ?? ""}
				confirmLabel="Delete"
				discardLabel={dialogData()?.branch.is_merged ? undefined : "Force delete"}
				kind="warning"
				onClose={() => setDialog(null)}
				onDiscard={() => void doDeleteBranch(true)}
				onConfirm={() => void doDeleteBranch(false)}
			/>

			{/* Merge confirm dialog */}
			<ConfirmDialog
				visible={dialog()?.type === "merge"}
				title={dialogData()?.title ?? ""}
				message={dialogData()?.message ?? ""}
				confirmLabel="Merge"
				kind="warning"
				onClose={() => setDialog(null)}
				onConfirm={doMerge}
			/>

			{/* Rebase confirm dialog */}
			<ConfirmDialog
				visible={dialog()?.type === "rebase"}
				title={dialogData()?.title ?? ""}
				message={dialogData()?.message ?? ""}
				confirmLabel="Rebase"
				kind="warning"
				onClose={() => setDialog(null)}
				onConfirm={doRebase}
			/>

			{/* Delete merged branches confirm dialog */}
			<ConfirmDialog
				visible={dialog()?.type === "deleteMerged"}
				title={dialogData()?.title ?? ""}
				message={dialogData()?.message ?? ""}
				confirmLabel="Delete merged"
				kind="warning"
				onClose={() => setDialog(null)}
				onConfirm={doDeleteMerged}
			/>

			{/* Branch context menu */}
			<ContextMenu
				items={ctxTarget() ? buildContextMenuItems(ctxTarget()!) : []}
				x={ctxMenu.position().x}
				y={ctxMenu.position().y}
				visible={ctxMenu.visible()}
				onClose={ctxMenu.close}
			/>
		</div>
	);
};

export default BranchesTab;
