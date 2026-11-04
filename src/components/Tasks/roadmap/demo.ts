/** Synthetic presentation scenarios on the A4 local fake, not external API fixtures. */
import { createInMemoryWorkItemProvider } from "../../../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../../../plugins/testing/work-items-demo.gen";
import type { WorkItemFieldSchema, WorkItemProviderSnapshot } from "../../../types/work-items.gen";

const scenarios = [
	{ title: "Design phase", start: "2026-10-05", target: "2026-10-14" },
	{ title: "UTC boundary", start: "2026-10-11T00:30:00Z", target: "2026-10-12T00:30:00Z" },
	{ title: "Unscheduled follow-up" },
	{ title: "Launch milestone", target: "2026-10-22" },
	{ title: "Cross month release", start: "2026-09-28", target: "2026-11-04" },
	{ title: "Invalid schedule", start: "2026-02-30", target: "2026-10-18" },
	{ title: "Reversed schedule", start: "2026-10-20", target: "2026-10-10" },
	{ title: "Next quarter", start: "2027-01-04", target: "2027-01-08" },
];
export function roadmapSeed(count = scenarios.length) {
	const seed: WorkItemProviderSnapshot = structuredClone(workItemsDemo);
	const template = seed.items[0];
	if (!template) throw new Error("A4 demo requires a template item");
	const dates = ["starts", "ships", "alternate"].map(
		(id, index): WorkItemFieldSchema => ({
			id,
			name: ["Start date", "Target date", "Alternate date"][index] ?? id,
			kind: "date",
			required: false,
			editable: true,
			sortable: false,
			groupable: false,
			filterable: false,
			options: [],
		}),
	);
	seed.fields.push(...dates);
	seed.items = Array.from({ length: count }, (_, index) => {
		const scenario = scenarios[index % scenarios.length];
		if (!scenario) throw new Error("Missing roadmap demo scenario");
		const detail = structuredClone(template);
		detail.item.reference.id = String(index + 1);
		detail.item.key = `DEMO-${index + 1}`;
		detail.item.title = scenario.title;
		detail.item.fields = {
			...detail.item.fields,
			starts: scenario.start ? { kind: "date", value: scenario.start } : null,
			ships: scenario.target ? { kind: "date", value: scenario.target } : null,
			alternate: { kind: "date", value: "2026-10-25" },
		};
		detail.fields.push(...dates);
		return detail;
	});
	return seed;
}
export const roadmapDemo = (count?: number) => createInMemoryWorkItemProvider(roadmapSeed(count));
