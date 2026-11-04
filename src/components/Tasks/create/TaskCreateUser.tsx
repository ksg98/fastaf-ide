import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import type { WorkItemFieldSchema, WorkItemOption } from "../../../types/work-items.gen";
import { Input } from "../../ui/Input";
import { CreateField as SettingField } from "./CreateField";
import type { DraftValue } from "./createDraft";

/** Search results are choices, never implicit selections; stale responses cannot replace newer ones. */
export function TaskCreateUser(props: {
	schema: WorkItemFieldSchema;
	provider: WorkItemProvider;
	value: DraftValue | undefined;
	disabled: boolean;
	error?: string;
	onInput: (value: DraftValue) => void;
}) {
	const [query, setQuery] = createSignal("");
	const [choices, setChoices] = createSignal<WorkItemOption[]>([]);
	const [names, setNames] = createSignal<Record<string, string>>({});
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string>();
	const single = () => props.provider.singleUser?.(props.schema.id) === true;
	const selected = () => (Array.isArray(props.value) ? props.value : []);
	createEffect(() => {
		const text = query().trim();
		const provider = props.provider;
		const field = props.schema;
		const controller = new AbortController();
		let active = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		setError(undefined);
		setLoading(false);
		setChoices(field.options.filter((option) => option.name.toLowerCase().includes(text.toLowerCase())));
		if (text && provider.lookupUsers) {
			setLoading(true);
			timer = setTimeout(() => {
				void provider
					.lookupUsers?.(field.id, text, controller.signal)
					.then((options) => {
						if (active) setChoices(options);
					})
					.catch((failure: unknown) => {
						if (active) setError(failure instanceof Error ? failure.message : String(failure));
					})
					.finally(() => {
						if (active) setLoading(false);
					});
			}, 250);
		}
		onCleanup(() => {
			active = false;
			controller.abort();
			clearTimeout(timer);
		});
	});
	const name = (userId: string) =>
		names()[userId] ?? props.schema.options.find((option) => option.id === userId)?.name ?? userId;
	const label = () => `${props.schema.name}${props.schema.required ? " *" : ""}`;
	return (
		<SettingField label={label()} error={props.error} hint="Search for a user, then select a result.">
			{(id, hintId) => (
				<>
					<Input
						id={id}
						aria-describedby={[hintId, `${id}-selected`].join(" ")}
						aria-required={props.schema.required}
						aria-invalid={!!props.error}
						value={query()}
						disabled={props.disabled}
						onInput={(event) => setQuery(event.currentTarget.value)}
					/>
					<span id={`${id}-selected`}>{selected().length ? `Selected: ${selected().map(name).join(", ")}` : ""}</span>
					<For each={selected()}>
						{(userId) => (
							<button
								type="button"
								disabled={props.disabled}
								onClick={() => props.onInput(selected().filter((value) => value !== userId))}
							>
								Remove {name(userId)}
							</button>
						)}
					</For>
					<Show when={loading()}>
						<span role="status">Searching users…</span>
					</Show>
					<Show when={error()}>{(failure) => <span role="alert">{failure()}</span>}</Show>
					<Show when={query().trim() && !loading() && !error() && choices().length === 0}>
						<span role="status">No users found.</span>
					</Show>
					<For each={choices().filter((option) => !selected().includes(option.id))}>
						{(option) => (
							<button
								type="button"
								disabled={props.disabled}
								onClick={() => {
									setNames((previous) => ({ ...previous, [option.id]: option.name }));
									props.onInput(single() ? [option.id] : [...selected(), option.id]);
									setQuery("");
								}}
							>
								{option.name}
							</button>
						)}
					</For>
				</>
			)}
		</SettingField>
	);
}
