import { type Component, createMemo, Show } from "solid-js";
import { cx } from "../../utils";
import { IconChevronRight } from "../icons";
import s from "./FastAFChatPanel.module.css";

/** A notice's first line, and whatever follows it. */
export function splitNotice(text: string): { head: string; rest: string } {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return end < 0
		? { head: trimmed, rest: "" }
		: { head: trimmed.slice(0, end).trimEnd(), rest: trimmed.slice(end + 1).trim() };
}

/**
 * Text of a notice row in FastAF's chat thread: an error, a stopped run, a
 * system message. A long one (a provider's error body, a summary) shows its
 * first line and the rest opens on click; a one-line notice is plain text that
 * wraps, so nothing is ever cut off without a way to read it.
 */
export const NoticeText: Component<{ text: string; class?: string }> = (props) => {
	const split = createMemo(() => splitNotice(props.text));
	return (
		<Show when={split().rest} fallback={<span class={cx(s.noticeText, props.class)}>{split().head}</span>}>
			<details class={cx(s.noticeDetails, props.class)}>
				<summary class={s.noticeSummary}>
					<span class={s.noticeChevron}>
						<IconChevronRight size={12} stroke={2} />
					</span>
					<span class={s.noticeText}>{split().head}</span>
				</summary>
				<div class={s.noticeRest}>{split().rest}</div>
			</details>
		</Show>
	);
};
