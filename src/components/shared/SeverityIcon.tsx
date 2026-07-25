import type { Component } from "solid-js";
import type { Severity } from "../../stores/aiTriageStore";
import { cx } from "../../utils";
import s from "./SeverityIcon.module.css";

const SEVERITY_CLASS: Record<Severity, string> = {
	bug: s.bug,
	risk: s.risk,
	nit: s.nit,
};

const SEVERITY_PATH: Record<Severity, string> = {
	bug: "M8 1.5 15 14H1L8 1.5Zm0 4L4.8 12h6.4L8 5.5ZM7.25 7h1.5v3h-1.5V7Zm0 4h1.5v1.5h-1.5V11Z",
	risk: "M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13ZM7.25 4.5v4.25h1.5V4.5h-1.5Zm0 5.5v1.5h1.5V10h-1.5Z",
	nit: "M3 2.5h10v1.4L8.8 8l4.2 4.1v1.4H3v-1.4L7.2 8 3 3.9V2.5Zm3 1.5 2 2 2-2H6Zm2 6-2 2h4l-2-2Z",
};

/**
 * Monochrome severity glyph shared by the working-tree triage panel and the PR
 * review popover. `fill="currentColor"` — color comes from the severity class.
 */
export const SeverityIcon: Component<{ severity: Severity; class?: string }> = (props) => (
	<svg class={cx(s.icon, SEVERITY_CLASS[props.severity], props.class)} viewBox="0 0 16 16" aria-hidden="true">
		<path fill="currentColor" d={SEVERITY_PATH[props.severity]} />
	</svg>
);
