import { type Component, createEffect, createMemo, For, on, Show } from "solid-js";
import { stripAnswerMarkers } from "../../utils/stripAnswerMarkers";
import type { AnswersTurn } from "./answersTurn";

interface AnswersPanelProps {
	view: readonly AnswersTurn[];
	fontFamily: string;
	fontSize: number;
}

/** Distance from the bottom, in px, within which the panel still follows new content. */
const STICK_SLACK_PX = 8;

/**
 * The answers-only view: an opaque layer over the terminal canvas with every user
 * prompt of the session in full, each followed by the 💬 answers of its turn; a turn
 * without a 💬 answer is left out. Plain
 * DOM text, so it is selectable and copyable. It opens at the newest entry and keeps
 * following it until the user scrolls up.
 */
export const AnswersPanel: Component<AnswersPanelProps> = (props) => {
	let panel!: HTMLDivElement;
	let stickToBottom = true;
	const answered = createMemo(() => props.view.filter((turn) => turn.answers.length > 0));
	createEffect(
		on(answered, () => {
			if (stickToBottom) panel.scrollTop = panel.scrollHeight;
		}),
	);
	return (
		<div
			ref={panel}
			data-answers-only
			onScroll={() => {
				stickToBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight <= STICK_SLACK_PX;
			}}
			style={{
				position: "absolute",
				inset: "0",
				"z-index": "30",
				overflow: "auto",
				background: "var(--bg-secondary)",
				color: "var(--fg-primary)",
				"font-family": props.fontFamily,
				"font-size": `${props.fontSize}px`,
				"line-height": "1.4",
				padding: "8px 12px",
				"white-space": "pre-wrap",
				"overflow-wrap": "anywhere",
				"user-select": "text",
				"-webkit-user-select": "text",
				cursor: "text",
			}}
		>
			<For
				each={answered()}
				fallback={
					<div role="status" style={{ color: "var(--fg-muted)" }}>
						No marked answers in the retained terminal history.
					</div>
				}
			>
				{(turn) => (
					<div data-turn style={{ "margin-bottom": "14px" }}>
						<Show when={turn.prompt}>
							{(prompt) => (
								<div data-prompt style={{ color: "var(--fg-muted)", "margin-bottom": "8px" }}>
									{prompt()}
								</div>
							)}
						</Show>
						<For each={turn.answers}>
							{(answer) => (
								<div
									data-answer
									style={{
										padding: "2px 0 2px 8px",
										"margin-bottom": "6px",
										"border-left": "3px solid var(--answer-rule)",
									}}
								>
									{stripAnswerMarkers(answer)}
								</div>
							)}
						</For>
					</div>
				)}
			</For>
		</div>
	);
};
