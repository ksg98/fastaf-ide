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
} from "solid-js";
import { invoke } from "../../invoke";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { fullTimestamp } from "../../utils/time";
import { IconAlert } from "../icons";
import { EmptyState } from "../shared/EmptyState";
import s from "./BlameTab.module.css";

/** Mirrors the Rust BlameLine struct from git.rs */
interface BlameLine {
	hash: string;
	author: string;
	/** Unix timestamp in seconds */
	author_time: number;
	/** Commit subject (first line of the message) */
	summary: string;
	line_number: number;
	content: string;
}

export interface BlameTabProps {
	repoPath: string | null;
	filePath: string | null;
}

/** One code line (virtualised). */
const ROW_HEIGHT = 20;
/** Space above the first line and below the last. */
const LIST_PAD_TOP = 4;
const LIST_PAD_BOTTOM = 8;
/** The age bar fades from the newest line's commit to the oldest's. */
const AGE_NEWEST = 0.85;
const AGE_OLDEST = 0.12;
/** git.rs `ensure_file_tracked`: blame on a file git does not track yet. A new
 *  file is a state to describe, not a failure to show in red. */
const UNTRACKED_ERROR = "File is not tracked by git";

/** True when `get_file_blame` refused because git does not track the file yet. */
export function isUntrackedBlameError(message: string): boolean {
	return message.startsWith(UNTRACKED_ERROR);
}

/** Opacity of the age bar for a line `fraction` of the way from newest (0) to oldest (1). */
export function ageOpacity(fraction: number): number {
	const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
	return Math.round((AGE_NEWEST - f * (AGE_NEWEST - AGE_OLDEST)) * 1000) / 1000;
}

/** A gutter-sized age: "now", "5m", "3h", "2d", "3w", "4mo", "2y". */
export function shortAge(authorTimeSec: number, nowMs = Date.now()): string {
	const sec = Math.max(0, Math.floor(nowMs / 1000 - authorTimeSec));
	if (sec < 60) return "now";
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m`;
	const hours = Math.floor(min / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

/**
 * The Blame drawer under the Changes tab: who last changed each line of the
 * selected file. A commit's first line carries its hash, author and age; a
 * 2px bar at the gutter's edge fades with age; a click on the gutter marks
 * every line of that commit.
 */
export const BlameTab: Component<BlameTabProps> = (props) => {
	// Read through memos: handlers and promises read these, and a prop passed as
	// an expression (a JSX ternary) would create an unowned computation per read.
	const repoPath = createMemo(() => props.repoPath);
	const filePath = createMemo(() => props.filePath);
	const [lines, setLines] = createSignal<BlameLine[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [highlightedHash, setHighlightedHash] = createSignal<string | null>(null);
	/** Always mounted, so the virtualizer has its scroll element from the start. */
	let scrollRef!: HTMLDivElement;
	/** repo:file whose lines are on screen */
	let shownKey = "";

	// Fetch when the repo, the file or the repo's revision changes — and only
	// then: `on` names every dependency, so the result the effect stores can
	// never re-run it (it used to read `lines()` and loop, one git blame per
	// round-trip). The GENERAL revision: blame reads the working copy, so a save
	// changes it. A cancelled run hands `loading` to the run that replaced it.
	createEffect(
		on(
			() => {
				const repo = repoPath();
				const file = filePath();
				const rev = repo ? repositoriesStore.getRevision(repo) : 0;
				return `${repo ?? ""}:${file ?? ""}:${rev}`;
			},
			() => {
				const repo = repoPath();
				const file = filePath();

				// Another file: its lines and mark start over; a refresh keeps both.
				const key = `${repo ?? ""}:${file ?? ""}`;
				if (key !== shownKey) {
					shownKey = key;
					setLines([]);
					setHighlightedHash(null);
				}

				if (!repo || !file) {
					setError(null);
					setLoading(false);
					return;
				}

				let cancelled = false;
				onCleanup(() => {
					cancelled = true;
				});

				if (lines().length === 0) setLoading(true);
				setError(null);

				invoke<BlameLine[]>("get_file_blame", { path: repo, file })
					.then((result) => {
						if (!cancelled) setLines(result);
					})
					.catch((err) => {
						if (cancelled) return;
						setError(String(err));
						setLines([]);
					})
					.finally(() => {
						if (!cancelled) setLoading(false);
					});
			},
		),
	);

	const virtualizer = createVirtualizer({
		get count() {
			return lines().length;
		},
		getScrollElement: () => scrollRef,
		estimateSize: () => ROW_HEIGHT,
		overscan: 20,
		paddingStart: LIST_PAD_TOP,
		paddingEnd: LIST_PAD_BOTTOM,
	});

	// Age range for the bar's fade
	const ageRange = createMemo(() => {
		const data = lines();
		if (data.length === 0) return { oldest: 0, newest: 0 };
		let oldest = data[0].author_time;
		let newest = data[0].author_time;
		for (const line of data) {
			if (line.author_time < oldest) oldest = line.author_time;
			if (line.author_time > newest) newest = line.author_time;
		}
		return { oldest, newest };
	});

	function ageFraction(authorTime: number): number {
		const { oldest, newest } = ageRange();
		if (newest === oldest) return 0;
		return (newest - authorTime) / (newest - oldest);
	}

	function isGroupStart(index: number): boolean {
		if (index === 0) return true;
		const data = lines();
		return data[index].hash !== data[index - 1].hash;
	}

	function gutterTitle(line: BlameLine): string {
		const when = fullTimestamp(new Date(line.author_time * 1000).toISOString());
		return `${line.hash.slice(0, 7)} · ${line.author} · ${when}\n${line.summary}`;
	}

	const showRows = () => !loading() && !error() && lines().length > 0;

	return (
		<div class={s.container}>
			<Switch>
				<Match when={!repoPath() || !filePath()}>
					<EmptyState size="compact" title="Select a file to see who changed each line" />
				</Match>
				<Match when={loading()}>
					<EmptyState size="compact" loading title={"Loading blame…"} class={s.loading} />
				</Match>
				<Match when={isUntrackedBlameError(error() ?? "")}>
					<EmptyState size="compact" title="This file isn't tracked yet" />
				</Match>
				<Match when={error()}>
					{(message) => (
						<div class={s.errorLine} role="alert">
							<IconAlert size={14} class={s.errorIcon} />
							<span class={s.errorText}>{message()}</span>
						</div>
					)}
				</Match>
				<Match when={lines().length === 0}>
					<EmptyState size="compact" title="This file is empty" />
				</Match>
			</Switch>

			<div class={s.blameScroll} ref={scrollRef!}>
				<Show when={showRows()}>
					<div class={s.blameTable} style={{ height: `${virtualizer.getTotalSize()}px` }}>
						<For each={virtualizer.getVirtualItems()}>
							{(vItem) => {
								const line = () => lines()[vItem.index];
								return (
									<Show when={line()}>
										{(l) => {
											const groupStart = () => isGroupStart(vItem.index);
											return (
												<div
													class={cx(
														s.blameLine,
														groupStart() && vItem.index > 0 && s.blameLineGroupStart,
														highlightedHash() === l().hash && s.blameLineHighlighted,
													)}
													style={{ top: `${vItem.start}px` }}
												>
													<span
														class={s.gutter}
														title={groupStart() ? gutterTitle(l()) : undefined}
														onClick={() => setHighlightedHash((prev) => (prev === l().hash ? null : l().hash))}
													>
														<span class={s.ageBar} style={{ opacity: ageOpacity(ageFraction(l().author_time)) }} />
														<Show when={groupStart()}>
															<span class={s.gutterHash}>{l().hash.slice(0, 7)}</span>
															<span class={s.gutterAuthor}>{l().author}</span>
															<span class={s.gutterAge}>{shortAge(l().author_time)}</span>
														</Show>
													</span>
													<span class={s.lineNumber}>{l().line_number}</span>
													<span class={s.code}>{l().content}</span>
												</div>
											);
										}}
									</Show>
								);
							}}
						</For>
					</div>
				</Show>
			</div>
		</div>
	);
};

export default BlameTab;
