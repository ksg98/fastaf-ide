import { type Component, createSignal, For, type JSX, Show } from "solid-js";
import type { MessageActionReaction } from "../../types/messageActions";
import { cx } from "../../utils";
import {
	IconChat,
	IconCode,
	IconCopy,
	IconFork,
	IconHeart,
	IconMore,
	IconPartyPopper,
	type IconProps,
	IconQuote,
	IconThumbsDown,
	IconThumbsUp,
} from "../icons";
import { Button } from "../ui/Button";
import { Dropdown, type DropdownItem } from "../ui/Dropdown";
import { Textarea } from "../ui/Textarea";
import m from "./MessageMenu.module.css";

/** A reply quote: every line of the excerpt prefixed, then a blank line for the user's text. */
export function quoteMessage(text: string): string {
	return `${text
		.trim()
		.split("\n")
		.map((line) => (line ? `> ${line}` : ">"))
		.join("\n")}\n\n`;
}

// Terminal Chat retains its explicit draft feedback; AI Chat uses conversational message actions.
export type Reaction = "approve" | "disapprove";

/**
 * Response feedback as ordinary user text: the quote, the verdict, and an explicit statement that it
 * is not permission to run anything. It is drafted for the user to send, never sent by the menu.
 */
export function feedbackMessage(text: string, reaction: Reaction): string {
	const verdict = reaction === "approve" ? "I approve of this response." : "I disapprove of this response.";
	return `Feedback on your earlier response:\n${quoteMessage(text).trimEnd()}\n\n${verdict}\nThis is feedback on the response, not approval to execute an action.\n\n`;
}

export const REACTIONS: { id: MessageActionReaction; label: string; icon: (props: IconProps) => JSX.Element }[] = [
	{ id: "thumbs_up", label: "Thumbs up", icon: IconThumbsUp },
	{ id: "thumbs_down", label: "Thumbs down", icon: IconThumbsDown },
	{ id: "heart", label: "Heart", icon: IconHeart },
	{ id: "celebrate", label: "Celebrate", icon: IconPartyPopper },
];

/** Menu geometry (ui/Dropdown): 28px rows, a 9px divider, 4px padding and a hairline each side. */
const ROW = 28;
const DIVIDER = 9;
const FRAME = 10;

/** Quiet per-message actions: one trigger, a keyboard-complete menu. */
export const MessageMenu: Component<{
	/** "user" or "assistant": names the trigger. */
	role: "user" | "assistant";
	onCopy: () => void;
	/** Absent when the host has no composer to quote into. */
	onReply?: () => void;
	/** Absent unless the host has a composer and the message is a finished answer. */
	onReact?: (reaction: Reaction) => void;
	/** Absent for messages with no Markdown source to reveal. */
	actions?: {
		reactions: string[];
		disabled?: boolean;
		onReact: (reaction: MessageActionReaction, remove: boolean) => Promise<void>;
		onComment: (comment: string) => Promise<void>;
	};
	raw?: { shown: boolean; onToggle: () => void };
	/** Absent unless the host can start a new conversation from this message. */
	onFork?: () => void;
	/** Host class for the root: where the menu sits beside its message. */
	class?: string;
	/** Host class for the trigger: the host decides when a message reveals it. */
	triggerClass?: string;
	/** The menu edge that lines up with the trigger. "end" (default) suits a trigger at a message's right. */
	align?: "start" | "end";
	/** Where the menu opens while it fits there; it flips when it does not. Default "top". */
	prefer?: "top" | "bottom";
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	const [below, setBelow] = createSignal(false);
	const [commenting, setCommenting] = createSignal(false);
	const [comment, setComment] = createSignal("");
	const [pending, setPending] = createSignal(false);
	const [error, setError] = createSignal("");
	const perform = async (send: () => Promise<void>) => {
		if (pending()) return;
		setPending(true);
		setError("");
		try {
			await send();
			setCommenting(false);
			setComment("");
		} catch (failure) {
			// Match ACP describe(): desktop commands reject with a serialized message-bearing object.
			setError(String(failure && typeof failure === "object" && "message" in failure ? failure.message : failure));
		} finally {
			setPending(false);
		}
	};
	let commentInput: HTMLTextAreaElement | undefined;
	let trigger: HTMLButtonElement | undefined;
	let root: HTMLSpanElement | undefined;
	const close = () => {
		setOpen(false);
		// Return focus only from inside the menu (select, Escape); an outside click already placed it.
		const active = document.activeElement;
		if (
			!active ||
			active === document.body ||
			root?.contains(active) ||
			active.closest('[role="menu"][aria-label="Message actions"]')
		)
			trigger?.focus();
	};
	type Row = {
		id: string;
		label: string;
		icon?: (props: IconProps) => JSX.Element;
		divider?: true;
		disabled?: boolean;
	};
	/** The menu's rows as data. Icons are drawn from it where the menu renders, never in an event handler. */
	const rows = (): Row[] => {
		const actions = props.actions;
		const basic: Row[] = [
			{ id: "copy", label: "Copy message", icon: IconCopy },
			...(props.raw
				? [{ id: "raw", label: props.raw.shown ? "Show formatted message" : "Show raw Markdown", icon: IconCode }]
				: []),
			...(props.onReply ? [{ id: "reply", label: "Quote reply", icon: IconQuote }] : []),
			...(props.onFork ? [{ id: "fork", label: "Fork from here", icon: IconFork }] : []),
		];
		const feedback: Row[] = actions
			? [
					...REACTIONS.map((reaction) => ({
						id: reaction.id,
						label: `${actions.reactions.includes(reaction.id) ? "Remove " : ""}${reaction.label}`,
						icon: reaction.icon,
						disabled: pending() || actions.disabled,
					})),
					{ id: "comment", label: "Comment on message", icon: IconChat, disabled: pending() || actions.disabled },
				]
			: props.onReact
				? [
						{ id: "approve", label: "Approve response", icon: IconThumbsUp },
						{ id: "disapprove", label: "Disapprove response", icon: IconThumbsDown },
					]
				: [];
		return feedback.length ? [...basic, { id: "feedback", label: "", divider: true }, ...feedback] : basic;
	};
	const items = (): DropdownItem[] =>
		rows().map((row) => ({
			id: row.id,
			label: row.label,
			divider: row.divider,
			disabled: row.disabled,
			icon: row.icon ? <row.icon /> : undefined,
		}));
	const select = (id: string) => {
		const reaction = REACTIONS.find((item) => item.id === id);
		if (reaction && props.actions) {
			const actions = props.actions;
			const remove = actions.reactions.includes(reaction.id);
			void perform(() => actions.onReact(reaction.id, remove));
		} else if (id === "comment") {
			setCommenting(true);
			queueMicrotask(() => commentInput?.focus());
		} else if (id === "copy") props.onCopy();
		else if (id === "raw") props.raw?.onToggle();
		else if (id === "reply") props.onReply?.();
		else if (id === "fork") props.onFork?.();
		else if (id === "approve" || id === "disapprove") props.onReact?.(id);
		close();
	};
	const toggle = () => {
		if (!open()) {
			const height = rows().reduce((sum, row) => sum + (row.divider ? DIVIDER : ROW), FRAME);
			const rect = trigger?.getBoundingClientRect();
			const above = rect?.top ?? Number.POSITIVE_INFINITY;
			const under = window.innerHeight - (rect?.bottom ?? 0);
			// Near an edge of the viewport the menu opens toward the room it has instead of being clipped.
			setBelow(props.prefer === "bottom" ? under >= height + 8 || above < height : above < height);
		}
		setOpen(!open());
	};
	/** `Dropdown` lines its right edge up with the anchor's: for "start" the anchor is widened to the menu. */
	const anchor = (): DOMRect | undefined => {
		const rect = trigger?.getBoundingClientRect();
		if (!rect || props.align !== "start") return rect;
		const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Message actions"]');
		const width = Math.max(rect.width, menu?.getBoundingClientRect().width ?? 0);
		return {
			x: rect.left,
			y: rect.top,
			left: rect.left,
			top: rect.top,
			right: rect.left + width,
			bottom: rect.bottom,
			width,
			height: rect.height,
			toJSON: () => ({}),
		};
	};
	return (
		<span ref={root} class={cx(m.root, props.class)} data-open={open() || undefined}>
			<button
				ref={trigger}
				type="button"
				class={cx(m.trigger, props.triggerClass)}
				aria-label={`${props.role === "user" ? "User" : "Assistant"} message actions`}
				aria-haspopup="menu"
				aria-expanded={open()}
				onClick={toggle}
			>
				<IconMore />
			</button>
			<Dropdown
				aria-label="Message actions"
				anchor={anchor}
				items={items()}
				visible={open()}
				class={m.menu}
				position={below() ? "bottom" : "top"}
				onSelect={select}
				onClose={close}
			/>
			<For each={REACTIONS.filter((reaction) => props.actions?.reactions.includes(reaction.id))}>
				{(reaction) => (
					<button
						type="button"
						class={m.reaction}
						disabled={pending() || props.actions?.disabled}
						aria-pressed="true"
						aria-label={`Remove ${reaction.label} reaction`}
						title={`${reaction.label}: sent to the conversation. Click to remove.`}
						onClick={() => {
							const actions = props.actions;
							if (actions) void perform(() => actions.onReact(reaction.id, true));
						}}
					>
						<reaction.icon />
					</button>
				)}
			</For>
			<Show when={commenting()}>
				<div class={m.comment} role="region" aria-label="Comment on message">
					<Textarea
						ref={(node) => {
							commentInput = node;
						}}
						aria-label="Comment on this message"
						value={comment()}
						onInput={(event) => setComment(event.currentTarget.value)}
						autofocus
					/>
					<small class={m.commentHint}>
						Sent to this conversation when the agent is ready. Not an evaluation or authorization.
					</small>
					<div class={m.commentActions}>
						<Button
							type="button"
							variant="ghost"
							size="compact"
							disabled={pending()}
							onClick={() => {
								setCommenting(false);
								trigger?.focus();
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							size="compact"
							disabled={pending() || props.actions?.disabled || !comment().trim()}
							onClick={() => {
								const actions = props.actions;
								if (actions) void perform(() => actions.onComment(comment()));
							}}
						>
							Send comment
						</Button>
					</div>
				</div>
			</Show>
			<Show when={pending()}>
				<span class={m.note} role="status">
					Sending…
				</span>
			</Show>
			<Show when={error()}>
				<span class={cx(m.note, m.noteError)} role="alert">
					{error()}
				</span>
			</Show>
		</span>
	);
};
