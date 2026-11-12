import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { Portal } from "solid-js/web";
import type { BaseRefOption } from "../../hooks/useRepository";
import { t } from "../../i18n";
import { registerModal } from "../../stores/modalStack";
import { cx } from "../../utils";
import { validateBranchName } from "../RenameBranchDialog/RenameBranchDialog";
import d from "../shared/dialog.module.css";
import { SearchField } from "../shared/SearchField";
import s from "./CreateWorktreeDialog.module.css";

/** Options returned when the user confirms worktree creation */
export interface WorktreeCreateOptions {
	branchName: string;
	createBranch: boolean;
	/** Base ref to create the worktree from (branch name or "HEAD") */
	baseRef: string;
}

export interface CreateWorktreeDialogProps {
	visible: boolean;
	suggestedName: string;
	existingBranches: string[];
	/** Branches that already have worktrees (cannot be checked out again) */
	worktreeBranches: string[];
	/** Base directory where worktrees are created */
	worktreesDir: string;
	/** Available base refs for the "Start from" dropdown (first is the repository's default branch) */
	baseRefs?: BaseRefOption[];
	/** The base this project's worktrees start from; the first of `baseRefs` when not given. */
	defaultBaseRef?: string;
	/** Make a base the project's default. Without it the dialog offers no such action. */
	onSetDefaultBaseRef?: (baseRef: string) => void;
	/** Generate a random branch name */
	onGenerateName?: () => Promise<string>;
	onClose: () => void;
	onCreate: (options: WorktreeCreateOptions) => void | Promise<void>;
}

/** Sanitize a branch name for use as a directory name (replace slashes with dashes) */
function sanitizeForPath(name: string): string {
	return name.replaceAll("/", "-");
}

/** Rows of the list at most, before it scrolls; fewer when the window is short. */
const LIST_MAX_PX = 240;
const LIST_MIN_PX = 112;
/** The search field, its padding and the gap to the window's edge. */
const PANEL_CHROME_PX = 56;

/**
 * The "Start from" picker: a button that opens a searchable list of branches,
 * local first, then remote. A repository can have hundreds of branches and the
 * one wanted is often a remote one at the very end, so the list is filtered by
 * typing and walked with the arrow keys.
 *
 * The list is drawn in a portal: the dialog clips and scrolls its own body, so
 * a list inside it is cut off wherever the dialog happens to end.
 */
const BaseRefDropdown: Component<{
	value: string;
	options: BaseRefOption[];
	/** The project's default base, marked "(default)". */
	defaultName: string;
	onChange: (value: string) => void;
}> = (props) => {
	const [open, setOpen] = createSignal(false);
	const [query, setQuery] = createSignal("");
	/** The row the arrow keys are on, as an index into `ordered()`. */
	const [cursor, setCursor] = createSignal(0);
	const [place, setPlace] = createSignal({ left: 0, top: 0, width: 0, listMax: LIST_MAX_PX });
	let triggerRef: HTMLButtonElement | undefined;
	let panelRef: HTMLDivElement | undefined;
	let searchRef: HTMLInputElement | undefined;

	const matches = createMemo(() => {
		const words = query().trim().toLowerCase();
		return words ? props.options.filter((r) => r.name.toLowerCase().includes(words)) : props.options;
	});
	const localRefs = createMemo(() => matches().filter((r) => r.kind === "local"));
	const remoteRefs = createMemo(() => matches().filter((r) => r.kind === "remote"));
	/** The rows in the order they are drawn, which is the order the arrow keys walk. */
	const ordered = createMemo(() => [...localRefs(), ...remoteRefs()]);

	const close = () => {
		setOpen(false);
		triggerRef?.focus();
	};

	const show = () => {
		if (!triggerRef) return;
		const rect = triggerRef.getBoundingClientRect();
		const room = window.innerHeight - rect.bottom - PANEL_CHROME_PX;
		setPlace({
			left: rect.left,
			top: rect.bottom + 4,
			width: rect.width,
			listMax: Math.max(LIST_MIN_PX, Math.min(LIST_MAX_PX, room)),
		});
		setQuery("");
		setCursor(
			Math.max(
				0,
				ordered().findIndex((r) => r.name === props.value),
			),
		);
		setOpen(true);
	};

	const pick = (name: string) => {
		props.onChange(name);
		close();
	};

	const revealCursor = () =>
		panelRef?.querySelector<HTMLElement>("[data-cursor]")?.scrollIntoView?.({ block: "nearest" });

	createEffect(() => {
		if (!open()) return;
		// Escape closes the list and stops there; the dialog stays open.
		registerModal(close);
		const onOutside = (e: MouseEvent) => {
			const target = e.target as Node;
			if (!triggerRef?.contains(target) && !panelRef?.contains(target)) setOpen(false);
		};
		// The list is placed once, from where the button was.
		const onResize = () => setOpen(false);
		document.addEventListener("mousedown", onOutside);
		window.addEventListener("resize", onResize);
		onCleanup(() => {
			document.removeEventListener("mousedown", onOutside);
			window.removeEventListener("resize", onResize);
		});
		queueMicrotask(() => {
			searchRef?.focus();
			revealCursor();
		});
	});

	const onSearchKey = (e: KeyboardEvent) => {
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			const last = ordered().length - 1;
			if (last < 0) return;
			setCursor((at) => Math.max(0, Math.min(last, at + (e.key === "ArrowDown" ? 1 : -1))));
			queueMicrotask(revealCursor);
		} else if (e.key === "Enter") {
			// Enter picks a branch here. The dialog's own Enter creates the
			// worktree, and must not also fire.
			e.preventDefault();
			e.stopPropagation();
			const choice = ordered()[cursor()];
			if (choice) pick(choice.name);
		}
	};

	const defaultTag = () => ` (${t("createWorktree.default", "default")})`;

	const renderItem = (option: BaseRefOption, index: number) => (
		<div
			role="option"
			aria-selected={option.name === props.value}
			class={cx(
				s.dropdownItem,
				option.name === props.value && s.dropdownItemActive,
				index === cursor() && s.dropdownItemCursor,
			)}
			data-cursor={index === cursor() ? "" : undefined}
			onMouseMove={() => setCursor(index)}
			onClick={() => pick(option.name)}
		>
			{option.name}
			<Show when={option.name === props.defaultName}>
				<span class={s.defaultTag}>{defaultTag()}</span>
			</Show>
		</div>
	);

	return (
		<div class={s.baseRefRow}>
			<label>{t("createWorktree.startFrom", "Start from")}</label>
			<div class={s.dropdownWrapper}>
				<button
					ref={triggerRef}
					type="button"
					class={s.dropdownTrigger}
					aria-haspopup="listbox"
					aria-expanded={open()}
					onClick={() => (open() ? close() : show())}
				>
					<span class={s.dropdownValue}>
						{props.value}
						<Show when={props.value === props.defaultName}>
							<span class={s.defaultTag}>{defaultTag()}</span>
						</Show>
					</span>
					<svg class={s.dropdownChevron} width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
						<path d="M4 6l4 4 4-4" />
					</svg>
				</button>
				<Show when={open()}>
					<Portal>
						<div
							ref={panelRef}
							class={s.dropdownList}
							style={{ left: `${place().left}px`, top: `${place().top}px`, width: `${place().width}px` }}
							data-testid="base-ref-list"
						>
							<SearchField
								ref={(el) => {
									searchRef = el;
								}}
								class={s.dropdownSearch}
								value={query()}
								onInput={(value) => {
									setQuery(value);
									setCursor(0);
								}}
								onKeyDown={onSearchKey}
								placeholder={t("createWorktree.searchBranches", "Search branches")}
							/>
							<div class={s.dropdownScroll} role="listbox" style={{ "max-height": `${place().listMax}px` }}>
								<Show when={localRefs().length > 0}>
									<div class={s.dropdownSectionHeader}>{t("createWorktree.localBranches", "Local")}</div>
									<For each={localRefs()}>{(option, i) => renderItem(option, i())}</For>
								</Show>
								<Show when={remoteRefs().length > 0}>
									<div class={s.dropdownSectionHeader}>{t("createWorktree.remoteBranches", "Remote")}</div>
									<For each={remoteRefs()}>{(option, i) => renderItem(option, localRefs().length + i())}</For>
								</Show>
								<Show when={ordered().length === 0}>
									<div class={s.dropdownEmpty}>{t("createWorktree.noMatch", "No matching branches")}</div>
								</Show>
							</div>
						</div>
					</Portal>
				</Show>
			</div>
		</div>
	);
};

export const CreateWorktreeDialog: Component<CreateWorktreeDialogProps> = (props) => {
	const [branchName, setBranchName] = createSignal("");
	const [baseRef, setBaseRef] = createSignal("");
	const [error, setError] = createSignal<string | null>(null);
	const [isCreating, setIsCreating] = createSignal(false);
	let inputRef: HTMLInputElement | undefined;

	/** Available base refs — first entry is the repository's default branch */
	const availableBaseRefs = () => props.baseRefs ?? [];
	/** The base this project's worktrees start from unless another is picked. */
	const defaultBase = () => props.defaultBaseRef || availableBaseRefs()[0]?.name || "";

	const trimmedName = () => branchName().trim();

	// Whether the typed name matches an existing local branch
	const isExistingBranch = createMemo(() => props.existingBranches.includes(trimmedName()));

	// Whether the typed name matches a branch that already has a worktree
	const hasWorktree = createMemo(() => props.worktreeBranches.includes(trimmedName()));

	// Filter branches by what the user has typed
	const filteredBranches = createMemo(() => {
		const query = trimmedName().toLowerCase();
		if (!query) return props.existingBranches;
		return props.existingBranches.filter((b) => b.toLowerCase().includes(query));
	});

	// Path preview
	const pathPreview = createMemo(() => {
		const name = trimmedName();
		if (!name || !props.worktreesDir) return "";
		const dir = props.worktreesDir.replace(/\/$/, "");
		return `${dir}/${sanitizeForPath(name)}/`;
	});

	// `props.visible` is computed by the caller from the whole dialog state, so
	// reading it directly re-runs an effect on every change to that state, not
	// only when the dialog opens or closes. The memo passes on real changes only.
	const visible = createMemo(() => props.visible);

	// Reset state when dialog opens. Only opening resets it: the default base
	// can change while the dialog is up ("Always start from…"), and that must
	// not wipe the name being typed.
	createEffect(() => {
		if (visible()) {
			setBranchName("");
			setBaseRef(untrack(defaultBase));
			setError(null);
			setTimeout(() => {
				if (inputRef) {
					inputRef.focus();
				}
			}, 0);
		}
	});

	// Keyboard handling
	createEffect(() => {
		if (!visible()) return;

		// Escape-to-close is handled centrally (stores/modalStack): registering routes
		// Escape to props.onClose AND stops it reaching the terminal underneath.
		registerModal(props.onClose);

		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				e.preventDefault();
				handleCreate();
			}
		};

		document.addEventListener("keydown", handleKeydown);
		onCleanup(() => document.removeEventListener("keydown", handleKeydown));
	});

	const handleCreate = async () => {
		const name = trimmedName();
		if (!name || isCreating()) return;

		// Existing branch that already has a worktree — reject
		if (hasWorktree()) {
			setError(t("createWorktree.alreadyHasWorktree", "Branch already has a worktree"));
			return;
		}

		const options: WorktreeCreateOptions = isExistingBranch()
			? { branchName: name, createBranch: false, baseRef: baseRef() }
			: (() => {
					const validationError = validateBranchName(name);
					if (validationError) {
						setError(validationError);
						return null!;
					}
					return { branchName: name, createBranch: true, baseRef: baseRef() };
				})();
		if (!options) return;

		setIsCreating(true);
		setError(null);
		try {
			await props.onCreate(options);
		} catch (err) {
			setError(String(err));
			setIsCreating(false);
			return;
		}
		setIsCreating(false);
	};

	const handleInputChange = (e: Event) => {
		const value = (e.target as HTMLInputElement).value;
		setBranchName(value);
		if (error()) setError(null);
	};

	const handleGenerateName = async () => {
		if (!props.onGenerateName) return;
		const name = await props.onGenerateName();
		setBranchName(name);
		if (error()) setError(null);
	};

	const handleBranchClick = (branch: string) => {
		// Don't allow selecting branches that already have worktrees
		if (props.worktreeBranches.includes(branch)) return;
		setBranchName(branch);
		if (error()) setError(null);
	};

	return (
		<Show when={props.visible}>
			<div class={d.overlay} onClick={props.onClose}>
				<div class={d.popover} onClick={(e) => e.stopPropagation()}>
					<div class={d.header}>
						<span class={d.headerIcon}>+</span>
						<h4>{t("createWorktree.title", "New Worktree")}</h4>
					</div>
					<div class={d.body}>
						<div class={s.inputRow}>
							<input
								ref={inputRef}
								type="text"
								value={branchName()}
								onInput={handleInputChange}
								placeholder={t("createWorktree.comboPlaceholder", "Type branch name or select existing...")}
							/>
							<Show when={props.onGenerateName}>
								<button
									aria-label={t("createWorktree.generateName", "Generate random name")}
									class={s.generateBtn}
									onClick={handleGenerateName}
									title={t("createWorktree.generateName", "Generate random name")}
									type="button"
								>
									<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
										<path d="M13 3.5a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1 0-1h.2A4.5 4.5 0 0 0 8 2.05a4.5 4.5 0 0 0-4.5 4.5.5.5 0 0 1-1 0A5.5 5.5 0 0 1 8 1.05a5.5 5.5 0 0 1 5.5 3.37V4a.5.5 0 0 1 .5-.5zM3 12.5a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 0 1h-.2A4.5 4.5 0 0 0 8 13.95a4.5 4.5 0 0 0 4.5-4.5.5.5 0 0 1 1 0A5.5 5.5 0 0 1 8 14.95a5.5 5.5 0 0 1-5.5-3.37V12a.5.5 0 0 1-.5.5z" />
									</svg>
								</button>
							</Show>
						</div>

						<Show when={availableBaseRefs().length > 1 && !isExistingBranch()}>
							<BaseRefDropdown
								value={baseRef()}
								options={availableBaseRefs()}
								defaultName={defaultBase()}
								onChange={setBaseRef}
							/>
							<Show when={props.onSetDefaultBaseRef && baseRef() && baseRef() !== defaultBase()}>
								<button
									type="button"
									class={s.makeDefault}
									onClick={() => props.onSetDefaultBaseRef?.(baseRef())}
									data-testid="base-ref-make-default"
								>
									{t("createWorktree.makeDefault", "Always start from {branch} in this project", {
										branch: baseRef(),
									})}
								</button>
							</Show>
						</Show>

						<div class={s.branchList}>
							<For each={filteredBranches()}>
								{(branch) => {
									const isDisabled = () => props.worktreeBranches.includes(branch);
									return (
										<div
											class={`${s.branchItem} ${isDisabled() ? s.disabled : ""} ${trimmedName() === branch ? s.selected : ""}`}
											onClick={() => handleBranchClick(branch)}
										>
											<span>{branch}</span>
											<Show when={isDisabled()}>
												<span class={s.worktreeTag}>{t("createWorktree.hasWorktree", "(has worktree)")}</span>
											</Show>
										</div>
									);
								}}
							</For>
						</div>

						<Show when={trimmedName()}>
							<div class={s.statusLine}>
								{isExistingBranch()
									? t("createWorktree.statusExisting", "Will check out existing branch into new worktree")
									: t("createWorktree.statusNew", "Will create new branch and worktree")}
							</div>
						</Show>

						<Show when={pathPreview()}>
							<div class={s.pathPreview}>{pathPreview()}</div>
						</Show>

						{error() && <p class={d.error}>{error()}</p>}
					</div>
					<div class={d.actions}>
						<button class={d.cancelBtn} onClick={props.onClose}>
							{t("createWorktree.cancel", "Cancel")}
						</button>
						<button class={d.primaryBtn} onClick={handleCreate} disabled={!trimmedName() || isCreating()}>
							{isCreating() ? t("createWorktree.creating", "Creating...") : t("createWorktree.create", "Create")}
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export default CreateWorktreeDialog;
