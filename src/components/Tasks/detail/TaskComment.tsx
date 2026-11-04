import { For, Show } from "solid-js";
import type { WorkItemComment, WorkItemCommentEntry } from "../../../types/work-items.gen";
import { hidesOriginal, OriginalComment, ReviewFindingView } from "../../shared/ReviewFindingView";
import { TaskMarkdown } from "./TaskMarkdown";
import styles from "./TasksDetail.module.css";

function Comment(props: { comment: WorkItemComment; collapsed?: boolean }) {
	return (
		<article class={styles.comment}>
			<header class={styles.commentHeader}>
				<strong>
					{props.comment.author.name}
					<Show when={props.comment.author.bot}>
						<span class={styles.botBadge}>bot</span>
					</Show>
				</strong>
				<time dateTime={props.comment.createdAt}>{new Date(props.comment.createdAt).toLocaleString()}</time>
			</header>
			<OriginalComment collapsed={props.collapsed ?? false}>
				<TaskMarkdown content={props.comment.body} />
			</OriginalComment>
		</article>
	);
}

export function TaskComment(props: { entry: WorkItemCommentEntry }) {
	const normal = () => (props.entry.kind === "normal" ? props.entry.value : undefined);
	const thread = () => (props.entry.kind === "review_thread" ? props.entry.value : undefined);
	const summary = () => (props.entry.kind === "review_summary" ? props.entry.value : undefined);
	return (
		<>
			<Show when={normal()}>{(comment) => <Comment comment={comment()} />}</Show>
			<Show when={thread()}>
				{(value) => (
					<section class={styles.thread} aria-label="Review thread">
						<header>
							{value().path}
							{value().line !== null
								? `:${value().line}`
								: value().originalLine !== null
									? `:${value().originalLine}`
									: ""}
							{value().outdated ? " · Outdated" : ""} · {value().resolved ? "Resolved" : "Open thread"}
						</header>
						<Show when={value().finding}>{(finding) => <ReviewFindingView finding={finding()} />}</Show>
						<For each={value().comments.map((comment) => comment.id)}>
							{(id, index) => {
								const comment = () => value().comments.find((entry) => entry.id === id);
								const collapsed = () => index() === 0 && hidesOriginal(value().finding);
								return <Show when={comment()}>{(entry) => <Comment comment={entry()} collapsed={collapsed()} />}</Show>;
							}}
						</For>
					</section>
				)}
			</Show>
			<Show when={summary()}>
				{(value) => (
					<section class={styles.thread} aria-label="Review summary">
						<header>Review · {value().state}</header>
						<Comment comment={value().comment} />
					</section>
				)}
			</Show>
		</>
	);
}
