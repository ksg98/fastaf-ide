import { type Component, type JSX, type ParentComponent, Show } from "solid-js";
import { cx } from "../../utils";
import { IconChevronRight } from "../icons";
import s from "./SectionHeader.module.css";

export interface SectionHeaderProps {
	/** Sentence case: "Staged", "Remote", "History". */
	label: string;
	/** Item count after the label — a number, or "3/8" while a filter is on. */
	count?: number | string;
	/** Secondary text after the count, e.g. a drawer's file name. */
	meta?: string;
	/** Tooltip for the header (e.g. the file's full path). */
	title?: string;
	/** Collapsible when `onToggle` is set; `open` drives the chevron and aria-expanded. */
	open?: boolean;
	onToggle?: () => void;
	/** Section-level controls on the right, always visible — use SectionAction. */
	actions?: JSX.Element;
	/**
	 * "section" (default): a header inside a list, inset like its rows.
	 * "drawer": a full-width band with a hairline above (History / Blame).
	 */
	variant?: "section" | "drawer";
	class?: string;
}

/**
 * The header of a group of rows in a side panel. The chevron sits in the same
 * 16px column as the rows' icons, so the label lines up with the row names.
 * The toggle and the actions are siblings: an action never collapses the group.
 */
export const SectionHeader: Component<SectionHeaderProps> = (props) => {
	const title = () => (
		<>
			<span class={s.sectionChevronSlot}>
				<Show when={props.onToggle}>
					<IconChevronRight size={14} class={cx(s.sectionChevron, props.open && s.sectionChevronOpen)} />
				</Show>
			</span>
			<span class={s.sectionLabelGroup}>
				<span class={s.sectionLabel}>{props.label}</span>
				<Show when={props.count !== undefined && props.count !== ""}>
					<span class={s.sectionCount}>{props.count}</span>
				</Show>
			</span>
			<Show when={props.meta}>
				<span class={s.sectionMeta}>{props.meta}</span>
			</Show>
		</>
	);

	return (
		<div class={cx(s.sectionHeader, props.variant === "drawer" && s.sectionHeaderDrawer, props.class)}>
			<Show
				when={props.onToggle}
				fallback={
					<div class={s.sectionTitle} title={props.title}>
						{title()}
					</div>
				}
			>
				<button
					type="button"
					class={cx(s.sectionTitle, s.sectionToggle)}
					title={props.title}
					aria-expanded={!!props.open}
					// WebKit leaves a plain <button> out of the Tab order unless macOS keyboard
					// navigation is on; the headers this replaced were Tab stops.
					tabIndex={0}
					onClick={() => props.onToggle?.()}
				>
					{title()}
				</button>
			</Show>
			<Show when={props.actions}>
				<div class={s.sectionActions}>{props.actions}</div>
			</Show>
		</div>
	);
};

export interface SectionActionProps {
	/** Tooltip and accessible name, sentence case ("Stage all"). */
	title: string;
	onClick: (e: MouseEvent) => void;
	/** "danger" tints the hover red (Discard all). */
	tone?: "default" | "danger";
	disabled?: boolean;
	class?: string;
}

/** A 28px icon button in a SectionHeader's action slot. Pass a 16px icon as the child. */
export const SectionAction: ParentComponent<SectionActionProps> = (props) => (
	<button
		type="button"
		class={cx(s.sectionAction, props.tone === "danger" && s.sectionActionDanger, props.class)}
		title={props.title}
		aria-label={props.title}
		disabled={props.disabled}
		onClick={(e) => props.onClick(e)}
	>
		{props.children}
	</button>
);

export default SectionHeader;
