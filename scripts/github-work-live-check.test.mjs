import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./github-work-live-check.mjs", import.meta.url);
const args = [
	"http://127.0.0.1:9877",
	"github.com",
	"https://github.com/owner/repo/issues/1",
	"https://github.com/owner/repo/pull/2",
	"PVT_example",
	"--isolated-desktop",
];

// Catches: an operator typo contacts production, an external server, or an unconfirmed instance.
test("live check rejects unsafe targets before making any request", () => {
	for (const base of [
		"http://127.0.0.1:9876",
		"http://example.org:9877",
		"http://user:password@127.0.0.1:9877",
		"http://127.0.0.1:9877/other",
		"http://127.0.0.1:9877/?token=secret",
		"https://127.0.0.1:9877",
	]) {
		const result = spawnSync(process.execPath, [script.pathname, base, ...args.slice(1)], {
			encoding: "utf8",
			timeout: 2000,
		});
		assert.equal(result.status, 2, base);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /Usage:/);
		assert.doesNotMatch(result.stderr, /password|token=secret/);
	}
	const unconfirmed = spawnSync(process.execPath, [script.pathname, ...args.slice(0, -1)], {
		encoding: "utf8",
		timeout: 2000,
	});
	assert.equal(unconfirmed.status, 2);
});
