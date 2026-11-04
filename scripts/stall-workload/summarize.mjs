#!/usr/bin/env node
import { readFileSync } from "node:fs";
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
function distribution(values) {
	const sorted = values.toSorted((a, b) => a - b);
	if (!sorted.length) return { n: 0 };
	const percentile = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
	return {
		n: sorted.length,
		p50_ms: percentile(0.5),
		p95_ms: percentile(0.95),
		p99_ms: percentile(0.99),
		max_ms: sorted.at(-1),
	};
}
const result = {
	quantiles: "nearest rank; raw samples retained in report.json",
	paint: {},
	heartbeat: {},
	raf: {},
	backend: {},
	backend_failures: report.backend.filter((sample) => !sample.ok).length,
};
for (const entry of report.reports ?? [])
	result.paint[entry.revision] = distribution(entry.frames.map((frame) => frame.paint_ms));
for (const [group, key] of [
	["heartbeat", "gap_ms"],
	["raf", "gap_ms"],
	["backend", "latency_ms"],
]) {
	for (const phase of [...new Set(report[group].map((sample) => sample.phase))].sort())
		result[group][phase] = distribution(
			report[group].filter((sample) => sample.phase === phase).map((sample) => sample[key]),
		);
}
console.log(JSON.stringify(result, null, 2));
