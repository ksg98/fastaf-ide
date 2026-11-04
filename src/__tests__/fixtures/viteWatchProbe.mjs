import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scratchRoot = join(repo, ".tmp");
mkdirSync(scratchRoot, { recursive: true });

async function otherCwd() {
	const originalCwd = process.cwd();
	const alternate = mkdtempSync(join(scratchRoot, "vite-watch-cwd-"));
	try {
		mkdirSync(join(alternate, "src-tauri"));
		writeFileSync(join(alternate, "src-tauri", "tauri.conf.json"), '{"version":"wrong-checkout"}');
		process.chdir(alternate);
		const loaded = await loadConfigFromFile({ command: "serve", mode: "development" }, join(repo, "vite.config.ts"));
		assert.ok(loaded);
		const config = loaded.config;
		const ignored = config.server?.watch?.ignored;
		assert.equal(typeof ignored, "function");
		assert.equal(ignored(join(repo, "src", "App.tsx")), false);
		assert.equal(ignored(join(repo, ".tmp", "report.html")), true);
		assert.equal(ignored(join(repo, "src", ".tmp", "report.html")), true);
		const actualVersion = JSON.parse(readFileSync(join(repo, "src-tauri", "tauri.conf.json"), "utf-8")).version;
		assert.equal(config.define.__APP_VERSION__, JSON.stringify(actualVersion));
	} finally {
		process.chdir(originalCwd);
		rmSync(alternate, { recursive: true, force: true });
	}
}

async function watch() {
	let server;
	const scratch = mkdtempSync(join(scratchRoot, "vite-watch-"));
	const sourceTmp = join(repo, "src", ".tmp");
	const publicTmp = join(repo, "public", ".tmp");
	const sourceControl = join(sourceTmp, "vite-watch-control.html");
	const publicControl = join(publicTmp, "vite-watch-control.html");
	const watched = join(repo, "src", "vite-watch-control.html");
	const tooling = join(repo, "tools", "vite-watch-control.html");
	try {
		mkdirSync(sourceTmp);
		mkdirSync(publicTmp);
		server = await createServer({
			configFile: join(repo, "vite.config.ts"),
			server: { port: 0, strictPort: false, ws: { port: 0 } },
			optimizeDeps: { noDiscovery: true },
		});
		const ready = new Promise((resolve) => server.watcher.once("ready", resolve));
		await server.listen();
		await ready;
		const events = [];
		const messages = [];
		server.watcher.on("all", (_event, path) => events.push(path));
		const hot = server.environments.client.hot;
		const send = hot.send.bind(hot);
		hot.send = (message) => { messages.push(message); return send(message); };
		writeFileSync(watched, "<html></html>");
		await new Promise((resolve) => setTimeout(resolve, 700));
		assert.ok(events.includes(watched));
		assert.ok(messages.some((message) => JSON.stringify(message).includes('"type":"full-reload"')));
		messages.length = 0;
		const generated = join(scratch, "index.html");
		writeFileSync(generated, "<html></html>");
		await new Promise((resolve) => setTimeout(resolve, 700));
		rmSync(generated);
		await new Promise((resolve) => setTimeout(resolve, 700));
		writeFileSync(tooling, "<html></html>");
		writeFileSync(sourceControl, "<html></html>");
		writeFileSync(publicControl, "<html></html>");
		await new Promise((resolve) => setTimeout(resolve, 700));
		for (const path of [generated, tooling, sourceControl, publicControl]) assert.ok(!events.includes(path), path);
		assert.ok(!messages.some((message) => JSON.stringify(message).includes('"type":"full-reload"')));
	} finally {
		await server?.close();
		for (const path of [watched, tooling, sourceControl, publicControl]) rmSync(path, { force: true });
		rmdirSync(sourceTmp);
		rmdirSync(publicTmp);
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (process.argv[2] === "other-cwd") await otherCwd();
else if (process.argv[2] === "watch") await watch();
else throw new Error(`Unknown probe: ${process.argv[2]}`);
