import { createVirtualizer } from "@tanstack/solid-virtual";
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
	untrack,
} from "solid-js";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { isDiffStatus } from "../../stores/diffTabs";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { writeClipboard } from "../../utils/clipboard";
import { fullTimestamp, relativeTime } from "../../utils/time";
import { FileIcon } from "../FileBrowserPanel/FileIcon";
import { IconAlert, IconCheck, IconCloud, IconCommit, IconCopy, IconGit, IconTag } from "../icons";
import { EmptyState } from "../shared/EmptyState";
import { Spinner } from "../shared/Spinner";
import { CommitGraph, type ExpandedRow, GRAPH_ROW_HEIGHT, type GraphNode, graphWidth } from "./CommitGraph";
import type { OpenDiffFn } from "./GitPanel";
import s from "./LogTab.module.css";
import type { ChangedFile, CommitLogEntry } from "./types";

/** Collapsed row: the subject line over the meta line (two-line row, 48px). */
const ROW_HEIGHT = GRAPH_ROW_HEIGHT;
/** Space above the first row and below the last; the graph starts at the same offset. */
const LIST_PAD_TOP = 3;
const LIST_PAD_BOTTOM = 8;
/** Commits per page. The next page loads by itself as the list nears its end. */
const PAGE_SIZE = 50;
/** How many rows before the end the next page starts loading. */
const LOAD_AHEAD_ROWS = 8;
/** Ref chips a collapsed row shows before folding the rest into "+N". */
const ROW_CHIP_LIMIT = 2;
/** How long the copy button shows its check. */
const COPIED_MS = 1200;

export interface LogTabProps {
	repoPath: string | null;
	onOpenDiff: OpenDiffFn;
}

// ---------------------------------------------------------------------------
// Ref chips — `git log %D` decorations folded into what a reader needs
// ---------------------------------------------------------------------------

export type RefChipKind = "head" | "branch" | "tag";

export interface RefChip {
	kind: RefChipKind;
	/** Display name: no `tag: `, no remote prefix. */
	name: string;
	/** "trailing": a local branch whose remote is on the same commit; "leading": a remote-only branch. */
	cloud: "none" | "leading" | "trailing";
	/** Tooltip naming every ref the chip stands for. */
	title: string;
}

/** Remote names recognised before any pairing is seen. */
const KNOWN_REMOTES = ["origin", "upstream"];

/** The branch a decoration names (`HEAD -> main` → main), or null for a tag or a detached HEAD. */
function decoratedBranch(ref: string): string | null {
	if (ref === "HEAD" || ref.startsWith("tag: ")) return null;
	return ref.startsWith("HEAD -> ") ? ref.slice(8) : ref;
}

/**
 * The remotes on a page of commits: origin, upstream, and any prefix seen
 * next to a branch of the same name on one commit (`fork/x` beside `x`).
 */
export function collectRemotes(refLists: readonly (readonly string[])[]): Set<string> {
	const remotes = new Set(KNOWN_REMOTES);
	for (const refs of refLists) {
		if (refs.length < 2) continue;
		const names = new Set<string>();
		for (const ref of refs) {
			const name = decoratedBranch(ref.trim());
			if (name) names.add(name);
		}
		for (const name of names) {
			const slash = name.indexOf("/");
			if (slash > 0 && names.has(name.slice(slash + 1))) remotes.add(name.slice(0, slash));
		}
	}
	return remotes;
}

/**
 * Fold one commit's decorations into chips: the current branch first, then
 * local branches (each with its remote folded in), remote-only branches, then
 * tags. `<remote>/HEAD` is dropped — it only names the default branch.
 */
export function foldRefs(refs: readonly string[], remotes: ReadonlySet<string>): RefChip[] {
	let head: string | null = null;
	let detached = false;
	const locals: string[] = [];
	const tags: string[] = [];
	/** branch name → the remote refs for it, in git's order */
	const remoteRefs = new Map<string, string[]>();

	for (const raw of refs) {
		const ref = raw.trim();
		if (!ref) continue;
		if (ref === "HEAD") {
			detached = true;
		} else if (ref.startsWith("HEAD -> ")) {
			head = ref.slice(8);
		} else if (ref.startsWith("tag: ")) {
			tags.push(ref.slice(5));
		} else {
			const slash = ref.indexOf("/");
			if (slash > 0 && remotes.has(ref.slice(0, slash))) {
				const name = ref.slice(slash + 1);
				if (name !== "HEAD") remoteRefs.set(name, [...(remoteRefs.get(name) ?? []), ref]);
			} else {
				locals.push(ref);
			}
		}
	}

	const chips: RefChip[] = [];
	const branchChip = (kind: "head" | "branch", name: string) => {
		const remote = remoteRefs.get(name) ?? [];
		remoteRefs.delete(name);
		const label = kind === "head" ? `HEAD → ${name}` : name;
		chips.push({ kind, name, cloud: remote.length > 0 ? "trailing" : "none", title: [label, ...remote].join(" · ") });
	};
	if (head) branchChip("head", head);
	else if (detached) chips.push({ kind: "head", name: "HEAD", cloud: "none", title: "HEAD (detached)" });
	for (const name of locals) branchChip("branch", name);
	for (const [name, full] of remoteRefs)
		chips.push({ kind: "branch", name, cloud: "leading", title: full.join(" · ") });
	for (const name of tags) chips.push({ kind: "tag", name, cloud: "none", title: `Tag ${name}` });
	return chips;
}

/** Chip geometry (LogTab.module.css .refBadge): 6px padding a side, 12px icons
 *  with a 4px gap, 4px between chips, 140px at most. */
const CHIP_PAD = 12;
const CHIP_ICON = 16;
const CHIP_GAP = 4;
const CHIP_MAX = 140;

/**
 * How many chips a collapsed row shows: as many whole chips as fit `available`
 * (at most `limit`), counting the "+N" chip that then follows them — so a tag
 * is never cut to "v2.…". The first chip always shows, cut only if it alone
 * is too wide.
 */
export function fitChips(
	widths: readonly number[],
	available: number,
	moreWidth: (hidden: number) => number,
	limit = ROW_CHIP_LIMIT,
): number {
	const n = widths.length;
	for (let k = Math.min(limit, n); k > 1; k--) {
		let total = CHIP_GAP * (k - 1);
		for (let i = 0; i < k; i++) total += widths[i];
		if (k < n) total += CHIP_GAP + moreWidth(n - k);
		if (total <= available) return k;
	}
	return n > 0 ? 1 : 0;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
const textWidths = new Map<string, number>();

/** Width of chip text (11px UI font), measured once per string; a rough guess without a canvas. */
function chipTextWidth(text: string, weight: 500 | 600): number {
	const key = `${weight}|${text}`;
	const known = textWidths.get(key);
	if (known !== undefined) return known;
	if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
	let width = text.length * 6.4;
	if (measureCtx) {
		const family = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || "sans-serif";
		measureCtx.font = `${weight} 11px ${family}`;
		width = measureCtx.measureText(text).width;
	}
	textWidths.set(key, width);
	return width;
}

/** A chip's rendered width: its text, its padding and its icons, capped like the CSS caps it. */
function chipWidth(chip: RefChip): number {
	const icons = (chip.kind === "tag" ? 1 : 0) + (chip.cloud === "none" ? 0 : 1);
	const text = chipTextWidth(chip.name, chip.kind === "head" ? 600 : 500);
	return Math.min(CHIP_MAX, Math.ceil(CHIP_PAD + icons * CHIP_ICON + text) + 1);
}

const moreChipWidth = (hidden: number) => Math.ceil(CHIP_PAD + chipTextWidth(`+${hidden}`, 500)) + 1;

// ---------------------------------------------------------------------------
// Commit body — git's hard wraps reflowed into paragraphs
// ---------------------------------------------------------------------------

export interface BodyParagraph {
	text: string;
	/** Keep the line breaks: a list, indented text, or a block of trailers. */
	pre: boolean;
}

/** A line that only makes sense on its own line: a list item or indented text. */
const KEEPS_ITS_BREAK = /^(?:[-*+] |\d+[.)] | {2,}|\t)/;
/** `Co-Authored-By: …`, `Signed-off-by: …` */
const TRAILER = /^[A-Za-z][\w-]*: \S/;

/**
 * Split a body on blank lines and join each paragraph's lines with spaces,
 * so the text wraps at the panel's width instead of git's 72 columns. A
 * paragraph with a list item or indented line, or made only of trailers,
 * keeps its breaks.
 */
export function reflowBody(body: string): BodyParagraph[] {
	return body
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((p) => p.replace(/^\n+|\s+$/g, ""))
		.filter((p) => p.trim() !== "")
		.map((p) => {
			const lines = p.split("\n");
			const pre =
				lines.some((l) => KEEPS_ITS_BREAK.test(l)) || (lines.length > 1 && lines.every((l) => TRAILER.test(l)));
			return { text: pre ? p : lines.map((l) => l.trim()).join(" "), pre };
		});
}

/** "14 files changed" plus the summed line counts. */
export function summarizeFiles(files: readonly ChangedFile[]): { label: string; additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const f of files) {
		additions += f.additions || 0;
		deletions += f.deletions || 0;
	}
	const n = files.length;
	return { label: `${n} ${n === 1 ? "file" : "files"} changed`, additions, deletions };
}

function splitPath(path: string): { base: string; dir: string } {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? { base: path, dir: "" } : { base: path.slice(slash + 1), dir: path.slice(0, slash) };
}

const FILE_STATUS: Record<string, { label: string; cls: string }> = {
	M: { label: "Modified", cls: s.statusModified },
	A: { label: "Added", cls: s.statusAdded },
	D: { label: "Deleted", cls: s.statusDeleted },
	R: { label: "Renamed", cls: s.statusRenamed },
	C: { label: "Copied", cls: s.statusRenamed },
	T: { label: "Type changed", cls: s.statusModified },
};

const REF_CLASS: Record<RefChipKind, string> = {
	head: s.refHead,
	branch: s.refBranch,
	tag: s.refTag,
};

const RefBadge: Component<{ chip: RefChip }> = (props) => (
	<span class={cx(s.refBadge, REF_CLASS[props.chip.kind])} title={props.chip.title}>
		<Show when={props.chip.kind === "tag"}>
			<IconTag size={12} class={s.refIcon} />
		</Show>
		<Show when={props.chip.cloud === "leading"}>
			<IconCloud size={12} class={s.refIcon} />
		</Show>
		<span class={s.refName}>{props.chip.name}</span>
		<Show when={props.chip.cloud === "trailing"}>
			<IconCloud size={12} class={s.refIcon} />
		</Show>
	</span>
);

/** `+12 −3`, zeros left out (U+2212 for the minus). */
const LineStats: Component<{ additions: number; deletions: number; class?: string }> = (props) => (
	<span class={cx(s.stats, props.class)}>
		<Show when={props.additions > 0}>
			<span class={s.statAdd}>+{props.additions}</span>
		</Show>
		<Show when={props.deletions > 0}>
			<span class={s.statDel}>
				{"−"}
				{props.deletions}
			</span>
		</Show>
	</span>
);

export const LogTab: Component<LogTabProps> = (props) => {
	// Read through a memo: handlers and promises read it, and a prop passed as an
	// expression (a JSX ternary) would create an unowned computation per read.
	const repoPath = createMemo(() => props.repoPath);
	const [commits, setCommits] = createSignal<CommitLogEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [loadMoreFailed, setLoadMoreFailed] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(true);
	const [expandedHash, setExpandedHash] = createSignal<string | null>(null);
	/** Measured height of the expanded row. Wrapped subjects and bodies defeat
	 *  any line-count estimate, so the row reserves its real rendered height —
	 *  otherwise the next row overlaps it and the graph's dots drift. */
	const [expandedHeight, setExpandedHeight] = createSignal(0);
	const [changedFiles, setChangedFiles] = createSignal<Record<string, ChangedFile[]>>({});
	const [graphNodes, setGraphNodes] = createSignal<GraphNode[]>([]);
	const [scrollTop, setScrollTop] = createSignal(0);
	const [viewportHeight, setViewportHeight] = createSignal(0);
	/** The rows' width (the scroll container's, without its scrollbar). */
	const [listWidth, setListWidth] = createSignal(0);
	const [focusedIndex, setFocusedIndex] = createSignal(-1);
	/** The focus ring belongs to the keyboard: a click selects without drawing it. */
	const [keyboardNav, setKeyboardNav] = createSignal(false);
	const [copiedHash, setCopiedHash] = createSignal<string | null>(null);

	let scrollRef!: HTMLDivElement;
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(copiedTimer));

	/** Fetch the first page of commits and the graph */
	async function fetchCommits(repo: string, isCancelled?: () => boolean) {
		if (commits().length === 0) setLoading(true);
		setExpandedHash(null);
		setExpandedHeight(0);
		setChangedFiles({});
		setHasMore(true);
		setLoadMoreFailed(false);
		try {
			const [logResult, graphResult] = await Promise.all([
				invoke<CommitLogEntry[]>("get_commit_log", {
					path: repo,
					count: PAGE_SIZE,
				}),
				invoke<GraphNode[]>("get_commit_graph", {
					path: repo,
					count: 200,
				}).catch((err) => {
					appLogger.debug("git", "Failed to load commit graph", err);
					return [] as GraphNode[];
				}),
			]);
			if (isCancelled?.()) return;
			setLoadError(null);
			setCommits(logResult);
			setGraphNodes(graphResult);
			setHasMore(logResult.length >= PAGE_SIZE);
		} catch (err) {
			if (isCancelled?.()) return;
			appLogger.debug("git", "Failed to load commit log", err);
			setLoadError(String(err));
			setCommits([]);
			setGraphNodes([]);
			setHasMore(false);
		} finally {
			if (!isCancelled?.()) setLoading(false);
		}
	}

	/** Load the next page of commits */
	async function loadMore() {
		const repo = repoPath();
		const current = commits();
		if (!repo || current.length === 0 || loadingMore()) return;

		const lastHash = current[current.length - 1].hash;
		setLoadingMore(true);
		setLoadMoreFailed(false);
		try {
			const result = await invoke<CommitLogEntry[]>("get_commit_log", {
				path: repo,
				count: PAGE_SIZE,
				after: lastHash,
			});
			// A refresh replaced the list while this page was on its way.
			if (commits() !== current) return;
			// The `after` param includes the starting commit, so skip the first (duplicate)
			const newCommits = result.length > 0 && result[0].hash === lastHash ? result.slice(1) : result;
			if (newCommits.length === 0) {
				setHasMore(false);
			} else {
				setCommits((prev) => [...prev, ...newCommits]);
				setHasMore(newCommits.length >= PAGE_SIZE - 1);
			}
		} catch (err) {
			appLogger.debug("git", "Failed to load more commits", err);
			setLoadMoreFailed(true);
		} finally {
			setLoadingMore(false);
		}
	}

	/** Toggle expansion and fetch changed files on demand */
	async function toggleExpand(hash: string) {
		setExpandedHeight(0);
		if (expandedHash() === hash) {
			setExpandedHash(null);
			return;
		}
		setExpandedHash(hash);

		const repo = repoPath();
		if (!repo || changedFiles()[hash]) return;
		try {
			const files = await invoke<ChangedFile[]>("get_changed_files", {
				path: repo,
				scope: hash,
			});
			setChangedFiles((prev) => ({ ...prev, [hash]: files }));
		} catch (err) {
			appLogger.debug("git", "Failed to load changed files for commit", err);
			setChangedFiles((prev) => ({ ...prev, [hash]: [] }));
		}
	}

	async function copyHash(hash: string) {
		try {
			await writeClipboard(hash);
			setCopiedHash(hash);
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => setCopiedHash(null), COPIED_MS);
		} catch (err) {
			appLogger.warn("git", "Failed to copy the commit hash", err);
		}
	}

	/** First-paint guess for an expanded row, replaced by its measured height a frame later. */
	function estimateExpanded(commit: CommitLogEntry): number {
		const bodyLines = commit.body ? commit.body.split("\n").length : 0;
		const files = changedFiles()[commit.hash]?.length ?? 0;
		return ROW_HEIGHT + 8 + bodyLines * 18 + 32 + files * 26 + 10;
	}

	function estimateSize(index: number): number {
		const commit = commits()[index];
		if (!commit || expandedHash() !== commit.hash) return ROW_HEIGHT;
		const measured = expandedHeight();
		return measured > ROW_HEIGHT ? measured : estimateExpanded(commit);
	}

	// One ResizeObserver on the expanded row's detail; the row itself is measured
	// (its wrapped subject counts too), and the virtualizer re-reads every size.
	let expandedRO: ResizeObserver | undefined;
	function measureExpanded(detail: HTMLDivElement) {
		expandedRO?.disconnect();
		expandedRO = new ResizeObserver(() => {
			const row = detail.parentElement;
			if (!row?.isConnected) return;
			const h = Math.ceil(row.getBoundingClientRect().height);
			if (h > 0 && h !== expandedHeight()) {
				setExpandedHeight(h);
				virtualizer.measure();
			}
		});
		expandedRO.observe(detail);
	}
	onCleanup(() => expandedRO?.disconnect());

	// Re-fetch when the repo changes or its git state moves. The GIT revision,
	// not the general one: `get_commit_log` and `get_commit_graph` read only
	// committed history, so a plain file save cannot change their answer.
	createEffect(
		on(
			() => {
				const repo = repoPath();
				// Value consumed for reactivity
				const rev = repo ? repositoriesStore.getGitRevision(repo) : 0;
				return `${repo ?? ""}:${rev}`;
			},
			() => {
				let cancelled = false;
				onCleanup(() => {
					cancelled = true;
				});
				const repo = repoPath();
				if (repo) void fetchCommits(repo, () => cancelled);
			},
		),
	);

	const virtualizer = createVirtualizer({
		get count() {
			return commits().length;
		},
		getScrollElement: () => scrollRef,
		estimateSize,
		overscan: 5,
		paddingStart: LIST_PAD_TOP,
		paddingEnd: LIST_PAD_BOTTOM,
	});

	// Expanding or collapsing changes one row's size: re-read them all.
	createEffect(on(expandedHash, () => virtualizer.measure(), { defer: true }));

	const expandedIndex = createMemo(() => {
		const hash = expandedHash();
		return hash ? commits().findIndex((c) => c.hash === hash) : -1;
	});

	/** The expanded row as the graph needs it: the rows under it move down by its extra height. */
	const expandedRow = createMemo<ExpandedRow | null>(() => {
		const index = expandedIndex();
		return index < 0 ? null : { index, extra: Math.max(0, estimateSize(index) - ROW_HEIGHT) };
	});

	/** Remote names on this page, so `fork/x` folds into `x` like `origin/x` does. */
	const remotes = createMemo(() => collectRemotes(commits().map((c) => c.refs)));

	/** Room for chips on line 1: 60% of it (.refs max-width), inside the row's padding
	 *  (14px + the graph's lanes on the left, 14px on the right). */
	const chipSpace = createMemo(() => 0.6 * Math.max(0, listWidth() - 28 - graphWidth(graphNodes())));

	// Load the next page once the last rendered row is within a few rows of the end.
	createEffect(() => {
		const items = virtualizer.getVirtualItems();
		const last = items[items.length - 1];
		const total = commits().length;
		if (!last || total === 0 || total - 1 - last.index > LOAD_AHEAD_ROWS) return;
		if (!hasMore() || loadingMore() || loadMoreFailed() || loading()) return;
		untrack(() => void loadMore());
	});

	// Sync scroll position and viewport size for the graph canvas.
	createEffect(() => {
		const el = scrollRef;
		if (!el) return;

		setViewportHeight(el.clientHeight);
		setListWidth(el.clientWidth);

		let rafId = 0;
		const onScroll = () => {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				setScrollTop(el.scrollTop);
			});
		};

		const onResize = () => {
			setViewportHeight(el.clientHeight);
			setListWidth(el.clientWidth);
		};

		el.addEventListener("scroll", onScroll, { passive: true });
		const ro = new ResizeObserver(onResize);
		ro.observe(el);

		onCleanup(() => {
			el.removeEventListener("scroll", onScroll);
			cancelAnimationFrame(rafId);
			ro.disconnect();
		});
	});

	const showList = () => !loading() && !loadError() && commits().length > 0;

	function handleListKeyDown(e: KeyboardEvent) {
		// A control inside a row (the copy-hash button, Retry) handles its own
		// keys: Enter there must not also collapse the commit it sits in.
		if ((e.target as HTMLElement)?.closest?.("input, textarea, select, button")) return;

		const total = commits().length;
		if (total === 0) return;

		const idx = focusedIndex();

		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown" ? Math.min(idx + 1, total - 1) : Math.max(idx - 1, 0);
			setKeyboardNav(true);
			setFocusedIndex(next);
			virtualizer.scrollToIndex(next, { align: "auto" });
			return;
		}
		if (e.key === "Enter" && idx >= 0 && idx < total) {
			e.preventDefault();
			setKeyboardNav(true);
			void toggleExpand(commits()[idx].hash);
		}
	}

	/** A drag that selected text inside the row is not a click on it. */
	function selectingIn(el: HTMLElement): boolean {
		const sel = window.getSelection();
		return !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode);
	}

	return (
		<div class={s.container} onKeyDown={handleListKeyDown} onContextMenu={(e) => e.preventDefault()} tabIndex={-1}>
			{/* Graph canvas overlays the scroll container from outside the scroll flow */}
			<Show when={showList() && graphNodes().length > 0}>
				<CommitGraph
					nodes={graphNodes()}
					scrollTop={scrollTop()}
					viewportHeight={viewportHeight()}
					totalHeight={virtualizer.getTotalSize()}
					top={LIST_PAD_TOP}
					expanded={expandedRow()}
				/>
			</Show>
			{/* Always-mounted scroll container so virtualizer has a valid ref */}
			<div ref={scrollRef!} class={s.scrollContainer}>
				<Switch>
					<Match when={!repoPath()}>
						<EmptyState
							icon={IconGit}
							title="No repository"
							description="Open a repository in the sidebar to see its history."
						/>
					</Match>
					<Match when={loading()}>
						<EmptyState loading title={"Loading history…"} />
					</Match>
					<Match when={loadError()}>
						{(message) => (
							<EmptyState tone="error" icon={IconAlert} title="Couldn't load the history" description={message()} />
						)}
					</Match>
					<Match when={commits().length === 0}>
						<EmptyState icon={IconCommit} title="No commits yet" description="Commits on this branch appear here." />
					</Match>
					<Match when={true}>
						<div
							class={s.virtualList}
							style={{ height: `${virtualizer.getTotalSize()}px`, "--graph-w": `${graphWidth(graphNodes())}px` }}
						>
							<For each={virtualizer.getVirtualItems()}>
								{(virtualItem) => {
									const commit = () => commits()[virtualItem.index];
									const isExpanded = () => !!commit() && expandedHash() === commit()!.hash;
									const isFocused = () => keyboardNav() && focusedIndex() === virtualItem.index;
									const chips = createMemo(() => foldRefs(commit()?.refs ?? [], remotes()));
									/** Whole chips that fit line 1; the rest fold into "+N". */
									const shown = createMemo(() =>
										fitChips(
											chips().map((chip) => chipWidth(chip)),
											chipSpace(),
											moreChipWidth,
										),
									);
									const files = () => (commit() ? changedFiles()[commit()!.hash] : undefined);
									const summary = createMemo(() => summarizeFiles(files() ?? []));

									return (
										<Show when={commit()}>
											{(c) => (
												<div
													class={cx(
														s.commitRow,
														isExpanded() && s.commitRowExpanded,
														isFocused() && s.commitRowFocused,
													)}
													style={{ top: `${virtualItem.start}px` }}
													// Every ref, while some may be folded into "+N"; an open
													// commit shows them all (and its body has no tooltip).
													title={
														!isExpanded() && chips().length > 0
															? chips()
																	.map((chip) => chip.title)
																	.join(", ")
															: undefined
													}
													onClick={(e) => {
														if (selectingIn(e.currentTarget)) return;
														setFocusedIndex(virtualItem.index);
														setKeyboardNav(false);
														void toggleExpand(c().hash);
													}}
												>
													{/* Line 1: the subject, then up to two ref chips. It names
													    the row's toggle for assistive tech; the whole row clicks. */}
													<div class={s.commitLine1} role="button" aria-expanded={isExpanded()}>
														<span class={s.commitSubject} title={c().subject}>
															{c().subject}
														</span>
														<Show when={!isExpanded() && chips().length > 0}>
															<span class={s.refs}>
																<For each={chips().slice(0, shown())}>{(chip) => <RefBadge chip={chip} />}</For>
																<Show when={chips().length > shown()}>
																	<span
																		class={cx(s.refBadge, s.refMore)}
																		title={chips()
																			.slice(shown())
																			.map((chip) => chip.title)
																			.join(", ")}
																	>
																		+{chips().length - shown()}
																	</span>
																</Show>
															</span>
														</Show>
													</div>
													{/* Line 2: author · time, the short hash right-aligned */}
													<div class={s.commitLine2}>
														<span class={s.commitAuthor}>{c().author_name}</span>
														<span class={s.commitSep} aria-hidden="true">
															·
														</span>
														<span class={s.commitTime} title={fullTimestamp(c().author_date)}>
															{relativeTime(c().author_date)}
														</span>
														<span class={s.commitHash}>{c().hash.slice(0, 7)}</span>
													</div>
													{/* Expanded: every ref, the body, the summary and the files —
													    measured so the row reserves its real height. */}
													<Show when={isExpanded()}>
														<div class={s.commitDetail} ref={measureExpanded} onClick={(e) => e.stopPropagation()}>
															<Show when={chips().length > 0}>
																<div class={s.detailRefs}>
																	<For each={chips()}>{(chip) => <RefBadge chip={chip} />}</For>
																</div>
															</Show>
															<Show when={c().body}>
																{(body) => (
																	<div class={s.commitBody}>
																		<For each={reflowBody(body())}>
																			{(p) => <p class={cx(s.bodyParagraph, p.pre && s.bodyPre)}>{p.text}</p>}
																		</For>
																	</div>
																)}
															</Show>
															<div class={s.detailSummary}>
																<Switch>
																	<Match when={!files()}>
																		<Spinner size={14} />
																		<span>{"Loading files…"}</span>
																	</Match>
																	<Match when={files()?.length === 0}>
																		<span>No changed files</span>
																	</Match>
																	<Match when={true}>
																		<span>{summary().label}</span>
																		<LineStats additions={summary().additions} deletions={summary().deletions} />
																	</Match>
																</Switch>
																<button
																	type="button"
																	class={s.copyHash}
																	title="Copy commit hash"
																	onClick={() => void copyHash(c().hash)}
																>
																	<Show when={copiedHash() === c().hash} fallback={<IconCopy size={13} />}>
																		<IconCheck size={13} />
																	</Show>
																	<span>{c().hash.slice(0, 7)}</span>
																</button>
															</div>
															<Show when={files()?.length}>
																<div class={s.detailFiles}>
																	<For each={files()}>
																		{(file) => {
																			const { base, dir } = splitPath(file.path);
																			const status = FILE_STATUS[file.status];
																			const clickable = isDiffStatus(file.status);
																			return (
																				<div
																					class={cx(s.changedFile, clickable && s.changedFileClickable)}
																					title={file.path}
																					onClick={() => {
																						const repo = repoPath();
																						if (repo && isDiffStatus(file.status)) {
																							props.onOpenDiff(repo, file.path, file.status, c().hash);
																						}
																					}}
																				>
																					<FileIcon name={base} isDir={false} class={s.fileIcon} />
																					<span class={s.fileLabel}>
																						<span class={cx(s.fileName, file.status === "D" && s.fileNameDeleted)}>
																							{base}
																						</span>
																						<Show when={dir}>
																							<span class={s.fileDir}>{dir}</span>
																						</Show>
																					</span>
																					<LineStats additions={file.additions} deletions={file.deletions} />
																					<span
																						class={cx(s.fileStatus, status?.cls ?? s.statusOther)}
																						title={status?.label ?? file.status}
																					>
																						{file.status}
																					</span>
																				</div>
																			);
																		}}
																	</For>
																</div>
															</Show>
														</div>
													</Show>
												</div>
											)}
										</Show>
									);
								}}
							</For>
						</div>
						{/* The next page loads by itself; the footer only reports it. */}
						<Show when={loadingMore() || loadMoreFailed()}>
							<div class={s.listFooter} role={loadMoreFailed() ? "alert" : "status"}>
								<Show
									when={loadMoreFailed()}
									fallback={
										<>
											<Spinner size={14} />
											<span>{"Loading more…"}</span>
										</>
									}
								>
									<IconAlert size={14} class={s.footerAlert} />
									<span>Couldn't load more</span>
									<button
										type="button"
										class={s.retryBtn}
										onClick={() => {
											setLoadMoreFailed(false);
											void loadMore();
										}}
									>
										Retry
									</button>
								</Show>
							</div>
						</Show>
					</Match>
				</Switch>
			</div>
		</div>
	);
};

export default LogTab;
