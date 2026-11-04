import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectRoadmap, roadmapWindow } from "./calendar";
import { roadmapSeed } from "./demo";

describe("Roadmap calendar geometry", () => {
	// Node re-reads TZ on assignment; the DST case needs a zone that observes DST.
	const savedTz = process.env.TZ;
	beforeEach(() => {
		process.env.TZ = "America/Los_Angeles";
	});
	afterEach(() => {
		if (savedTz === undefined) delete process.env.TZ;
		else process.env.TZ = savedTz;
	});

	// Catches: dividing elapsed hours by 24 makes a DST-crossing span a fractional day.
	it("date_only_span_crossing_dst_keeps_whole_calendar_day_width", () => {
		const seed = roadmapSeed(1);
		const item = seed.items[0]?.item;
		if (!item) throw new Error("Missing scenario");
		item.fields.starts = { kind: "date", value: "2026-11-01" };
		item.fields.ships = { kind: "date", value: "2026-11-03" };
		const result = projectRoadmap([item], seed.fields, {}, roadmapWindow(new Date(2026, 10, 1), "month"));
		expect(result.dated[0]).toMatchObject({
			start: "2026-11-01",
			target: "2026-11-03",
			left: 0,
			width: 10,
			outside: false,
		});
	});

	// Catches: a cross-window task draws beyond the visible range or loses its real dates.
	it("cross_month_span_clips_bar_without_rewriting_dates", () => {
		const seed = roadmapSeed();
		const item = seed.items[4]?.item;
		if (!item) throw new Error("Missing scenario");
		const result = projectRoadmap([item], seed.fields, {}, roadmapWindow(new Date(2026, 9, 1), "month"));
		expect(result.dated[0]).toMatchObject({
			start: "2026-09-28",
			target: "2026-11-04",
			left: 0,
			width: 100,
			outside: false,
		});
	});

	// Catches: Date normalizes an impossible timestamp into a valid-looking bar.
	it.each(["2026-02-30T00:00:00Z", "2026-10-01T12:00:00", "not-a-date"])(
		"invalid_date_%s_stays_in_side_list",
		(date) => {
			const seed = roadmapSeed(1);
			const item = seed.items[0]?.item;
			if (!item) throw new Error("Missing scenario");
			item.fields.starts = { kind: "date", value: date };
			const result = projectRoadmap([item], seed.fields, {}, roadmapWindow(new Date(2026, 9, 1), "month"));
			expect(result.undated.map((entry) => entry.key)).toEqual(["DEMO-1"]);
			expect(result.dated).toEqual([]);
		},
	);
});
