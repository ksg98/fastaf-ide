import type { WorkItem, WorkItemFieldSchema } from "../../../types/work-items.gen";

export type RoadmapZoom = "month" | "quarter";
export interface RoadmapDateFields {
	startFieldId?: string;
	targetFieldId?: string;
}
export interface RoadmapSpan {
	item: WorkItem;
	start: string;
	target: string;
	left: number;
	width: number;
	outside: boolean;
}
const dayMilliseconds = 86_400_000;
const dayNumber = (date: Date) => {
	const utc = new Date(0);
	utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
	utc.setUTCHours(0, 0, 0, 0);
	return utc.getTime() / dayMilliseconds;
};
const isoDay = (date: Date) =>
	`${date.getFullYear().toString().padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Date-only values are calendar days; timestamps are displayed in the viewer's local zone. */
function calendarDate(value: string): Date | undefined {
	const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (parts) {
		const date = new Date(0);
		date.setFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
		date.setHours(0, 0, 0, 0);
		return isoDay(date) === value ? date : undefined;
	}
	// Require an explicit offset: an unzoned timestamp has no portable provider meaning.
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
		!calendarDate(value.slice(0, 10))
	)
		return undefined;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : undefined;
}

export function roadmapWindow(anchor: Date, zoom: RoadmapZoom) {
	const month = zoom === "quarter" ? Math.floor(anchor.getMonth() / 3) * 3 : anchor.getMonth();
	const start = new Date(anchor.getFullYear(), month, 1);
	const end = new Date(anchor.getFullYear(), month + (zoom === "quarter" ? 3 : 1), 1);
	const days = dayNumber(end) - dayNumber(start);
	const ticks = Array.from({ length: days }, (_, index) => {
		const date = new Date(start.getFullYear(), start.getMonth(), index + 1);
		return {
			date: isoDay(date),
			label: String(date.getDate()),
			month: date.toLocaleDateString(undefined, { month: "short" }),
		};
	});
	const monthName = (date: Date) => date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
	return {
		start,
		end,
		days,
		ticks,
		label:
			zoom === "month"
				? monthName(start)
				: `${monthName(start)} – ${monthName(new Date(end.getFullYear(), end.getMonth(), 0))}`,
	};
}

/** Presentation geometry only. Provider date roles remain host inputs, never inferred from names. */
export function projectRoadmap(
	items: readonly WorkItem[],
	fields: readonly WorkItemFieldSchema[],
	roles: RoadmapDateFields,
	window: ReturnType<typeof roadmapWindow>,
) {
	const dateFields = fields.filter((field) => field.kind === "date");
	// DEFERRED (2026-10-11) — provider-declared date roles need an A4 contract extension.
	// Until then the host supplies IDs; absent IDs use the first two date descriptors in order.
	const startFieldId = roles.startFieldId ?? dateFields[0]?.id;
	const targetFieldId = roles.targetFieldId ?? dateFields[1]?.id;
	const declared = new Set(dateFields.map((field) => field.id));
	const value = (item: WorkItem, id: string | undefined) => {
		if (!id || !declared.has(id)) return undefined;
		const field = item.fields[id];
		if (field == null) return undefined;
		return field.kind === "date" ? (calendarDate(field.value) ?? null) : null;
	};
	const dated: RoadmapSpan[] = [];
	const undated: WorkItem[] = [];
	const firstDay = dayNumber(window.start);
	const lastDay = dayNumber(window.end);
	for (const item of items) {
		const start = value(item, startFieldId);
		const target = value(item, targetFieldId);
		if (
			start === null ||
			target === null ||
			(!start && !target) ||
			(start && target && dayNumber(start) > dayNumber(target))
		) {
			undated.push(item);
			continue;
		}
		const from = start ?? target;
		const to = target ?? start;
		if (!from || !to) continue;
		const visibleStart = Math.max(firstDay, dayNumber(from));
		const visibleEnd = Math.min(lastDay, dayNumber(to) + 1);
		dated.push({
			item,
			start: isoDay(from),
			target: isoDay(to),
			left: ((visibleStart - firstDay) / window.days) * 100,
			width: (Math.max(0, visibleEnd - visibleStart) / window.days) * 100,
			outside: visibleStart >= visibleEnd,
		});
	}
	return { dated, undated, startFieldId, targetFieldId };
}
