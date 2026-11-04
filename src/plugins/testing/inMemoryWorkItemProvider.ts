/** Local-only test/development fake. No API compatibility or production behavior is claimed. */
import type {
	WorkItemAction,
	WorkItemActionResult,
	WorkItemBoardPage,
	WorkItemDetail,
	WorkItemFieldSchema,
	WorkItemFieldValue,
	WorkItemProviderSnapshot,
	WorkItemRef,
} from "../../types/work-items.gen";
import type { WorkItemProvider } from "../workItemProvider";
import { workItemsDemo } from "./work-items-demo.gen";

export function createInMemoryWorkItemProvider(seed: WorkItemProviderSnapshot = workItemsDemo): WorkItemProvider {
	const data = structuredClone(seed);
	const items = new Map(data.items.map((detail) => [detail.item.reference.id, detail]));
	let revision = 0;
	let nextId = items.size + 1;
	const guard = (signal?: AbortSignal) => signal?.throwIfAborted();
	// The fake has one schema; its creatable types are the types of its seed items.
	const itemTypes = () => [...new Set(data.items.map((detail) => detail.item.itemType))].toSorted();
	function detail(reference: WorkItemRef): WorkItemDetail {
		const item = items.get(reference.id);
		if (!item || reference.providerId !== data.providerId || reference.accountId !== data.accountId)
			throw new Error("Item not found in provider/account");
		return structuredClone(item);
	}
	function cursorOffset(cursor: string | null, signature: string): number {
		if (cursor === null) return 0;
		const parsed: unknown = JSON.parse(cursor);
		if (
			!Array.isArray(parsed) ||
			parsed.length !== 3 ||
			parsed[0] !== revision ||
			parsed[2] !== signature ||
			!Number.isSafeInteger(parsed[1]) ||
			parsed[1] < 0
		)
			throw new Error("Invalid or stale cursor");
		return parsed[1];
	}
	function page<T>(values: T[], cursor: string | null, limit: number, signature: string) {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Limit must be 1..100");
		const offset = cursorOffset(cursor, signature);
		if (offset > values.length) throw new Error("Cursor beyond results");
		const end = Math.min(offset + limit, values.length);
		return {
			values: structuredClone(values.slice(offset, end)),
			nextCursor: end < values.length ? JSON.stringify([revision, end, signature]) : null,
		};
	}
	function validate(schema: WorkItemFieldSchema, value: WorkItemFieldValue | null) {
		if (value === null) {
			if (schema.required) throw new Error("Required field is unset");
			return;
		}
		if (schema.kind !== value.kind) throw new Error("Field kind mismatch");
		if (value.kind === "enum" && !schema.options.some((option) => option.id === value.value))
			throw new Error("Unknown enum option");
		if (value.kind === "number" && !Number.isFinite(value.value)) throw new Error("Number must be finite");
	}
	function apply(detail: WorkItemDetail, fieldId: string, value: WorkItemFieldValue | null) {
		detail.item.fields[fieldId] = value;
		if (fieldId === "labels") detail.item.labels = value?.kind === "labels" ? value.value : [];
		if (fieldId === "assignees") detail.item.assignees = value?.kind === "user" ? value.value : [];
		if (fieldId === "title" && value?.kind === "text") detail.item.title = value.value;
		if (fieldId === "body" && value?.kind === "markdown") detail.body = value.value;
		if (fieldId === "state" && value?.kind === "enum") {
			const state = detail.fields
				.find((schema) => schema.id === "state")
				?.options.find((option) => option.id === value.value);
			if (state) detail.item.state = { ...state, tone: detail.item.state.tone };
		}
	}
	function matches(actual: WorkItemFieldValue | null | undefined, wanted: WorkItemFieldValue) {
		if (wanted.kind === "labels" && actual?.kind === "labels")
			return wanted.value.every((w) => actual.value.some((a) => a.id === w.id));
		if (wanted.kind === "user" && actual?.kind === "user")
			return wanted.value.every((w) => actual.value.some((a) => a.id === w.id));
		return JSON.stringify(actual) === JSON.stringify(wanted);
	}
	const provider: WorkItemProvider = {
		providerId: data.providerId,
		accountId: data.accountId,
		name: data.name,
		fields: data.fields,
		savedFilters: data.savedFilters,
		boards: data.boards,
		async createFields(itemType, signal) {
			guard(signal);
			// Contract: an untyped call lists the creatable types as the `itemType` enum field.
			if (itemType === undefined)
				return [
					{
						id: "itemType",
						name: "Type",
						kind: "enum",
						required: true,
						editable: true,
						sortable: false,
						groupable: false,
						filterable: false,
						options: itemTypes().map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) })),
					},
				];
			if (!itemTypes().includes(itemType)) throw new Error("Unknown item type");
			return structuredClone(data.fields);
		},
		async list(query, signal) {
			guard(signal);
			const preset =
				query.savedFilterId === null ? undefined : data.savedFilters.find((p) => p.id === query.savedFilterId);
			if (query.savedFilterId !== null && !preset) throw new Error("Unknown saved filter");
			const filters = [...(preset?.query.filters ?? []), ...query.filters];
			for (const filter of filters) {
				const schema = data.fields.find((field) => field.id === filter.fieldId);
				if (!schema) throw new Error("Unknown filter field");
				for (const value of filter.values) validate(schema, value);
			}
			const search = (query.search || preset?.query.search || "").toLowerCase();
			const sort = query.sort ?? preset?.query.sort;
			if (sort && !["key", "title", "updatedAt"].includes(sort.fieldId)) throw new Error("Unsupported fake sort");
			const values = [...items.values()]
				.filter(
					(d) =>
						`${d.item.key} ${d.item.title} ${d.body}`.toLowerCase().includes(search) &&
						filters.every((filter) =>
							filter.values.length === 0
								? d.item.fields[filter.fieldId] == null
								: filter.values.some((v) => matches(d.item.fields[filter.fieldId], v)),
						),
				)
				.map((d) => d.item);
			if (sort)
				values.sort((a, b) => {
					const key = (i: typeof a) =>
						sort.fieldId === "title" ? i.title : sort.fieldId === "updatedAt" ? i.updatedAt : i.key;
					const order = key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
					return (sort.descending ? -order : order) || a.reference.id.localeCompare(b.reference.id);
				});
			const result = page(values, query.cursor, query.limit, JSON.stringify({ ...query, cursor: null }));
			return { items: result.values, nextCursor: result.nextCursor, total: values.length };
		},
		async detail(reference, signal) {
			guard(signal);
			return detail(reference);
		},
		async comments(reference, cursor, limit, signal) {
			guard(signal);
			const result = page(detail(reference).comments.entries, cursor, limit, `comments:${JSON.stringify(reference)}`);
			return { entries: result.values, nextCursor: result.nextCursor };
		},
		async grouped(query, signal) {
			const fieldId = query.groupBy;
			if (!fieldId || !data.fields.some((field) => field.id === fieldId)) throw new Error("Unknown group field");
			const result = await provider.list(query, signal);
			const groups = new Map<string, { id: string; name: string; items: typeof result.items }>();
			for (const item of result.items) {
				const value = item.fields[fieldId];
				let keys: Array<{ id: string; name: string }>;
				if (value?.kind === "labels" || value?.kind === "user")
					keys = value.value.map((v) => ({ id: `${value.kind}:${v.id}`, name: v.name }));
				else if (value)
					keys = [
						{
							id: `${value.kind}:${String(value.value)}`,
							name:
								data.fields.find((f) => f.id === fieldId)?.options.find((o) => o.id === value.value)?.name ??
								String(value.value),
						},
					];
				else keys = [];
				if (!keys.length) keys = [{ id: "unset", name: "Unset" }];
				for (const key of keys) {
					let group = groups.get(key.id);
					if (!group) {
						group = { ...key, items: [] };
						groups.set(key.id, group);
					}
					group.items.push(item);
				}
			}
			return {
				groups: [...groups.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
				nextCursor: result.nextCursor,
				total: result.total,
			};
		},
		async board(id, query, signal): Promise<WorkItemBoardPage> {
			const board = data.boards.find((board) => board.id === id);
			if (!board) throw new Error("Unknown board");
			const result = await provider.list(query, signal);
			return {
				board: structuredClone(board),
				nextCursor: result.nextCursor,
				lanes: board.columns.map((column) => ({
					columnId: column.id,
					cards: result.items
						.filter((item) => {
							const value = item.fields[board.fieldId];
							const action = column.action;
							if (!action) return false;
							return action.kind === "edit_field"
								? action.value.value === null
									? value == null
									: matches(value, action.value.value)
								: action.kind === "transition" && item.state.id === action.value;
						})
						.map((item) => ({
							item,
							moves: board.columns
								.filter((target) => {
									const d = detail(item.reference);
									const action = target.action;
									if (!action) return false;
									if (action.kind === "transition")
										return d.actions.some((a) => a.kind === "transition" && a.id === action.value && a.enabled);
									if (action.kind !== "edit_field") return false;
									const field = d.fields.find((f) => f.id === action.value.fieldId && f.editable);
									if (!field) return false;
									try {
										validate(field, action.value.value);
										return true;
									} catch {
										return false;
									} // Invalid provider target is intentionally not offered as a legal move.
								})
								.flatMap((target) =>
									target.action ? [{ columnId: target.id, action: structuredClone(target.action) }] : [],
								),
						})),
				})),
			};
		},
		async act(reference: WorkItemRef | null, action: WorkItemAction, signal): Promise<WorkItemActionResult> {
			guard(signal);
			if (action.kind === "create") {
				if (reference !== null || !action.value.title.trim()) throw new Error("Create requires no item and a title");
				if (!itemTypes().includes(action.value.itemType)) throw new Error("Unknown item type");
				for (const id of Object.keys(action.value.fields))
					if (!data.fields.some((s) => s.id === id)) throw new Error("Unknown field");
				for (const schema of data.fields) validate(schema, action.value.fields[schema.id] ?? null);
				while (items.has(String(nextId))) nextId++;
				const id = String(nextId++);
				const template = data.items[0];
				if (!template) throw new Error("Fake creation needs one template item");
				const created: WorkItemDetail = structuredClone(template);
				created.item = {
					...created.item,
					reference: { providerId: data.providerId, accountId: data.accountId, id },
					key: `DEMO-${id}`,
					url: `https://example.invalid/tasks/${id}`,
					title: action.value.title,
					itemType: action.value.itemType,
					assignees: [],
					labels: [],
					fields: {},
				};
				created.body = action.value.body;
				created.comments = { entries: [], nextCursor: null };
				for (const [field, value] of Object.entries(action.value.fields)) apply(created, field, value);
				items.set(id, created);
				revision++;
				return { kind: "item", value: structuredClone(created) };
			}
			if (reference === null) throw new Error("Item required");
			const updated = detail(reference);
			if (action.kind === "start_work") {
				if (!action.value.repoPath.trim() || !action.value.branch.trim() || !action.value.prompt.trim())
					throw new Error("Start work requires repo, branch and prompt");
				return structuredClone(action);
			}
			if (action.kind === "edit_field") {
				const schema = data.fields.find((s) => s.id === action.value.fieldId);
				if (!schema?.editable) throw new Error("Unknown or read-only field");
				validate(schema, action.value.value);
				apply(updated, schema.id, action.value.value);
			} else if (action.kind === "transition") {
				const transition = updated.actions.find((a) => a.kind === "transition" && a.id === action.value && a.enabled);
				if (!transition) throw new Error("Unknown or disabled transition");
				updated.item.state = { id: transition.id, name: transition.name, tone: "neutral" };
				if (data.fields.some((s) => s.id === "state")) apply(updated, "state", { kind: "enum", value: transition.id });
			} else {
				if (!action.value.trim()) throw new Error("Empty comment");
				updated.comments.entries.push({
					kind: "normal",
					value: {
						id: `local-${revision}`,
						author: { id: "demo-user", name: "Demo User", avatarUrl: null, bot: false },
						body: action.value,
						createdAt: "2026-10-10T00:00:00Z",
						url: null,
					},
				});
			}
			items.set(reference.id, updated);
			revision++;
			return { kind: "item", value: structuredClone(updated) };
		},
	};
	return provider;
}
