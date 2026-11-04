import { type Component, createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { registerModal } from "../../stores/modalStack";
import d from "../shared/dialog.module.css";

export interface ConfirmDialogProps {
	visible: boolean;
	title: string;
	message: string;
	confirmLabel?: string;
	cancelLabel?: string;
	/** Optional middle button (e.g. "Don't Save"). Rendered only when set. */
	discardLabel?: string;
	discardDanger?: boolean;
	discardDisabled?: boolean;
	archiveChecklist?: import("../../stores/workspaceIdentity").ArchiveChecklist;
	workspaceName?: string;
	kind?: "warning" | "info" | "error";
	/** Which button Enter activates. Defaults to "confirm". */
	defaultButton?: "confirm" | "cancel";
	/** When set, auto-clicks the cancel button after this many ms, showing a countdown on its label. */
	autoCancelMs?: number;
	/** When set, confirms after this many ms, showing a countdown on the confirm label. */
	autoConfirmMs?: number;
	onClose: () => void;
	onConfirm: () => void;
	/** Invoked when the middle discard button is clicked. */
	onDiscard?: () => void;
}

/**
 * In-app confirmation dialog — replaces native Tauri ask() dialogs
 * which render as ugly light-mode macOS system sheets.
 * Uses shared dialog CSS module for consistent dark-theme styling.
 */
export const ConfirmDialog: Component<ConfirmDialogProps> = (props) => {
	// Countdown until the configured automatic action.
	const [remaining, setRemaining] = createSignal<number | null>(null);
	let countdownTimer: ReturnType<typeof setInterval> | undefined;
	const stopCountdown = () => {
		if (countdownTimer !== undefined) clearInterval(countdownTimer);
		countdownTimer = undefined;
		setRemaining(null);
	};
	const close = () => {
		stopCountdown();
		props.onClose();
	};
	const confirm = () => {
		stopCountdown();
		props.onConfirm();
	};

	createEffect(() => {
		const duration = props.autoConfirmMs ?? props.autoCancelMs;
		if (!props.visible || !duration || duration <= 0) {
			setRemaining(null);
			return;
		}
		let left = Math.ceil(duration / 1000);
		setRemaining(left);
		countdownTimer = setInterval(() => {
			left -= 1;
			setRemaining(left);
			if (left <= 0) {
				if (props.autoConfirmMs) confirm();
				else close();
			}
		}, 1000);
		onCleanup(stopCountdown);
	});

	createEffect(() => {
		if (!props.visible) return;

		// Escape-to-close is handled centrally (stores/modalStack): registering routes
		// Escape to props.onClose AND stops it reaching the terminal underneath.
		registerModal(close);

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				// Enter activates the configured default button. Destructive dialogs
				// point it at Cancel so an accidental Enter takes the safe path.
				if ((props.defaultButton ?? "confirm") === "cancel") {
					close();
				} else {
					confirm();
				}
			}
		};

		document.addEventListener("keydown", handleKeydown);
		onCleanup(() => document.removeEventListener("keydown", handleKeydown));
	});

	// Portalled to <body>: `.overlay` is position: fixed / inset: 0, but dialogs are
	// rendered inside their owning panel, and the glass panels carry
	// `backdrop-filter` — which makes an element the containing block for fixed
	// descendants. Left in place, the scrim covered only the panel and the panel's
	// `overflow: hidden` clipped the dialog to a 300px column instead of centering
	// it on the window. See ContextMenu for the same fix.
	return (
		<Show when={props.visible}>
			<Portal>
				<div class={d.overlay} onClick={close}>
					<div
						class={d.popover}
						classList={{ [d.checklistPopover]: !!props.archiveChecklist }}
						role="dialog"
						aria-label={props.title}
						onClick={(e) => e.stopPropagation()}
					>
						<div class={d.header}>
							<h4>{props.title}</h4>
						</div>
						<div class={d.body}>
							<Show when={props.archiveChecklist}>
								{(checklist) => (
									<>
										<p class={d.workspaceName}>{props.workspaceName}</p>
										<ul class={d.checklist}>
											<For each={checklist().checks}>
												{(check) => (
													<li data-passed={check.passed}>
														<svg
															viewBox="0 0 16 16"
															aria-label={check.passed ? "Pass" : "Fail"}
															role="img"
															fill="currentColor"
														>
															<path
																d={
																	check.passed
																		? "M6 12 2 8l1.5-1.5L6 9l6.5-6.5L14 4z"
																		: "m4 2 4 4 4-4 2 2-4 4 4 4-2 2-4-4-4 4-2-2 4-4-4-4z"
																}
															/>
														</svg>
														<span>{check.label}</span>
													</li>
												)}
											</For>
										</ul>
										<div class={d.checklistExplanation}>
											<div>
												<strong>Archive</strong>: {checklist().archive_explanation}
											</div>
											<div classList={{ [d.checklistFailure]: !checklist().can_delete }}>
												<strong>{checklist().can_delete ? "Delete" : "Delete is off"}</strong>:{" "}
												{checklist().delete_explanation}
											</div>
										</div>
									</>
								)}
							</Show>
							<Show when={!props.archiveChecklist}>
								<p
									style={{
										margin: 0,
										"white-space": "pre-line",
										"overflow-wrap": "anywhere",
										color: "var(--fg-secondary)",
										"font-size": "var(--font-md)",
									}}
								>
									{props.message}
								</p>
							</Show>
						</div>
						<div class={d.actions}>
							<button type="button" class={d.cancelBtn} onClick={close}>
								{props.cancelLabel ?? "Cancel"}
								{props.autoCancelMs && remaining() !== null ? ` (${remaining()})` : ""}
							</button>
							<Show when={props.discardLabel}>
								<button
									type="button"
									class={props.discardDanger ? d.dangerBtn : d.cancelBtn}
									disabled={props.discardDisabled}
									onClick={() => {
										if (!props.discardDisabled) props.onDiscard?.();
									}}
								>
									{props.discardLabel}
								</button>
							</Show>
							<button type="button" class={d.primaryBtn} onClick={confirm}>
								{props.confirmLabel ?? "OK"}
								{props.autoConfirmMs && remaining() !== null ? ` (${remaining()})` : ""}
							</button>
						</div>
					</div>
				</div>
			</Portal>
		</Show>
	);
};

export default ConfirmDialog;
