import { For } from "solid-js";
import { cx } from "../../utils";
import s from "./FormControls.module.css";

export interface SegmentOption<T extends string> {
	id: T;
	label: string;
	disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
	options: readonly SegmentOption<T>[];
	value?: T;
	onChange: (value: T) => void;
	"aria-label": string;
	class?: string;
}

/** A single-choice view switch with automatic keyboard activation. */
export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
	const enabled = () => props.options.filter((option) => !option.disabled);
	const tabStop = () => enabled().find((option) => option.id === props.value)?.id ?? enabled()[0]?.id;
	function navigate(event: KeyboardEvent, id: T) {
		const options = enabled();
		const index = options.findIndex((option) => option.id === id);
		let next: number;
		switch (event.key) {
			case "ArrowRight":
				next = (index + 1) % options.length;
				break;
			case "ArrowLeft":
				next = (index - 1 + options.length) % options.length;
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = options.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		const option = options[next];
		if (!option) return;
		props.onChange(option.id);
		const group = event.currentTarget instanceof HTMLElement ? event.currentTarget.parentElement : null;
		group?.querySelector<HTMLButtonElement>(`[data-segment="${next}"]`)?.focus();
	}
	return (
		<div class={cx(s.segmented, props.class)} role="tablist" aria-label={props["aria-label"]}>
			<For each={props.options}>
				{(option) => (
					<button
						type="button"
						role="tab"
						class={s.segment}
						disabled={option.disabled}
						aria-selected={props.value === option.id}
						tabIndex={tabStop() === option.id ? 0 : -1}
						data-segment={enabled().findIndex((entry) => entry.id === option.id)}
						onClick={() => props.onChange(option.id)}
						onKeyDown={(event) => navigate(event, option.id)}
					>
						{option.label}
					</button>
				)}
			</For>
		</div>
	);
}
