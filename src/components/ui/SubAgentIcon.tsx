import type { Component } from "solid-js";

/** Shared marker for a PTY spawned by another agent. */
export const SubAgentIcon: Component<{
	parent: string;
	class?: string;
	iconClass?: string;
}> = (props) => (
	<span class={props.class} role="img" aria-label={`Spawned by ${props.parent}`} title={`Spawned by ${props.parent}`}>
		<svg class={props.iconClass} viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
			<path d="M7.25 1h1.5v2H12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.25V1zM4 4.5a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h8a.5.5 0 0 0 .5-.5V5a.5.5 0 0 0-.5-.5H4zm1.5 2h1.75v1.75H5.5V6.5zm3.25 0h1.75v1.75H8.75V6.5zM6 9.5h4V11H6V9.5zM0 6.5h1V10H0V6.5zm15 0h1V10h-1V6.5zM5 14h6v1.5H5V14z" />
		</svg>
	</span>
);
