import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { drawSelection, EditorView, keymap } from "@codemirror/view";
import { createCodeMirror } from "solid-codemirror";
import { type Accessor, type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import type { QueuedCommand } from "../../hooks/usePty";
import { isMacOS } from "../../platform";
import { cx } from "../../utils";
import { passThroughMacSystemKeys } from "../../utils/macSystemKeys";
import s from "./ComposePanel.module.css";

const composeTheme = EditorView.theme(
	{
		"&": {
			width: "100%",
			height: "100%",
			fontSize: "13px",
			background: "var(--bg-primary)",
		},
		".cm-scroller": {
			fontFamily: "var(--font-mono)",
			overflow: "auto",
		},
		".cm-content": {
			caretColor: "var(--accent)",
			padding: "8px 12px",
		},
		".cm-cursor, .cm-dropCursor": {
			borderLeftColor: "var(--accent)",
		},
		"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
			backgroundColor: "rgba(122, 162, 247, 0.2)",
		},
		".cm-activeLine": {
			backgroundColor: "transparent",
		},
		"&.cm-focused": {
			outline: "none",
		},
	},
	{ dark: true },
);

export interface ComposePanelProps {
	isOpen: Accessor<boolean>;
	initialText: Accessor<string>;
	onClose: () => void;
	onSend: (text: string) => void | Promise<void>;
	/** Hand the text to the backend's idle gate instead of typing it now. */
	onEnqueue: (text: string) => void | Promise<void>;
	/** False for a plain shell: only an agent has a composer worth waiting for. */
	canEnqueue: Accessor<boolean>;
	/** Commands already waiting for this session's next idle window. */
	queuedCount: Accessor<number>;
	onClearQueue: () => void | Promise<void>;
	/** Read the queued commands themselves — only called while the list is open. */
	onLoadQueue: () => Promise<QueuedCommand[]>;
	/** Drop a single queued command by id. */
	onRemoveQueued: (id: number) => void | Promise<void>;
	onTextChange?: (text: string) => void;
}

export const ComposePanel: Component<ComposePanelProps> = (props) => {
	const { ref, editorView, createExtension } = createCodeMirror({
		onValueChange: (value) => props.onTextChange?.(value),
	});

	createExtension(composeTheme);
	createExtension(drawSelection());
	createExtension(history());
	createExtension(EditorView.lineWrapping);
	createExtension(
		keymap.of([
			// Shift first: CodeMirror matches the more specific binding, so plain
			// Ctrl-Enter keeps sending immediately.
			{
				key: "Shift-Ctrl-Enter",
				run: (view) => {
					const text = view.state.doc.toString().trim();
					if (text && props.canEnqueue()) props.onEnqueue(text);
					return true;
				},
			},
			{
				key: "Ctrl-Enter",
				run: (view) => {
					const text = view.state.doc.toString().trim();
					if (text) props.onSend(text);
					return true;
				},
			},
			{
				key: "Escape",
				run: () => {
					props.onClose();
					return true;
				},
			},
			...defaultKeymap,
			...historyKeymap,
		]),
	);

	// Re-initialise content only when the panel opens — NOT on every keystroke.
	// Tracking initialText() here would re-run on every user keystroke (since
	// onTextChange feeds back into the same signal), causing a 2-RAF delay loop
	// that overwrites the current content with content from ~32ms ago (ghost text).
	createEffect(
		on(props.isOpen, (open) => {
			if (!open) return;
			// Read initialText outside reactive tracking — we only want the value
			// at open time, not to subscribe to further changes while typing.
			const initial = props.initialText();
			let inner = 0;
			const outer = requestAnimationFrame(() => {
				inner = requestAnimationFrame(() => {
					const view = editorView();
					if (!view) return;
					const current = view.state.doc.toString();
					if (current !== initial) {
						view.dispatch({
							changes: { from: 0, to: view.state.doc.length, insert: initial },
							selection: { anchor: initial.length },
						});
					}
					view.focus();
				});
			});
			// Closing (or unmounting) before the second frame lands would otherwise
			// dispatch into a destroyed view.
			onCleanup(() => {
				cancelAnimationFrame(outer);
				if (inner) cancelAnimationFrame(inner);
			});
		}),
	);

	createEffect(() => {
		if (!props.isOpen()) return;
		const handleFocusOut = (e: FocusEvent) => {
			const related = e.relatedTarget as Node | null;
			const panel = editorView()?.dom?.closest(`.${s.panel}`);
			if (related && panel?.contains(related)) return;
			requestAnimationFrame(() => {
				if (props.isOpen()) editorView()?.focus();
			});
		};
		const cmDom = editorView()?.dom;
		cmDom?.addEventListener("focusout", handleFocusOut);
		onCleanup(() => cmDom?.removeEventListener("focusout", handleFocusOut));
	});

	// The badge count comes from the cheap lifecycle poll; the texts cost an IPC
	// round-trip, so they are fetched only while the list is expanded — and
	// re-fetched whenever the count moves under it (the queue drains on idle).
	const [queueOpen, setQueueOpen] = createSignal(false);
	const [queueItems, setQueueItems] = createSignal<QueuedCommand[]>([]);

	createEffect(() => {
		if (!queueOpen()) return;
		const count = props.queuedCount();
		if (count === 0) {
			setQueueOpen(false);
			setQueueItems([]);
			return;
		}
		void props.onLoadQueue().then(setQueueItems);
	});

	createEffect(() => {
		if (!props.isOpen()) setQueueOpen(false);
	});

	const currentText = (): string => editorView()?.state.doc.toString().trim() ?? "";

	const handleSend = () => {
		const text = currentText();
		if (text) props.onSend(text);
	};

	const handleEnqueue = () => {
		const text = currentText();
		if (text && props.canEnqueue()) props.onEnqueue(text);
	};

	return (
		<div class={cx(s.panel, props.isOpen() && s.panelOpen)} onMouseDown={(e) => e.stopPropagation()}>
			<div
				class={s.editor}
				ref={(el) => {
					// Same macOS system-combo yield as the code editor (see macSystemKeys).
					onCleanup(passThroughMacSystemKeys(el, isMacOS()));
					ref(el);
				}}
			/>
			<div class={s.editor} ref={ref} />
			<Show when={queueOpen() && props.queuedCount() > 0}>
				<div class={s.queueList}>
					<div class={s.queueListHeader}>
						<span>Waiting for the agent to go idle</span>
						<button class={s.queueClearAll} onClick={() => props.onClearQueue()}>
							Clear all
						</button>
					</div>
					<For each={queueItems()}>
						{(item) => (
							<div class={s.queueItem}>
								<span class={s.queueItemText} title={item.text}>
									{item.text}
								</span>
								<button
									class={s.queueItemRemove}
									onClick={() => props.onRemoveQueued(item.id)}
									title="Remove from queue"
									aria-label="Remove from queue"
								>
									<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
										<path d="M4.3 3.3l8.4 8.4-1 1-8.4-8.4zM12.7 4.3l-8.4 8.4-1-1 8.4-8.4z" />
									</svg>
								</button>
							</div>
						)}
					</For>
				</div>
			</Show>
			<div class={s.statusBar}>
				<span>Ctrl+Enter to send &middot; {props.canEnqueue() ? "Shift+Ctrl+Enter to queue · " : ""}Esc to close</span>
				<div class={s.actions}>
					<Show when={props.queuedCount() > 0}>
						<button
							class={cx(s.queueBadge, queueOpen() && s.queueBadgeOpen)}
							onClick={() => setQueueOpen(!queueOpen())}
							title="Waiting for the agent to go idle — click to review"
							aria-expanded={queueOpen()}
						>
							{props.queuedCount()} queued
							<svg
								width="10"
								height="10"
								viewBox="0 0 16 16"
								fill="currentColor"
								aria-hidden="true"
								class={cx(s.queueChevron, queueOpen() && s.queueChevronOpen)}
							>
								<path d="M8 11L3 5h10z" />
							</svg>
						</button>
					</Show>
					<Show when={props.canEnqueue()}>
						<button
							class={s.queueButton}
							onClick={handleEnqueue}
							title="Queue for the next idle moment (Shift+Ctrl+Enter)"
						>
							<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
								<path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h8v2H2z" />
							</svg>
						</button>
					</Show>
					<button class={s.sendButton} onClick={handleSend} title="Send (Ctrl+Enter)">
						<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
							<path d="M4 2l10 6-10 6V2z" />
						</svg>
					</button>
				</div>
			</div>
		</div>
	);
};
