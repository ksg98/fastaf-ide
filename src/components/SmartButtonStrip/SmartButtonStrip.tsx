import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { useSmartPrompts } from "../../hooks/useSmartPrompts";
import { appLogger } from "../../stores/appLogger";
import { promptLibraryStore, type SavedPrompt, type SmartPlacement } from "../../stores/promptLibrary";
import { cx } from "../../utils";
import { IconCheck, IconChevronDown, IconSparkle } from "../icons";
import { Spinner } from "../shared/Spinner";
import s from "./SmartButtonStrip.module.css";

export interface SmartButtonStripProps {
	placement: SmartPlacement;
	repoPath: string;
	/** Default prompt ID to show in the main button (before user picks one) */
	defaultPromptId?: string;
	extraFilter?: (p: SavedPrompt) => boolean;
	/** Called with error message when a prompt fails */
	onError?: (msg: string) => void;
	/** Called when busy state changes (for parent spinner/state) */
	onBusyChange?: (busy: boolean) => void;
	/** Extra context variables to pass as manualVariables to executeSmartPrompt */
	contextVariables?: () => Record<string, string>;
	/**
	 * "split" (default): the bordered split button the sidebar and the PR popover use.
	 * "chip": a ghost split chip for side-panel control rows (the commit composer, the
	 * Branches context strip) — no icon, a label that ellipsises first when the row is
	 * tight, and an overlay menu right-aligned under it.
	 */
	appearance?: "split" | "chip";
	/** Extra class on the root element (layout only: flex weights, margins). */
	class?: string;
}

/** Translate internal error codes into user-friendly messages */
function friendlyError(result: { reason?: string; output?: string }, promptName: string): string {
	if (result.reason === "unresolved_variables" && result.output) {
		try {
			const vars = JSON.parse(result.output) as string[];
			if (vars.includes("staged_diff")) return "Stage some files first — no staged changes to analyze";
			return `Missing context: ${vars.join(", ")}`;
		} catch {
			/* fall through */
		}
	}
	return result.reason ?? `"${promptName}" failed`;
}

export const SmartButtonStrip: Component<SmartButtonStripProps> = (props) => {
	const { canExecute, executeSmartPrompt } = useSmartPrompts();
	const [menuOpen, setMenuOpen] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	let rootRef: HTMLDivElement | undefined;
	const chip = () => props.appearance === "chip";

	// Close dropdown on click outside
	const handleClickOutside = (e: MouseEvent) => {
		if (menuOpen() && rootRef && !rootRef.contains(e.target as Node)) {
			setMenuOpen(false);
		}
	};
	document.addEventListener("mousedown", handleClickOutside);
	onCleanup(() => document.removeEventListener("mousedown", handleClickOutside));

	// Esc closes an open menu and goes no further (captured on window, so no panel
	// or global shortcut treats the same press as its own Esc).
	createEffect(() => {
		if (!menuOpen()) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setMenuOpen(false);
		};
		window.addEventListener("keydown", onKey, true);
		onCleanup(() => window.removeEventListener("keydown", onKey, true));
	});

	const prompts = createMemo(() => {
		const all = promptLibraryStore.getSmartByPlacement(props.placement);
		return props.extraFilter ? all.filter(props.extraFilter) : all;
	});

	/** Most recently used prompt for this placement, or the configured default */
	const activePrompt = createMemo((): SavedPrompt | undefined => {
		const all = prompts();
		if (all.length === 0) return undefined;
		const recent = promptLibraryStore.state.recentIds;
		const allIds = new Set(all.map((p) => p.id));
		for (const id of recent) {
			if (allIds.has(id)) return all.find((p) => p.id === id);
		}
		if (props.defaultPromptId) {
			const def = all.find((p) => p.id === props.defaultPromptId);
			if (def) return def;
		}
		return all[0];
	});

	async function runPrompt(prompt: SavedPrompt) {
		setMenuOpen(false);
		promptLibraryStore.markAsUsed(prompt.id);
		const check = canExecute(prompt);
		if (!check.ok) {
			props.onError?.(friendlyError(check, prompt.name));
			return;
		}
		props.onError?.(""); // clear previous error
		setBusy(true);
		props.onBusyChange?.(true);
		try {
			const extraVars = props.contextVariables?.();
			const result = await executeSmartPrompt(prompt, extraVars);
			if (!result.ok) props.onError?.(friendlyError(result, prompt.name));
		} catch (err) {
			props.onError?.(String(err));
			appLogger.error("prompts", `SmartButtonStrip "${prompt.name}" failed`, err);
		} finally {
			setBusy(false);
			props.onBusyChange?.(false);
		}
	}

	/** The prompt the main button runs; only read under `<Show when={activePrompt()}>`. */
	const current = () => activePrompt() as SavedPrompt;

	/** The bordered split button (sidebar, PR popover) — unchanged look. */
	const renderSplit = () => (
		<div class={cx(s.split, props.class)} ref={rootRef}>
			<button
				class={cx(s.splitMain, busy() && s.splitBusy, !canExecute(current()).ok && s.splitDisabled)}
				disabled={busy() || !canExecute(current()).ok}
				onClick={() => runPrompt(current())}
				title={current().description}
			>
				<Show when={busy()} fallback={<IconSparkle size={12} />}>
					<span class={s.spinner} />
				</Show>
				{current().name}
			</button>
			<Show when={prompts().length > 1}>
				<button
					class={cx(s.splitArrow, menuOpen() && s.splitArrowOpen)}
					onClick={() => setMenuOpen(!menuOpen())}
					title="More actions"
				>
					{/* stroke 3 on the 24 grid = the old hand-drawn chevron's 2 on a 16 grid */}
					<IconChevronDown size={10} stroke={3} />
				</button>
				<Show when={menuOpen()}>
					<div class={s.menu}>
						<For each={prompts()}>
							{(item) => {
								const check = () => canExecute(item);
								const isActive = () => item.id === activePrompt()?.id;
								return (
									<button
										class={cx(s.menuItem, isActive() && s.menuItemActive, !check().ok && s.menuItemDisabled)}
										disabled={!check().ok}
										title={!check().ok ? check().reason : item.description}
										onClick={(e) => {
											e.stopPropagation();
											runPrompt(item);
										}}
									>
										{item.name}
										<Show when={isActive()}>
											<IconCheck size={12} stroke={2.5} class={s.checkMark} />
										</Show>
									</button>
								);
							}}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);

	/**
	 * The ghost split chip (side-panel control rows). `data-part` names the two
	 * halves for a caller's layout rules (the commit composer folds the chip to
	 * its arrow when the row runs out of room).
	 */
	const renderChip = () => {
		const check = () => canExecute(current());
		// aria-disabled rather than disabled, so the tooltip naming the reason still shows.
		const blocked = () => busy() || !check().ok;
		return (
			<div class={cx(s.chipSplit, menuOpen() && s.chipSplitOpen, props.class)} ref={rootRef}>
				<button
					type="button"
					data-part="main"
					class={cx(s.chipMain, !check().ok && s.chipMainDisabled)}
					aria-disabled={blocked() || undefined}
					aria-busy={busy() || undefined}
					onClick={() => {
						if (!blocked()) runPrompt(current());
					}}
					title={check().ok ? current().description : check().reason}
				>
					<Show when={busy()}>
						<Spinner size={12} />
					</Show>
					<span class={s.chipLabel}>{current().name}</span>
				</button>
				<Show when={prompts().length > 1}>
					<button
						type="button"
						data-part="arrow"
						class={cx(s.splitArrow, menuOpen() && s.splitArrowOpen)}
						aria-haspopup="menu"
						aria-expanded={menuOpen()}
						onClick={() => setMenuOpen(!menuOpen())}
						title="More actions"
					>
						<IconChevronDown size={14} />
					</button>
					<Show when={menuOpen()}>
						<div class={s.chipMenu} role="menu">
							<For each={prompts()}>
								{(item) => {
									const itemCheck = () => canExecute(item);
									const isActive = () => item.id === activePrompt()?.id;
									return (
										<button
											type="button"
											role="menuitem"
											class={s.menuItem}
											disabled={!itemCheck().ok}
											title={!itemCheck().ok ? itemCheck().reason : item.description}
											onClick={(e) => {
												e.stopPropagation();
												runPrompt(item);
											}}
										>
											<span class={s.menuItemLabel}>{item.name}</span>
											<Show when={isActive()}>
												<IconCheck size={14} class={s.checkMark} />
											</Show>
										</button>
									);
								}}
							</For>
						</div>
					</Show>
				</Show>
			</div>
		);
	};

	return (
		<Show when={activePrompt()}>
			<Show when={chip()} fallback={renderSplit()}>
				{renderChip()}
			</Show>
		</Show>
	);
};
