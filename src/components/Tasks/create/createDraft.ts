import type { WorkItemFieldSchema, WorkItemFieldValue } from "../../../types/work-items.gen";

/** Untyped `createFields()` declares the creatable item types as an enum field with this ID. */
export const ITEM_TYPE_FIELD = "itemType";

/** Raw control state: option IDs for users/static labels; free labels and other controls keep raw text. */
export type DraftValue = string | string[];
export type Draft = Record<string, DraftValue>;

const isMulti = (schema: WorkItemFieldSchema) => schema.kind === "user" || schema.kind === "labels";

export const emptyValue = (schema: WorkItemFieldSchema): DraftValue => (isMulti(schema) ? [] : "");

/** Fields the form renders for a type schema: editable ones, never the type picker itself. */
export const formFields = (schema: readonly WorkItemFieldSchema[]) =>
	schema.filter((field) => field.editable && field.id !== ITEM_TYPE_FIELD);

/** Keep a value across a type change only where the new type has the same field with the same kind and still offers it. */
export function carryOver(
	previous: readonly WorkItemFieldSchema[],
	next: readonly WorkItemFieldSchema[],
	draft: Draft,
) {
	const kinds = new Map(previous.map((field) => [field.id, field.kind]));
	const offered = (field: WorkItemFieldSchema, id: string) => field.options.some((option) => option.id === id);
	const carried = (field: WorkItemFieldSchema): DraftValue => {
		const value = draft[field.id];
		if (kinds.get(field.id) !== field.kind || value === undefined) return emptyValue(field);
		if (field.kind === "enum") return typeof value === "string" && offered(field, value) ? value : emptyValue(field);
		if (isMulti(field) && field.options.length > 0) {
			const ids = Array.isArray(value)
				? value
				: value
						.split(",")
						.map((label) => label.trim())
						.filter(Boolean);
			return ids.filter((id) => offered(field, id));
		}
		return value;
	};
	return Object.fromEntries(next.map((field) => [field.id, carried(field)]));
}

/** Converts a raw control value; `undefined` means the value is invalid and cannot be sent. */
export function toFieldValue(
	schema: WorkItemFieldSchema,
	raw: DraftValue | undefined,
): WorkItemFieldValue | null | undefined {
	if (schema.kind === "user" || schema.kind === "labels") {
		const ids = Array.isArray(raw)
			? raw
			: schema.kind === "labels" && typeof raw === "string"
				? [
						...new Set(
							raw
								.split(",")
								.map((label) => label.trim())
								.filter(Boolean),
						),
					]
				: [];
		if (ids.length === 0) return null;
		const name = (id: string) => schema.options.find((option) => option.id === id)?.name ?? id;
		return schema.kind === "user"
			? { kind: "user", value: ids.map((id) => ({ id, name: name(id), avatarUrl: null, bot: false })) }
			: { kind: "labels", value: ids.map((id) => ({ id, name: name(id) })) };
	}
	const text = typeof raw === "string" ? raw : "";
	if (!text.trim()) return null;
	if (schema.kind === "number") {
		const value = Number(text);
		return Number.isFinite(value) ? { kind: "number", value } : undefined;
	}
	if (schema.kind === "enum" && !schema.options.some((option) => option.id === text)) return undefined;
	return { kind: schema.kind, value: text };
}

/** Field values for `WorkItemCreate`, or the name of the first field that blocks submission. */
export type Collected =
	| { ok: true; fields: Record<string, WorkItemFieldValue | null> }
	| { ok: false; blocker: string; invalid: boolean };

export function collectFields(schema: readonly WorkItemFieldSchema[], draft: Draft): Collected {
	const fields: Record<string, WorkItemFieldValue | null> = {};
	for (const field of schema) {
		const value = toFieldValue(field, draft[field.id]);
		if (value === undefined) return { ok: false, blocker: field.name, invalid: true };
		if (value === null && field.required) return { ok: false, blocker: field.name, invalid: false };
		fields[field.id] = value;
	}
	return { ok: true, fields };
}
