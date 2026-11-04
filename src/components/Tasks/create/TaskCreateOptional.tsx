import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { WorkItemFieldSchema } from "../../../types/work-items.gen";
import { Input } from "../../ui/Input";
import styles from "./TasksCreate.module.css";

/** Optional fields folded behind a summary and a name filter. Filtering hides a field, never unmounts it. */
export function TaskCreateOptional(props: {
	fields: readonly WorkItemFieldSchema[];
	/** Message of a field that blocks Create; such a field is never filtered out. */
	error: (field: WorkItemFieldSchema) => string | undefined;
	children: (field: WorkItemFieldSchema) => JSX.Element;
}) {
	const [filter, setFilter] = createSignal("");
	const invalid = createMemo(() => props.fields.filter((field) => props.error(field)).length);
	const shown = (field: WorkItemFieldSchema) =>
		!!props.error(field) || field.name.toLowerCase().includes(filter().trim().toLowerCase());
	const matches = createMemo(() => props.fields.filter(shown).length);
	return (
		<Show when={props.fields.length > 0}>
			<details class={styles.optional}>
				<summary>
					Optional fields ({props.fields.length}){invalid() > 0 ? ` · ${invalid()} invalid` : ""}
				</summary>
				<Input
					type="search"
					aria-label="Filter optional fields"
					placeholder="Filter optional fields"
					value={filter()}
					onInput={(event) => setFilter(event.currentTarget.value)}
				/>
				<Show when={matches() === 0}>
					<p class={styles.muted} role="status">
						No optional field matches.
					</p>
				</Show>
				<div class={styles.fields}>
					<For each={props.fields}>{(field) => <div hidden={!shown(field)}>{props.children(field)}</div>}</For>
				</div>
			</details>
		</Show>
	);
}
