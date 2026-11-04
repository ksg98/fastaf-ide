import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import type { WorkItemDetail, WorkItemFieldSchema, WorkItemOption } from "../../../types/work-items.gen";
import {
	carryOver,
	collectFields,
	type Draft,
	type DraftValue,
	formFields,
	ITEM_TYPE_FIELD,
	toFieldValue,
} from "./createDraft";

export interface TasksCreateOptions {
	provider: WorkItemProvider;
	onCreated: (detail: WorkItemDetail) => void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useTasksCreate(props: TasksCreateOptions) {
	const [types, setTypes] = createSignal<WorkItemOption[]>([]);
	const [itemType, setItemType] = createSignal("");
	// The schema always names the type it was loaded for; fields of another type are never submitted.
	const [loaded, setLoaded] = createSignal<{ type: string; fields: WorkItemFieldSchema[] }>({ type: "", fields: [] });
	const schema = () => loaded().fields;
	const [draft, setDraft] = createSignal<Draft>({});
	const [title, setTitle] = createSignal("");
	const [body, setBody] = createSignal("");
	const [loading, setLoading] = createSignal(false);
	const [submitting, setSubmitting] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	// Each schema request supersedes the previous one, so a late answer for an old type is dropped.
	let generation = 0;
	let controller: AbortController | undefined;
	onCleanup(() => controller?.abort());

	async function load<T>(request: (signal: AbortSignal) => Promise<T>, adopt: (value: T) => void) {
		controller?.abort();
		const current = ++generation;
		controller = new AbortController();
		const { signal } = controller;
		setLoading(true);
		setError(null);
		try {
			const value = await request(signal);
			if (current === generation) adopt(value);
		} catch (failure) {
			if (current === generation && !signal.aborted) setError(message(failure));
		} finally {
			if (current === generation) setLoading(false);
		}
	}

	function chooseType(id: string) {
		setItemType(id);
		const provider = props.provider;
		if (!id) {
			generation++;
			controller?.abort();
			setLoading(false);
			setLoaded({ type: "", fields: [] });
			return;
		}
		void load(
			(signal) => provider.createFields(id, signal),
			(fields) => {
				const next = formFields(fields);
				setDraft((previous) => carryOver(schema(), next, previous));
				setLoaded({ type: id, fields: next });
			},
		);
	}

	function loadTypes() {
		const provider = props.provider;
		setItemType("");
		setLoaded({ type: "", fields: [] });
		setDraft({});
		void load(
			(signal) => provider.createFields(undefined, signal),
			(fields) => {
				const picker = fields.find((field) => field.id === ITEM_TYPE_FIELD && field.kind === "enum");
				if (!picker?.options.length) {
					setTypes([]);
					setError("This provider declares no item types to create.");
					return;
				}
				setTypes(picker.options);
				if (picker.options.length === 1) chooseType(picker.options[0].id);
			},
		);
	}
	createEffect(on(() => props.provider, loadTypes));

	const description = () => schema().find((field) => field.id === "description");
	const collected = createMemo(() => collectFields(schema(), { ...draft(), description: body() }));
	const blocker = () => {
		if (!title().trim()) return "Required: Title";
		if (!itemType() || loaded().type !== itemType()) return "Required: Type";
		const result = collected();
		return result.ok ? null : `${result.invalid ? "Invalid" : "Required"}: ${result.blocker}`;
	};
	const canSubmit = () => !loading() && !submitting() && blocker() === null;

	async function submit() {
		const result = collected();
		if (!canSubmit() || !result.ok) return;
		setSubmitting(true);
		setError(null);
		try {
			const created = await props.provider.act(null, {
				kind: "create",
				value: { title: title(), body: body(), itemType: itemType(), fields: result.fields },
			});
			if (created.kind !== "item") throw new Error("The provider did not return the created item.");
			setTitle("");
			setBody("");
			setDraft(Object.fromEntries(Object.keys(draft()).map((id) => [id, Array.isArray(draft()[id]) ? [] : ""])));
			props.onCreated(created.value);
		} catch (failure) {
			setError(message(failure));
		} finally {
			setSubmitting(false);
		}
	}

	return {
		types,
		itemType,
		chooseType,
		schema: () => schema().filter((field) => field.id !== "description"),
		description,
		bodyError: () => (description()?.required && !body().trim() ? `Required: ${description()?.name}` : undefined),
		draft,
		setValue: (id: string, value: DraftValue) => setDraft((previous) => ({ ...previous, [id]: value })),
		title,
		setTitle,
		body,
		setBody,
		loading,
		submitting,
		error,
		blocker,
		fieldError: (field: WorkItemFieldSchema) => {
			const value = toFieldValue(field, draft()[field.id]);
			return value === undefined
				? `Invalid: ${field.name}`
				: value === null && field.required
					? `Required: ${field.name}`
					: undefined;
		},
		canSubmit,
		submit,
		retry: () => (types().length ? chooseType(itemType()) : loadTypes()),
	};
}
