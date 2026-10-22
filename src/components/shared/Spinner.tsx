import type { Component } from "solid-js";
import { cx } from "../../utils";
import s from "./Spinner.module.css";

export interface SpinnerProps {
	/** Diameter in px (default 14). */
	size?: number;
	class?: string;
}

/**
 * The one busy indicator for side panels: a thin ring in `currentColor` with
 * one bright arc, so it takes the colour of the text it replaces (a muted
 * label, the dark text of a bright button). Decorative — the surrounding text
 * says what is happening ("Committing…", "Loading commits…").
 */
export const Spinner: Component<SpinnerProps> = (props) => {
	const size = () => `${props.size ?? 14}px`;
	return (
		<span class={cx(s.loadingSpinner, props.class)} style={{ width: size(), height: size() }} aria-hidden="true" />
	);
};

export default Spinner;
