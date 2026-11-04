import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { it } from "vitest";

const run = promisify(execFile);
const probe = join(import.meta.dirname, "fixtures", "viteWatchProbe.mjs");
const repo = join(import.meta.dirname, "..", "..");

// Vite/Rolldown keep native handles for the process lifetime. A child exercises
// the real watcher without charging those handles to Vitest's per-file detector.
it("watches source and excludes tooling when Vite starts outside the config directory", async () => {
	await run(process.execPath, [probe, "other-cwd"], { cwd: repo, timeout: 45_000 });
}, 50_000);

it("watches frontend HTML without reloading for tooling HTML under .tmp or tools", async () => {
	await run(process.execPath, [probe, "watch"], { cwd: repo, timeout: 45_000 });
}, 50_000);
