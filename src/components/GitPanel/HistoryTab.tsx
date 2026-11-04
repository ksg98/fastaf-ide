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
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { repositoriesStore } from "../../stores/repositories";
import { onClickKeyDown } from "../../utils/a11y";
import { fullTimestamp, relativeTime } from "../../utils/time";
import { IconAlert } from "../icons";
import { EmptyState } from "../shared/EmptyState";
import { Spinner } from "../shared/Spinner";
import type { OpenDiffFn } from "./GitPanel";
import s from "./HistoryTab.module.css";
import type { CommitLogEntry } from "./types";

const PAGE_SIZE = 50;

export interface HistoryTabProps {
	repoPath: string | null;
	filePath: string | null;
	onOpenDiff: OpenDiffFn;
}

/**
 * The History drawer under the Changes tab: the commits that touched the
 * selected file, as two-line rows (the drawer header names the file). A row
 * opens the file's diff at that commit.
 */
export const HistoryTab: Component<HistoryTabProps> = (props) => {
	// Read through memos: handlers and promises read these, and a prop passed as
	// an expression (a JSX ternary) would create an unowned computation per read.
	const repoPath = createMemo(() => props.repoPath);
	const filePath = createMemo(() => props.filePath);
	const [commits, setCommits] = createSignal<CommitLogEntry[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [loadError, setLoadError] = createSignal<string | null>(null);
	const [loadingMore, setLoadingMore] = createSignal(false);
	const [hasMore, setHasMore] = createSignal(true);
	/** repo:file whose rows are on screen */
	let shownKey = "";

	/** Fetch the initial commit page for the file */
	async function fetchHistory(repo: string, file: string, isCancelled?: () => boolean) {
		if (commits().length === 0) setLoading(true);
		setHasMore(true);
		try {
			const result = await invoke<CommitLogEntry[]>("get_file_history", {
				path: repo,
				file,
				count: PAGE_SIZE,
			});
			if (isCancelled?.()) return;
			setLoadError(null);
			setCommits(result);
			setHasMore(result.length >= PAGE_SIZE);
		} catch (err) {
			if (isCancelled?.()) return;
			appLogger.debug("git", "Failed to load file history", err);
			setLoadError(String(err));
			setCommits([]);
			setHasMore(false);
		} finally {
			if (!isCancelled?.()) setLoading(false);
		}
	}

	/** Load the next page of commits */
	async function loadMore() {
		const repo = repoPath();
		const file = filePath();
		const current = commits();
		if (!repo || !file || current.length === 0 || loadingMore()) return;

		const lastHash = current.at(-1)!.hash;
		setLoadingMore(true);
		try {
			const result = await invoke<CommitLogEntry[]>("get_file_history", {
				path: repo,
				file,
				count: PAGE_SIZE,
				after: lastHash,
			});
			// The file or the list changed while this page was on its way.
			if (commits() !== current || filePath() !== file) return;
			// The `after` param includes the starting commit, so skip the first (duplicate)
			const newCommits = result.length > 0 && result[0].hash === lastHash ? result.slice(1) : result;
			if (newCommits.length === 0) {
				setHasMore(false);
			} else {
				setCommits((prev) => [...prev, ...newCommits]);
				setHasMore(newCommits.length >= PAGE_SIZE - 1);
			}
		} catch (err) {
			appLogger.debug("git", "Failed to load more file history", err);
			setHasMore(false);
		} finally {
			setLoadingMore(false);
		}
	}

	/** Open a diff tab for the file at a specific commit */
	function openCommitDiff(hash: string) {
		const repo = repoPath();
		const file = filePath();
		if (!repo || !file) return;
		props.onOpenDiff(repo, file, "M", hash);
	}

	// Re-fetch when the repo, the file, or the repo's git state changes. The GIT
	// revision, not the general one: `get_file_history` lists commits, so editing
	// the file it describes does not change the list.
	createEffect(
		on(
			() => {
				const repo = repoPath();
				const file = filePath();
				// Value consumed for reactivity
				const rev = repo ? repositoriesStore.getGitRevision(repo) : 0;
				return `${repo ?? ""}:${file ?? ""}:${rev}`;
			},
			() => {
				let cancelled = false;
				onCleanup(() => {
					cancelled = true;
				});

				const repo = repoPath();
				const file = filePath();
				// Another file: drop the old one's rows so they never sit under its name.
				const key = `${repo ?? ""}:${file ?? ""}`;
				if (key !== shownKey) {
					shownKey = key;
					setCommits([]);
				}
				if (repo && file) {
					void fetchHistory(repo, file, () => cancelled);
				} else {
					setCommits([]);
					setLoadError(null);
					setLoading(false);
				}
			},
		),
	);

	return (
		<div class={s.container} onContextMenu={(e) => e.preventDefault()}>
			<Switch>
				<Match when={!filePath()}>
					<EmptyState size="compact" title="Select a file to see its history" />
				</Match>
				<Match when={loading()}>
					<EmptyState size="compact" loading title={"Loading history…"} />
				</Match>
				<Match when={loadError()}>
					{(message) => (
						<div class={s.errorLine} role="alert">
							<IconAlert size={14} class={s.errorIcon} />
							<span class={s.errorText}>{message()}</span>
						</div>
					)}
				</Match>
				<Match when={commits().length === 0}>
					<EmptyState size="compact" title="No commits touch this file" />
				</Match>
				<Match when={true}>
					<div class={s.scrollContainer}>
						<For each={commits()}>
							{(commit) => (
								<div
									class={s.commitRow}
									role="button"
									tabIndex={0}
									onClick={() => openCommitDiff(commit.hash)}
									onKeyDown={onClickKeyDown(() => openCommitDiff(commit.hash))}
								>
									{/* Line 1: the subject */}
									<div class={s.commitLine1}>
										<span class={s.commitSubject} title={commit.subject}>
											{commit.subject}
										</span>
									</div>
									{/* Line 2: author · time, the short hash right-aligned */}
									<div class={s.commitLine2}>
										<span class={s.commitAuthor}>{commit.author_name}</span>
										<span class={s.commitSep} aria-hidden="true">
											·
										</span>
										<span class={s.commitTime} title={fullTimestamp(commit.author_date)}>
											{relativeTime(commit.author_date)}
										</span>
										<span class={s.commitHash}>{commit.hash.slice(0, 7)}</span>
									</div>
								</div>
							)}
						</For>
						<Show when={hasMore()}>
							<button type="button" class={s.showMore} disabled={loadingMore()} onClick={() => void loadMore()}>
								<Show when={loadingMore()} fallback="Show more">
									<Spinner size={14} />
									<span>{"Loading…"}</span>
								</Show>
							</button>
						</Show>
					</div>
				</Match>
			</Switch>
		</div>
	);
};

export default HistoryTab;
