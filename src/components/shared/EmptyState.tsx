import { type Component, type JSX, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { cx } from "../../utils";
import type { IconProps } from "../icons";
import s from "./EmptyState.module.css";
import { Spinner } from "./Spinner";

export interface EmptyStateProps {
	/** A stroke icon from components/icons, drawn at 24px in --fg-muted (--error for errors). */
	icon?: (props: IconProps) => JSX.Element;
	/** Sentence case, says what is (not) here: "No changes", "Loading commits…". */
	title: string;
	/** One short line that says why, or what to do next. */
	description?: JSX.Element;
	/** At most one control under the text (a 28px button). */
	action?: JSX.Element;
	/** A spinner in place of the icon; the title becomes a muted status line. */
	loading?: boolean;
	/** "error": red icon, and the description keeps the error text's line breaks and is selectable. */
	tone?: "default" | "error";
	/**
	 * "default" grows to fill a flex column and centres itself a little above the
	 * middle; "compact" is a short block for drawers (no icon, muted 12px line).
	 */
	size?: "default" | "compact";
	class?: string;
}

/**
 * What a side panel shows when it has nothing, is fetching, or failed — a
 * shape (icon, title, one line of help) rather than a lone grey word. Put it
 * in a `display: flex; flex-direction: column` parent so it can fill the space.
 */
export const EmptyState: Component<EmptyStateProps> = (props) => {
	const compact = () => props.size === "compact";
	return (
		<div
			class={cx(
				s.emptyState,
				compact() && s.emptyStateCompact,
				props.loading && s.emptyStateLoading,
				props.tone === "error" && s.emptyStateError,
				props.class,
			)}
			role={props.loading ? "status" : props.tone === "error" ? "alert" : undefined}
		>
			<Show
				when={props.loading}
				fallback={
					<Show when={!compact() && props.icon}>
						{(icon) => <Dynamic component={icon()} size={24} stroke={1.5} class={s.emptyIcon} />}
					</Show>
				}
			>
				<Spinner size={compact() ? 14 : 16} class={s.emptyIcon} />
			</Show>
			<div class={s.emptyTitle}>{props.title}</div>
			<Show when={props.description}>
				<div class={s.emptyDescription}>{props.description}</div>
			</Show>
			<Show when={props.action}>
				<div class={s.emptyAction}>{props.action}</div>
			</Show>
		</div>
	);
};

export default EmptyState;
