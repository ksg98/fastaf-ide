import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildStallReplay } from "./build-stall-replay.mjs";

const record = (metrics, extra = {}) => JSON.stringify({
	schema_version: 1, timestamp_ms: 1234, kind: "git_refresh", metrics,
	...extra,
});
const counts = { repo_count: 16, worktree_count: 40, response_bytes: 12345 };

test("metadata replay preserves observed counts without leaking log strings or payloads", () => {
	const fixture = buildStallReplay(record({ ...counts, secret: "private" }, { message: "private/repo", payload: "private" }));
	assert.equal(fixture.refreshes[0].repo_count, 16);
	assert.equal(Object.keys(fixture.refreshes[0].structure.worktree_paths).length, 40);
	assert.equal(fixture.refreshes[0].response_bytes, 12345);
	assert.equal(JSON.stringify(fixture).includes("private"), false);
	assert.match(fixture.fidelity, /not original workload/);
});

test("unknown schema and missing counts cannot silently create a misleading replay", () => {
	assert.throws(() => buildStallReplay(record(counts, { schema_version: 2 })), /Unsupported/);
	assert.throws(() => buildStallReplay(record({ repo_count: 16 })), /lacks topology/);
	assert.throws(() => buildStallReplay(record({ ...counts, worktree_count: -1 })), /Invalid metric/);
	assert.throws(() => buildStallReplay("{truncated"), SyntaxError);
});

test("malformed or repeated huge counts cannot allocate an unbounded replay", () => {
	assert.throws(() => buildStallReplay(record({ ...counts, worktree_count: 10001 })), /exceeds/);
	const large = record({ ...counts, worktree_count: 6000 });
	assert.throws(() => buildStallReplay(`${large}\n${large}`), /Select fewer/);
	assert.throws(() => buildStallReplay(" ".repeat(4 * 1024 * 1024 + 1)), /retention bound/);
});

test("rotated and current observations retain their supplied chronological order", () => {
	const fixture = buildStallReplay(`${record(counts)}\n${record({}, { timestamp_ms: 1300, kind: "ui_freeze" })}\n`);
	assert.deepEqual(fixture.events.map((event) => event.timestamp_ms), [1234, 1300]);
	assert.equal(fixture.refreshes.length, 1);
});


test("the CLI accepts two full-size files without charging a synthetic separator byte", () => {
	assert.ok(process.env.TMPDIR, "run through scripts/with-test-tmp.sh");
	const directory = mkdtempSync(join(process.env.TMPDIR, "stall-builder-"));
	try {
		const line = `${record(counts)}\n`;
		const full = line.padEnd(2 * 1024 * 1024 - 1, " ") + "\n";
		const previous = join(directory, "previous.jsonl");
		const current = join(directory, "current.jsonl");
		const output = join(directory, "replay.json");
		writeFileSync(previous, full);
		writeFileSync(current, full);
		execFileSync(process.execPath, [fileURLToPath(new URL("./build-stall-replay.mjs", import.meta.url)), output, previous, current]);
		assert.equal(JSON.parse(readFileSync(output, "utf8")).refreshes.length, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
