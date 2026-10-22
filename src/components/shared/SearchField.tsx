import { type Component, type JSX, type ParentComponent, Show, splitProps } from "solid-js";
import { cx } from "../../utils";
import { IconClose, IconSearch } from "../icons";
import s from "./SearchField.module.css";

export interface SearchFieldProps {
	/** The query (controlled). */
	value: string;
	/** Every edit, including the clear button and Esc (called with ""). */
	onInput: (value: string) => void;
	/** Plain words ("Filter files"). Syntax help belongs in `title`, not here. */
	placeholder?: string;
	/** Tooltip for the whole field — where the wildcard / regex help goes. */
	title?: string;
	/** Runs after the field cleared itself (clear button or Esc). Reset results here. */
	onClear?: () => void;
	/**
	 * Runs before the field's own key handling. Call `preventDefault()` to keep
	 * Esc from clearing (e.g. a consumer that wants Esc to close something first).
	 */
	onKeyDown?: (e: KeyboardEvent) => void;
	onFocus?: (e: FocusEvent) => void;
	onBlur?: (e: FocusEvent) => void;
	/** Receives the <input>, for focus requests. */
	ref?: HTMLInputElement | ((el: HTMLInputElement) => void);
	/** Controls drawn inside the field after the clear button — use SearchFieldToggle. */
	trailing?: JSX.Element;
	/** Accessible name; defaults to the placeholder. */
	"aria-label"?: string;
	/** Extra class on the field box (layout only: margins, flex). */
	class?: string;
	/** Extra class on the <input> — a stable hook for tests and the screenshot harness. */
	inputClass?: string;
	disabled?: boolean;
	autofocus?: boolean;
	/** Any data-* attribute is forwarded to the <input> (data-focus-target, data-repo-path…). */
	[dataAttribute: `data-${string}`]: string | undefined;
}

/**
 * The one inline filter for side panels (STYLE_GUIDE › Side panels): Files
 * search, the Changes filter, the Branches filter. A 28px filled field — a
 * leading magnifier, the input, a clear button while there is a query, then
 * optional toggles (match case, regex…). Esc clears a non-empty query and
 * stops there; on an empty field Esc propagates so the panel can use it.
 */
export const SearchField: Component<SearchFieldProps> = (props) => {
	const [local, inputAttrs] = splitProps(props, [
		"value",
		"onInput",
		"placeholder",
		"title",
		"onClear",
		"onKeyDown",
		"onFocus",
		"onBlur",
		"ref",
		"trailing",
		"aria-label",
		"class",
		"inputClass",
		"disabled",
		"autofocus",
	]);
	let input: HTMLInputElement | undefined;

	const clear = () => {
		local.onInput("");
		local.onClear?.();
	};

	// Bound natively (on:keydown), not through Solid's document-level delegation,
	// so the Esc that clears really stops here: neither a panel's onKeyDown nor a
	// document keydown listener sees it as a second, list-level Esc.
	const handleKeyDown = (e: KeyboardEvent) => {
		local.onKeyDown?.(e);
		if (e.defaultPrevented) return;
		if (e.key === "Escape" && local.value !== "") {
			e.preventDefault();
			e.stopPropagation();
			clear();
		}
	};

	// A press on the field's chrome (the magnifier, the padding) puts the caret in
	// the input instead of doing nothing; the buttons inside handle their own.
	const focusFromChrome = (e: MouseEvent) => {
		const target = e.target as HTMLElement;
		if (target === input || target.closest("button")) return;
		e.preventDefault();
		input?.focus();
	};

	return (
		<div
			class={cx(s.searchField, local.disabled && s.searchFieldDisabled, local.class)}
			title={local.title}
			onMouseDown={focusFromChrome}
		>
			<IconSearch size={14} class={s.searchIcon} />
			<input
				{...inputAttrs}
				ref={(el) => {
					input = el;
					const r = local.ref;
					if (typeof r === "function") r(el);
				}}
				type="text"
				class={cx(s.searchInput, local.inputClass)}
				value={local.value}
				placeholder={local.placeholder}
				aria-label={local["aria-label"] ?? local.placeholder}
				disabled={local.disabled}
				autofocus={local.autofocus}
				autocomplete="off"
				autocorrect="off"
				spellcheck={false}
				onInput={(e) => local.onInput(e.currentTarget.value)}
				on:keydown={handleKeyDown}
				onFocus={(e) => local.onFocus?.(e)}
				onBlur={(e) => local.onBlur?.(e)}
			/>
			<Show when={local.value !== "" && !local.disabled}>
				<button
					type="button"
					class={s.searchClear}
					title="Clear"
					aria-label="Clear search"
					tabIndex={-1}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => {
						clear();
						input?.focus();
					}}
				>
					<IconClose size={12} stroke={2} />
				</button>
			</Show>
			<Show when={local.trailing}>
				<div class={s.searchTrailing}>{local.trailing}</div>
			</Show>
		</div>
	);
};

export interface SearchFieldToggleProps {
	/** Pressed state — drawn as a 16 % accent wash with an accent glyph. */
	active: boolean;
	/** Tooltip and accessible name ("Match case"). */
	title: string;
	onClick: () => void;
	/** Extra class (a stable hook, e.g. the Files mode toggle). */
	class?: string;
}

/**
 * A 22px toggle inside a SearchField (match case, regex, whole word, content
 * mode). Pressing it never steals focus from the query.
 */
export const SearchFieldToggle: ParentComponent<SearchFieldToggleProps> = (props) => (
	<button
		type="button"
		class={cx(s.searchToggle, props.active && s.searchToggleOn, props.class)}
		title={props.title}
		aria-label={props.title}
		aria-pressed={props.active}
		onMouseDown={(e) => e.preventDefault()}
		onClick={() => props.onClick()}
	>
		{props.children}
	</button>
);

export default SearchField;
