import { type Component, Show } from "solid-js";
import { cx } from "../../utils";
import s from "./CountBadge.module.css";

export type CountBadgeTone = "accent" | "error" | "success";

export interface CountBadgeProps {
	count: number;
	tone?: CountBadgeTone;
}

/**
 * Counter on the top-right corner of an icon button. The button must be
 * `position: relative`. Status bar toggles and the sidebar footer share it, so
 * the same idea keeps one size, shape and offset across the window.
 */
export const CountBadge: Component<CountBadgeProps> = (props) => (
	<Show when={props.count > 0}>
		<span class={cx(s.countBadge, s[props.tone ?? "accent"])}>{props.count}</span>
	</Show>
);
