import { type Accessor, type Component, createSignal } from "solid-js";
import { cx } from "../../utils";
import s from "./LastPromptBar.module.css";

export interface LastPromptBarProps {
	intent: Accessor<string | null>;
	ptyDescription: Accessor<string | null>;
	prompt: Accessor<string | null>;
}

const Chevron = () => (
	<svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
		<path
			d="M2 3.5l3 3 3-3"
			fill="none"
			stroke="currentColor"
			stroke-width="1.3"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
);

export const LastPromptBar: Component<LastPromptBarProps> = (props) => {
	const [expanded, setExpanded] = createSignal(false);
	const hasIntent = () => Boolean(props.intent());
	const hasPtyDescription = () => Boolean(props.ptyDescription());
	const hasPrompt = () => Boolean(props.prompt());
	const preview = () =>
		[
			hasIntent() ? `Intent: ${props.intent()}` : null,
			hasPtyDescription() ? `Assignment: ${props.ptyDescription()}` : null,
			hasPrompt() ? `Prompt: ${props.prompt()}` : null,
		]
			.filter(Boolean)
			.join(" · ");

	const toggle = (e: MouseEvent) => {
		e.stopPropagation();
		setExpanded((v) => !v);
	};

	return (
		<div
			class={cx(s.bar, expanded() ? s.expanded : s.collapsed)}
			onClick={toggle}
			title={expanded() ? "Click to collapse" : "Click to expand"}
		>
			<div class={s.header}>
				<span class={s.label}>Context</span>
				<span class={s.preview}>{expanded() ? "" : preview()}</span>
				<span class={cx(s.chevron, expanded() && s.chevronUp)}>
					<Chevron />
				</span>
			</div>
			{expanded() && (
				<div class={s.body}>
					{hasIntent() && (
						<div class={s.section}>
							<span class={s.bodyLabel}>Intent</span>
							<div>{props.intent()}</div>
						</div>
					)}
					{hasPtyDescription() && (
						<div class={s.section}>
							<span class={s.bodyLabel}>Assignment</span>
							<div>{props.ptyDescription()}</div>
						</div>
					)}
					{hasPrompt() && (
						<div class={s.section}>
							<span class={s.bodyLabel}>Prompt</span>
							<div>{props.prompt()}</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
};
