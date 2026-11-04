#!/usr/bin/env node
// Metadata-derived inputs, not a recording of the original reactive graph or payload.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_COUNT = 10_000;
const KINDS = new Set(["git_refresh", "git_stats", "ui_freeze", "heartbeat_gap"]);
const METRICS = new Set([
	"total_ms", "body_ms", "flush_ms", "repo_count", "worktree_count",
	"store_worktree_count", "response_bytes", "gap_ms", "silent_secs",
	"last_heartbeat_received_ms", "backend_observed_ms",
]);

/** Validate before allocating a synthetic topology. Never copy strings from a log. */
export function buildStallReplay(text) {
	if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("Journal exceeds the two-file retention bound");
	const events = text.split("\n").filter((line) => line.trim()).map((line) => {
		const row = JSON.parse(line);
		if (row.schema_version !== 1 || !KINDS.has(row.kind) || !Number.isSafeInteger(row.timestamp_ms) || row.timestamp_ms < 0) {
			throw new Error("Unsupported journal record");
		}
		const metrics = {};
		for (const [key, value] of Object.entries(row.metrics ?? {})) {
			if (!METRICS.has(key)) continue;
			if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid metric: ${key}`);
			if (key.endsWith("count") && value > MAX_COUNT) throw new Error("Replay topology exceeds 10000 entries");
			metrics[key] = value;
		}
		return { schema_version: 1, timestamp_ms: row.timestamp_ms, kind: row.kind, metrics };
	});
	let allocatedWorktrees = 0;
	const refreshes = events.filter((event) => event.kind === "git_refresh").map((event) => {
		const { repo_count, worktree_count, response_bytes } = event.metrics;
		if (repo_count === undefined || worktree_count === undefined || response_bytes === undefined) {
			throw new Error("Refresh record lacks topology/response-size metadata");
		}
		allocatedWorktrees += worktree_count;
		if (allocatedWorktrees > MAX_COUNT) throw new Error("Select fewer refresh records: replay exceeds 10000 worktrees");
		return {
			observed_at_ms: event.timestamp_ms,
			repo_count,
			response_bytes,
			// Synthetic, deterministic checkout names. Never original paths or payloads.
			structure: {
				worktree_paths: Object.fromEntries(Array.from({ length: worktree_count }, (_, i) => [
					`workspace-${i}`, { branch: `branch-${i}`, path: `/replay/repo/worktree-${i}`, kind: "worktree" },
				])),
				merged_branches: [],
				response_bytes,
			},
		};
	});
	return { schema_version: 1, fidelity: "metadata-derived synthetic topology; not original workload replay", events, refreshes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [output, ...inputs] = process.argv.slice(2);
	if (!output || inputs.length < 1 || inputs.length > 2) {
		throw new Error("Usage: node scripts/build-stall-replay.mjs OUTPUT.json [rotated.jsonl] current.jsonl");
	}
	// Read no more than the bounded journal shape, even if the input is not a journal.
	if (inputs.reduce((size, path) => size + statSync(path).size, 0) > MAX_BYTES) throw new Error("Journal too large");
	const chunks = inputs.map((path) => readFileSync(path));
	if (chunks.reduce((size, chunk) => size + chunk.length, 0) > MAX_BYTES) throw new Error("Journal too large");
	writeFileSync(output, `${JSON.stringify(buildStallReplay(chunks.join("")), null, 2)}\n`);
}
