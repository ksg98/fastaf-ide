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
import { Portal } from "solid-js/web";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { promptLibraryStore } from "../../stores/promptLibrary";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { writeClipboard } from "../../utils/clipboard";
import { ConfirmDialog } from "../ConfirmDialog/ConfirmDialog";
import { ContextMenu, type ContextMenuItem, createContextMenu } from "../ContextMenu";
import { FileIcon } from "../FileBrowserPanel/FileIcon";
import { IconAlert, IconArchive, IconCheck, IconClose, IconCopy, IconGit, IconSparkle, IconTrash } from "../icons";
import { EmptyState } from "../shared/EmptyState";
import { Spinner } from "../shared/Spinner";
import s from "./StashesTab.module.css";
import { checkStash } from "./stashCheck";

/** Mirrors the Rust StashEntry struct from git.rs */
interface StashEntry {
	index: number;
	ref_name: string;
	message: string;
	hash: string;
}

export interface StashesTabProps {
	repoPath: string | null;
	/** Where the tab's one list-level action goes: the Git panel header's action
	 *  slot, so "Check all" costs the list no row of its own. */
	headerSlot?: HTMLElement;
}

/** A check line that belongs to no row: why the check cannot run, or a stash it
 *  dropped (what it was, and the command that brings it back). */
type CheckLine =
	| { kind: "blocked"; message: string }
	| { kind: "dropped"; title: string; summary: string; restore?: string; archiveRef?: string };

const COPIED_MS = 1500;

// ---------------------------------------------------------------------------
// Stash message and diff — what git prints, shaped for two lines and a well
// ---------------------------------------------------------------------------

export interface StashLabel {
	/** Line 1: what the stash holds. */
	title: string;
	/** Line 2 after `stash@{n}`: "WIP on main", "on feat/x", or nothing. */
	context: string | null;
}

/**
 * `WIP on <b>: <hash> <subject>` (a plain `git stash`) → the subject, "WIP on <b>";
 * `On <b>: <message>` (`git stash push -m`) → the message, "on <b>";
 * anything else is its own title.
 */
export function parseStashMessage(message: string): StashLabel {
	const wip = /^WIP on ([^:]+): [0-9a-f]{4,40} (.+)$/.exec(message);
	if (wip) return { title: wip[2], context: `WIP on ${wip[1]}` };
	const named = /^On ([^:]+): (.+)$/.exec(message);
	if (named) return { title: named[2], context: `on ${named[1]}` };
	return { title: message, context: null };
}

export type StashDiffLineKind = "hunk" | "add" | "del" | "context" | "note";

export interface StashDiffFile {
	path: string;
	additions: number;
	deletions: number;
	lines: { kind: StashDiffLineKind; text: string }[];
}

/**
 * Split `git stash show -p` into files. The `diff --git`, `index`, mode,
 * rename, `---` and `+++` lines become the file's header row (its path and
 * counts), so only the hunks remain as lines.
 */
export function parseStashDiff(diff: string): StashDiffFile[] {
	const files: StashDiffFile[] = [];
	let file: StashDiffFile | null = null;
	let inHunk = false;
	for (const line of diff.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")) {
		if (line.startsWith("diff --git ")) {
			const paths = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
			file = { path: paths ? paths[2] : line.slice(11), additions: 0, deletions: 0, lines: [] };
			files.push(file);
			inHunk = false;
			continue;
		}
		if (!file) {
			if (line === "") continue;
			file = { path: "", additions: 0, deletions: 0, lines: [] };
			files.push(file);
		}
		if (!inHunk) {
			if (line.startsWith("+++ ")) {
				const path = line.slice(4);
				if (path !== "/dev/null") file.path = path.replace(/^b\//, "");
				continue;
			}
			if (line.startsWith("Binary files ")) {
				file.lines.push({ kind: "note", text: "Binary file" });
				continue;
			}
			if (!line.startsWith("@@")) continue;
			inHunk = true;
		}
		if (line.startsWith("@@")) file.lines.push({ kind: "hunk", text: line });
		else if (line.startsWith("+")) {
			file.additions++;
			file.lines.push({ kind: "add", text: line });
		} else if (line.startsWith("-")) {
			file.deletions++;
			file.lines.push({ kind: "del", text: line });
		} else if (line.startsWith("\\")) file.lines.push({ kind: "note", text: line });
		else file.lines.push({ kind: "context", text: line });
	}
	return files;
}

const LINE_CLASS: Record<StashDiffLineKind, string> = {
	hunk: s.diffHunk,
	add: s.diffAdd,
	del: s.diffDel,
	context: s.diffContext,
	note: s.diffNote,
};

function splitPath(path: string): { base: string; dir: string } {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? { base: path, dir: "" } : { base: path.slice(slash + 1), dir: path.slice(0, slash) };
}

const COMMAND_VERB: Record<string, string> = {
	git_stash_apply: "apply",
	git_stash_pop: "pop",
	git_stash_drop: "drop",
};

/** The diff well under an expanded stash: a header row per file, then its hunks. */
const StashDiff: Component<{ diff: string }> = (props) => {
	const files = createMemo(() => parseStashDiff(props.diff));
	return (
		<div class={s.diffWell}>
			<For each={files()}>
				{(file) => {
					const { base, dir } = splitPath(file.path);
					return (
						<>
							<div class={s.diffFile} title={file.path}>
								<FileIcon name={base} isDir={false} class={s.fileIcon} />
								<span class={s.fileLabel}>
									<span class={s.fileName}>{base}</span>
									<Show when={dir}>
										<span class={s.fileDir}>{dir}</span>
									</Show>
								</span>
								<span class={s.fileStats}>
									<Show when={file.additions > 0}>
										<span class={s.statAdd}>+{file.additions}</span>
									</Show>
									<Show when={file.deletions > 0}>
										<span class={s.statDel}>
											{"−"}
											{file.deletions}
										</span>
									</Show>
								</span>
							</div>
							<div class={s.diffHunks}>
								<For each={file.lines}>
									{(line) => <div class={cx(s.diffLine, LINE_CLASS[line.kind])}>{line.text}</div>}
								</For>
							</div>
						</>
					);
				}}
			</For>
		</div>
	);
};

export const StashesTab: Component<StashesTabProps> = (props) => {
	// Read through a memo: handlers and promises read it, and a prop passed as an
	// expression (a JSX ternary) would create an unowned computation per read.
	const repoPath = createMemo(() => props.repoPath);
	const [stashes, setStashes] = createSignal<StashEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [busyRef, setBusyRef] = createSignal<string | null>(null);
	/** The last apply / pop / drop that failed, shown under its stash until dismissed. */
	const [commandError, setCommandError] = createSignal<{ ref: string; title: string; message: string } | null>(null);
	const [expandedRef, setExpandedRef] = createSignal<string | null>(null);
	const [diffs, setDiffs] = createSignal<Record<string, string>>({});
	const [diffLoading, setDiffLoading] = createSignal<Record<string, boolean>>({});
	const [focusedIndex, setFocusedIndex] = createSignal(-1);
	/** The focus ring belongs to the keyboard: a click expands without drawing it. */
	const [keyboardNav, setKeyboardNav] = createSignal(false);
	const { executeSmartPrompt, canExecute } = useSmartPrompts();
	const [checking, setChecking] = createSignal(false);
	/** What the last check said about a stash it kept, by stash commit: a drop
	 *  renumbers every `stash@{n}` after it, the hash stays. */
	const [checkNotes, setCheckNotes] = createSignal<Record<string, string>>({});
	/** Check lines that belong to no row: why the check cannot run, and each
	 *  stash it dropped (where the archive is, how to restore it). */
	const [checkLog, setCheckLog] = createSignal<CheckLine[]>([]);
	const [copied, setCopied] = createSignal<string | null>(null);
	let copiedTimer: ReturnType<typeof setTimeout> | undefined;
	onCleanup(() => clearTimeout(copiedTimer));

	async function copyRestore(command: string) {
		try {
			await writeClipboard(command);
			setCopied(command);
			clearTimeout(copiedTimer);
			copiedTimer = setTimeout(() => setCopied(null), COPIED_MS);
		} catch (err) {
			appLogger.warn("git", "Failed to copy the restore command", err);
		}
	}

	// Confirm dialog state
	const [confirmVisible, setConfirmVisible] = createSignal(false);
	const [confirmTitle, setConfirmTitle] = createSignal("");
	const [confirmMessage, setConfirmMessage] = createSignal("");
	const [confirmLabel, setConfirmLabel] = createSignal("");
	const [confirmAction, setConfirmAction] = createSignal<(() => void) | null>(null);

	const menu = createContextMenu();
	const [menuRef, setMenuRef] = createSignal<string | null>(null);

	const entryEls: HTMLElement[] = [];

	async function fetchStashes(repo: string) {
		if (stashes().length === 0) setLoading(true);
		try {
			const result = await invoke<StashEntry[]>("get_stash_list", { path: repo });
			setLoadError(null);
			setStashes(result);
		} catch (err) {
			appLogger.warn("git", "Failed to load stash list", err);
			setLoadError(String(err));
			setStashes([]);
		} finally {
			setLoading(false);
		}
	}

	// Re-fetch when the repo changes or its git state moves. The GIT revision,
	// not the general one: a stash is a ref, and `git stash` writes
	// `.git/refs/stash` — which the watcher reports as git-state.
	createEffect(
		on(
			() => {
				const repo = repoPath();
				const rev = repo ? repositoriesStore.getGitRevision(repo) : 0;
				return `${repo ?? ""}:${rev}`;
			},
			() => {
				const repo = repoPath();
				if (repo) void fetchStashes(repo);
			},
		),
	);

	// What a check said belongs to the repository it ran in.
	createEffect(
		on(
			repoPath,
			() => {
				setCheckNotes({});
				setCheckLog([]);
			},
			{ defer: true },
		),
	);

	async function runStashCommand(command: string, stashRef: string) {
		const repo = repoPath();
		if (!repo) return;
		setBusyRef(stashRef);
		setCommandError(null);
		try {
			await invoke<void>(command, { path: repo, stashRef });
			// Pop and drop renumber every stash after this one: a cached diff or an
			// open row would now name a different stash.
			if (command !== "git_stash_apply") {
				setDiffs({});
				setExpandedRef(null);
			}
			await fetchStashes(repo);
		} catch (err) {
			appLogger.error("git", `${command} failed`, err);
			setCommandError({
				ref: stashRef,
				title: `Couldn't ${COMMAND_VERB[command] ?? "run"} ${stashRef}`,
				message: String(err),
			});
		} finally {
			setBusyRef(null);
		}
	}

	/** Check one stash, or every listed stash. Git computes the facts, the smart
	 *  prompt classifies, and only the backend drops (after archiving the commit).
	 *  Pass them oldest first (highest index): a drop renumbers only the stashes
	 *  after it, which are already done. */
	async function handleCheck(targets: StashEntry[]) {
		const repo = repoPath();
		const prompt = promptLibraryStore.getSmartById("smart-stash-check");
		if (!repo || !prompt || checking()) return;
		setCheckNotes({});
		const gate = canExecute(prompt);
		if (!gate.ok) {
			setCheckLog([{ kind: "blocked", message: gate.reason ?? "Cannot run the stash check" }]);
			return;
		}
		setChecking(true);
		setCheckLog([]);
		setCommandError(null);
		try {
			for (const stash of targets) {
				setBusyRef(stash.ref_name);
				try {
					const r = await checkStash(repo, stash.ref_name, prompt, executeSmartPrompt);
					if (r.dropped) {
						setCheckLog((prev) => [
							...prev,
							{
								kind: "dropped",
								title: parseStashMessage(stash.message).title,
								summary: r.summary,
								restore: r.restore,
								archiveRef: r.archiveRef,
							},
						]);
						// The drop renumbered the stashes after this one: a cached diff, an
						// open row or the spinner would now name a different stash.
						setBusyRef(null);
						setDiffs({});
						setExpandedRef(null);
						await fetchStashes(repo);
					} else {
						setCheckNotes((prev) => ({ ...prev, [stash.hash]: r.summary }));
					}
				} catch (err) {
					appLogger.error("git", `Stash check failed for ${stash.ref_name}`, err);
					setCheckNotes((prev) => ({ ...prev, [stash.hash]: `Kept. ${String(err)}` }));
				}
			}
		} finally {
			setBusyRef(null);
			setChecking(false);
		}
	}

	function handleApply(refName: string) {
		void runStashCommand("git_stash_apply", refName);
	}

	function showConfirm(title: string, message: string, label: string, action: () => void) {
		setConfirmTitle(title);
		setConfirmMessage(message);
		setConfirmLabel(label);
		setConfirmAction(() => action);
		setConfirmVisible(true);
	}

	function handlePop(refName: string) {
		showConfirm(
			`Pop ${refName}?`,
			`Apply and remove "${refName}"?\nThis cannot be undone.`,
			"Pop",
			() => void runStashCommand("git_stash_pop", refName),
		);
	}

	function handleDrop(refName: string) {
		showConfirm(
			`Drop ${refName}?`,
			`Permanently delete "${refName}"?\nThis cannot be undone.`,
			"Drop",
			() => void runStashCommand("git_stash_drop", refName),
		);
	}

	function handleConfirm() {
		const action = confirmAction();
		setConfirmVisible(false);
		setConfirmAction(null);
		if (action) action();
	}

	function handleConfirmClose() {
		setConfirmVisible(false);
		setConfirmAction(null);
	}

	async function toggleDiff(refName: string) {
		if (expandedRef() === refName) {
			setExpandedRef(null);
			return;
		}
		setExpandedRef(refName);

		const repo = repoPath();
		if (!repo) return;
		// Fetch diff if not cached
		if (diffs()[refName] === undefined) {
			setDiffLoading((prev) => ({ ...prev, [refName]: true }));
			try {
				const diff = await invoke<string>("git_stash_show", {
					path: repo,
					stashRef: refName,
				});
				setDiffs((prev) => ({ ...prev, [refName]: diff }));
			} catch (err) {
				appLogger.warn("git", "Failed to load stash diff", err);
				setDiffs((prev) => ({ ...prev, [refName]: "" }));
			} finally {
				setDiffLoading((prev) => ({ ...prev, [refName]: false }));
			}
		}
	}

	const menuItems = (): ContextMenuItem[] => {
		const ref = menuRef();
		if (!ref) return [];
		const busy = busyRef() !== null;
		const stash = stashes().find((entry) => entry.ref_name === ref);
		return [
			{ label: "Apply", action: () => handleApply(ref), disabled: busy },
			{ label: "Pop", action: () => handlePop(ref), disabled: busy, separator: true },
			{
				label: "Check if still needed",
				action: () => stash && void handleCheck([stash]),
				disabled: busy || checking() || !stash,
				separator: true,
			},
			{ label: "Drop", action: () => handleDrop(ref), disabled: busy },
		];
	};

	function handleListKeyDown(e: KeyboardEvent) {
		const tag = (e.target as HTMLElement)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return;

		const total = stashes().length;
		if (total === 0) return;

		const idx = focusedIndex();

		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const next = e.key === "ArrowDown" ? Math.min(idx + 1, total - 1) : Math.max(idx - 1, 0);
			setKeyboardNav(true);
			setFocusedIndex(next);
			entryEls[next]?.scrollIntoView({ block: "nearest" });
			return;
		}
		if (e.key === "Enter" && idx >= 0 && idx < total) {
			e.preventDefault();
			setKeyboardNav(true);
			void toggleDiff(stashes()[idx].ref_name);
		}
	}

	return (
		<div class={s.container} onKeyDown={handleListKeyDown} tabIndex={-1}>
			<Switch>
				<Match when={!repoPath()}>
					<EmptyState
						icon={IconGit}
						title="No repository"
						description="Open a repository in the sidebar to see its stashes."
					/>
				</Match>
				<Match when={loading()}>
					<EmptyState loading title={"Loading stashes…"} />
				</Match>
				<Match when={loadError()}>
					{(message) => (
						<EmptyState tone="error" icon={IconAlert} title="Couldn't load stashes" description={message()} />
					)}
				</Match>
				{/* A check that dropped the last stash still has its outcome to show. */}
				<Match when={stashes().length === 0 && checkLog().length === 0}>
					<EmptyState
						icon={IconArchive}
						title="No stashes"
						description="Stash work in progress to set it aside without committing."
					/>
				</Match>
				<Match when={true}>
					<div class={s.list}>
						{/* What a check had to say outside the rows: why it cannot run, and each
						    stash it dropped, whose row is gone. The restore command can be
						    selected and copied. */}
						<For each={checkLog()}>
							{(line) =>
								line.kind === "blocked" ? (
									<div class={s.checkLine} role="status">
										<IconAlert size={14} class={s.checkIcon} />
										<div class={s.checkText}>{line.message}</div>
									</div>
								) : (
									<div class={s.checkLine} role="status">
										<IconArchive size={14} class={s.checkIcon} />
										<div class={s.checkText}>
											<div class={s.checkTitle} title={line.archiveRef}>
												{line.title}
											</div>
											<div>{line.summary}</div>
											<Show when={line.restore}>{(command) => <code class={s.checkCommand}>{command()}</code>}</Show>
										</div>
										<Show when={line.restore}>
											{(command) => (
												<button
													type="button"
													class={s.iconBtn}
													title={copied() === command() ? "Copied" : "Copy the command that restores it"}
													aria-label="Copy the restore command"
													onClick={() => void copyRestore(command())}
												>
													{copied() === command() ? <IconCheck size={14} /> : <IconCopy size={14} />}
												</button>
											)}
										</Show>
									</div>
								)
							}
						</For>
						<For each={stashes()}>
							{(stash, i) => {
								const label = createMemo(() => parseStashMessage(stash.message));
								const isBusy = () => busyRef() === stash.ref_name;
								const isExpanded = () => expandedRef() === stash.ref_name;
								const isFocused = () => keyboardNav() && focusedIndex() === i();
								const diff = () => diffs()[stash.ref_name];
								const error = () => {
									const e = commandError();
									return e && e.ref === stash.ref_name ? e : null;
								};
								const menuOpen = () => menu.visible() && menuRef() === stash.ref_name;

								return (
									<div
										class={cx(s.stashEntry, isFocused() && s.stashEntryFocused)}
										ref={(el) => {
											entryEls[i()] = el;
										}}
									>
										<div
											class={cx(s.stashHead, isExpanded() && s.stashHeadExpanded, menuOpen() && s.stashHeadMenuOpen)}
											title={stash.message}
											onClick={() => {
												setFocusedIndex(i());
												setKeyboardNav(false);
												void toggleDiff(stash.ref_name);
											}}
											onContextMenu={(e) => {
												setFocusedIndex(i());
												setMenuRef(stash.ref_name);
												menu.open(e);
											}}
										>
											<IconArchive size={16} class={s.stashIcon} />
											{/* The row's toggle for assistive tech (the whole row clicks); the
											    actions stay outside it, so they keep their own button roles. */}
											<div class={s.stashText} role="button" aria-expanded={isExpanded()}>
												<span class={s.stashTitle}>{label().title}</span>
												<span class={s.stashMeta}>
													<span class={s.stashRef}>{stash.ref_name}</span>
													<Show when={label().context}>
														{(context) => (
															<>
																<span class={s.stashSep} aria-hidden="true">
																	·
																</span>
																{context()}
															</>
														)}
													</Show>
												</span>
											</div>
											{/* Apply · Pop · Check · Drop stay visible, quiet until the row is
											    hovered, focused or open; a spinner takes their place. */}
											<div class={s.stashActions} onClick={(e) => e.stopPropagation()}>
												<div class={cx(s.actionGroup, isBusy() && s.actionGroupHidden)}>
													<button
														type="button"
														class={s.textBtn}
														title="Apply the changes and keep the stash"
														disabled={isBusy()}
														onClick={() => handleApply(stash.ref_name)}
													>
														Apply
													</button>
													<button
														type="button"
														class={s.textBtn}
														title="Apply the changes and drop the stash"
														disabled={isBusy()}
														onClick={() => handlePop(stash.ref_name)}
													>
														Pop
													</button>
													<button
														type="button"
														class={s.iconBtn}
														title="Check if this stash is still needed: it is dropped only when proven redundant"
														aria-label={`Check ${stash.ref_name}`}
														disabled={isBusy() || checking()}
														onClick={() => void handleCheck([stash])}
													>
														<IconSparkle size={16} />
													</button>
													<button
														type="button"
														class={cx(s.iconBtn, s.dangerBtn)}
														title="Drop"
														aria-label={`Drop ${stash.ref_name}`}
														disabled={isBusy()}
														onClick={() => handleDrop(stash.ref_name)}
													>
														<IconTrash size={16} />
													</button>
												</div>
												<Show when={isBusy()}>
													<Spinner size={14} class={s.stashSpinner} />
												</Show>
											</div>
										</div>
										<Show when={error()}>
											{(failure) => (
												<div class={s.stashError} role="alert">
													<IconAlert size={14} class={s.stashErrorIcon} />
													<div class={s.stashErrorText}>
														<div class={s.stashErrorTitle}>{failure().title}</div>
														{failure().message}
													</div>
													<button
														type="button"
														class={s.stashErrorClose}
														title="Dismiss"
														aria-label="Dismiss"
														onClick={() => setCommandError(null)}
													>
														<IconClose size={12} />
													</button>
												</div>
											)}
										</Show>
										<Show when={checkNotes()[stash.hash]}>
											{(note) => (
												<div class={s.stashNote} role="status">
													{note()}
												</div>
											)}
										</Show>
										<Show when={isExpanded()}>
											<Switch>
												<Match when={diffLoading()[stash.ref_name] || diff() === undefined}>
													<div class={s.diffStatus} role="status">
														<Spinner size={14} />
														<span>{"Loading diff…"}</span>
													</div>
												</Match>
												<Match when={!diff()}>
													<div class={s.diffStatus}>No diff to show</div>
												</Match>
												<Match when={diff()}>{(text) => <StashDiff diff={text()} />}</Match>
											</Switch>
										</Show>
									</div>
								);
							}}
						</For>
					</div>
				</Match>
			</Switch>

			{/* The list's one action lives in the Git panel header, beside the window
			    controls, instead of a "Stashes N" row that repeats the tab's name. */}
			<Show when={props.headerSlot && stashes().length > 0 ? props.headerSlot : undefined}>
				{(slot) => (
					<Portal mount={slot()}>
						<button
							type="button"
							class={s.headerBtn}
							title="Check all stashes: drop the ones proven redundant, keep the rest"
							aria-label="Check all stashes"
							disabled={checking() || busyRef() !== null}
							onClick={() => void handleCheck([...stashes()].reverse())}
						>
							<IconSparkle size={16} />
						</button>
					</Portal>
				)}
			</Show>

			<ContextMenu
				items={menuItems()}
				x={menu.position().x}
				y={menu.position().y}
				visible={menu.visible()}
				onClose={menu.close}
			/>

			<ConfirmDialog
				visible={confirmVisible()}
				title={confirmTitle()}
				message={confirmMessage()}
				confirmLabel={confirmLabel()}
				kind="warning"
				onClose={handleConfirmClose}
				onConfirm={handleConfirm}
			/>
		</div>
	);
};

export default StashesTab;
