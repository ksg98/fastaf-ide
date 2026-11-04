import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const cleanupMessage = "Owned PTYs, Vite, headless backend and named browser session cleaned up.";
const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
		return false;
	}
};
async function waitForFile(path, runner) {
	// Setup is not the behavior under test; this only bounds a broken fixture.
	const deadline = Date.now() + 60000;
	while (!existsSync(path)) {
		assert.equal(runner.exitCode, null, "runner exited before fixture setup");
		assert.equal(runner.signalCode, null, "runner was killed before fixture setup");
		assert.ok(Date.now() < deadline, `fixture never wrote ${path}`);
		await delay(20);
	}
}

for (const [signal, repeat] of [
	["SIGTERM", false],
	["SIGINT", false],
	["SIGTERM", true],
]) {
	test(`${signal}${repeat ? " repeated during teardown" : ""} does not orphan the recorded backend PID`, async () => {
		assert.ok(process.env.TUIC_TEST_TMP_ROOT, "run through scripts/with-test-tmp.sh");
		const scratch = mkdtempSync(join(process.env.TUIC_TEST_TMP_ROOT, "stall-cancel-"));
		const pidFile = join(scratch, "backend.pid");
		const stoppingFile = join(scratch, "backend.stopping");
		const releaseFile = join(scratch, "backend.release");
		const reservation = createServer();
		reservation.listen(0, "127.0.0.1");
		await once(reservation, "listening");
		const port = reservation.address().port;
		await new Promise((resolve) => reservation.close(resolve));
		const runner = spawn(process.execPath, ["scripts/stall-workload/run.mjs", join(scratch, "evidence")], {
			cwd: root,
			env: {
				...process.env,
				STALL_BACKEND_BIN: join(root, "scripts/stall-workload/cancellation-backend.mjs"),
				STALL_BACKEND_PORT: String(port),
				STALL_VITE_PORT: String(port),
				STALL_MAIN: "HEAD",
				STALL_PRE_FIX: "HEAD",
				STALL_TEST_PID: pidFile,
				STALL_TEST_STOPPING: stoppingFile,
				STALL_TEST_RELEASE: repeat ? releaseFile : "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		runner.stdout.on("data", (chunk) => {
			output += chunk;
		});
		runner.stderr.on("data", (chunk) => {
			output += chunk;
		});
		const exited = once(runner, "exit");
		const closed = once(runner, "close");
		// Outer harness only; teardown's backend escalation is bounded at five seconds.
		const force = setTimeout(() => runner.kill("SIGKILL"), 90000);
		let backendPid;
		try {
			await waitForFile(pidFile, runner);
			backendPid = Number(readFileSync(pidFile, "utf8"));
			assert.ok(alive(backendPid), "fixture backend must be live before cancellation");
			runner.kill(signal);
			if (repeat) {
				await waitForFile(stoppingFile, runner);
				runner.kill("SIGINT");
				runner.kill("SIGTERM");
				writeFileSync(releaseFile, "release");
			}
			const [code, exitSignal] = await exited;
			assert.equal(alive(backendPid), false, `runner orphaned backend PID ${backendPid}`);
			assert.equal(existsSync(stoppingFile), true, "teardown must signal the owned backend");
			assert.equal(output.split(cleanupMessage).length - 1, 1, `teardown must finish once: ${output}`);
			assert.equal(exitSignal, null, output);
			assert.equal(code, signal === "SIGINT" ? 130 : 143, output);
		} finally {
			clearTimeout(force);
			if (runner.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
			if (!backendPid && existsSync(pidFile)) backendPid = Number(readFileSync(pidFile, "utf8"));
			if (backendPid && alive(backendPid)) process.kill(backendPid, "SIGKILL");
			await closed;
			rmSync(scratch, { recursive: true, force: true });
		}
	});
}
