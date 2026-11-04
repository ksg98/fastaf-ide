#!/usr/bin/env node
// A real owned child that holds startup open; no application or browser is started.
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

process.on("SIGTERM", () => {
	writeFileSync(process.env.STALL_TEST_STOPPING, "stopping");
	if (!process.env.STALL_TEST_RELEASE) process.exit(0);
	setInterval(() => {
		if (existsSync(process.env.STALL_TEST_RELEASE)) process.exit(0);
	}, 20);
});
createServer(() => {
	// Keep the health request pending so cancellation must interrupt fetch.
	writeFileSync(process.env.STALL_TEST_PID, String(process.pid));
}).listen(Number(process.env.TUIC_PORT), "127.0.0.1");
