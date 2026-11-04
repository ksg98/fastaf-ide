// Story 1638-c94c: replay the load captured at the first native whole-process
// stall against an already-running isolated `make agent-test` instance.
//
//   node scripts/stall-workload/occluded-replay.mjs <fixture.json> <launch-plan.json> <new-out-dir>
//
// launch-plan.json is the `make agent-test ... AGENT_TEST_DRY_RUN=1` output for
// the same instance and port. Control and probes use only its Unix socket.
// Exit 0: no WebView callback gap reached the fixture threshold (GREEN).
// Exit 1: a gap reached it (RED). Exit 2: harness failure, no verdict.
// It never launches, restarts or stops an app; raw output stays in <new-out-dir>.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const [fixturePath, planPath, out] = process.argv.slice(2);
if (!fixturePath || !planPath || !out) {
	console.error("usage: occluded-replay.mjs <fixture.json> <launch-plan.json> <new-out-dir>");
	process.exit(2);
}
if (existsSync(out)) {
	console.error(`refusing to reuse ${out}`);
	process.exit(2);
}
mkdirSync(out, { recursive: true });
const WebSocket = createRequire(resolve(root, "package.json"))("ws");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const work = fixture.workload;
const threshold = fixture.verdict.stall_threshold_ms;
const t0 = Date.now();
const log = (...a) => {
	const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
	console.log(line);
	appendFileSync(`${out}/replay.log`, `${line}\n`);
};
const save = (name, x) => writeFileSync(`${out}/${name}`, JSON.stringify(x, null, 1));
const jsonl = (name, x) => appendFileSync(`${out}/${name}`, `${JSON.stringify(x)}\n`);

for (const c of work.corpus) {
	const hash = createHash("sha256").update(readFileSync(resolve(root, c.path))).digest("hex");
	if (hash !== c.sha256) throw Error(`corpus capture changed: ${c.path}`);
}

const call = (path, body, method, timeout = 15000) =>
	new Promise((ok, fail) => {
		const req = request(
			{ socketPath: plan.socket, path, method: method ?? (body ? "POST" : "GET"), headers: body ? { "content-type": "application/json" } : {}, signal: AbortSignal.timeout(timeout) },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => {
					const text = Buffer.concat(chunks).toString();
					if (res.statusCode >= 300) return fail(Error(`${res.statusCode} ${text.slice(0, 300)}`));
					try {
						ok(text ? JSON.parse(text) : null);
					} catch {
						ok(text);
					}
				});
			},
		);
		req.on("error", fail);
		req.end(body ? JSON.stringify(body) : undefined);
	});
let rpc = 1;
const tool = async (name, args) => {
	const r = await call("/mcp", { jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } }, undefined, 60000);
	if (r?.error) throw Error(JSON.stringify(r.error));
	const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
	return JSON.parse(text);
};
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Identity: the expected socket and the exact worktree executable.
const health = await call("/health");
if (health.socket_path !== plan.socket) throw Error("wrong socket");
const pid = Number(readFileSync(plan.pid_file, "utf8"));
const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
if (command !== plan.binary) throw Error(`wrong binary ${command}`);
save("identity.json", { health, pid, command, fixture: fixturePath });

const repos = [];
for (let r = 0; r < work.repos.count; r++) {
	const repo = `${out}/repos/r${r}`;
	mkdirSync(`${repo}/src`, { recursive: true });
	git(repo, "init", "-q", "-b", "main");
	for (let n = 0; n < work.repos.files; n++) writeFileSync(`${repo}/src/m${n}.rs`, `// module ${n}\n`.repeat(40));
	git(repo, "add", "-A");
	git(repo, "-c", "user.name=load", "-c", "user.email=load@example.invalid", "commit", "-qm", "init");
	await tool("repo", { action: "add", path: repo });
	repos.push(repo);
}

// Observer: WebView timer and native heartbeat callbacks, independent probes,
// and the process's per-thread scheduling band.
let lastCallback = Date.now();
let maxGap = 0;
const token = randomUUID();
const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	if (req.method !== "POST" || req.url !== `/${token}`) return res.writeHead(404).end();
	let body = "";
	for await (const c of req) body += c;
	const now = Date.now();
	const gap = now - lastCallback;
	if (gap > 3000) {
		jsonl("gaps.jsonl", { from_ms: lastCallback, to_ms: now, gap_ms: gap });
		log("callback gap", gap, "ms");
	}
	maxGap = Math.max(maxGap, gap);
	lastCallback = now;
	jsonl("webview.jsonl", { received_ms: now, ...JSON.parse(body) });
	res.end("ok");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/${token}`;
let probeBusy = false;
const probe = setInterval(async () => {
	if (probeBusy) return;
	probeBusy = true;
	const wall_ms = Date.now();
	const start = performance.now();
	try {
		await call("/sessions");
		jsonl("backend.jsonl", { wall_ms, ms: performance.now() - start, ok: true });
	} catch (e) {
		jsonl("backend.jsonl", { wall_ms, ms: performance.now() - start, ok: false, error: String(e) });
	} finally {
		probeBusy = false;
	}
}, 250);
const band = setInterval(() => {
	const prios = execFileSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" }).split("\n").slice(1).filter(Boolean).map((l) => Number.parseInt(l.trim().split(/\s+/)[3], 10));
	jsonl("band.jsonl", { wall_ms: Date.now(), threads: prios.length, background: prios.filter((p) => p <= 4).length });
}, 1000);
let sampled = 0;
const watch = setInterval(() => {
	if (Date.now() - lastCallback > 3000 && sampled < 6 && Date.now() - (watch.lastSample ?? 0) > 10000) {
		watch.lastSample = Date.now();
		sampled++;
		spawn("/usr/bin/sample", [String(pid), "3", "-file", `${out}/sample-${Date.now()}.txt`], { stdio: "ignore" }).on("error", () => {});
	}
}, 500);
const observer = `const endpoint=${JSON.stringify(endpoint)};
const send=x=>fetch(endpoint,{method:'POST',body:JSON.stringify({wall_ms:Date.now(),visibility:document.visibilityState,...x})}).catch(()=>{});
let last=performance.now();
setInterval(()=>{const now=performance.now();send({kind:'timer',gap_ms:now-last});last=now;},250);
let pending=false;setInterval(async()=>{if(pending)return;pending=true;const s=performance.now();try{await window.__TAURI__.core.invoke('frontend_heartbeat');send({kind:'native-heartbeat',ms:performance.now()-s,ok:true});}catch(e){send({kind:'native-heartbeat',ok:false,error:String(e)});}finally{pending=false;}},5000);
send({kind:'start',userAgent:navigator.userAgent});`;
save("observer-receipt.json", await call("/debug/invoke_js", { script: observer }));

// Load: real agent bytes in PTY tabs plus remote clients, by fixture phase.
const sessions = [];
const clients = [];
const captures = work.corpus.map((c) => resolve(root, c.path));
const addSessions = async (n) => {
	for (let i = 0; i < n; i++) {
		const k = sessions.length;
		const picks = Array.from({ length: work.captures_per_session }, (_, j) => captures[(k + j) % captures.length]);
		const shell = `/usr/bin/python3 ${resolve(root, "scripts/stall-workload/agent-replay.py")} ${work.profiles[k % work.profiles.length]} ${repos[k % repos.length]} ${picks.join(" ")}`;
		const r = await call("/sessions", { shell, cwd: repos[k % repos.length], rows: work.rows, cols: work.cols });
		sessions.push(r.session_id);
	}
};
const addClients = (n) => {
	for (let i = 0; i < n; i++) {
		const c = { ws: [], timers: [], sse: null };
		for (const id of sessions.slice(-work.client.ws_grid_streams)) {
			const ws = new WebSocket(`ws+unix://${plan.socket}:/sessions/${id}/stream?format=grid`);
			ws.on("error", (e) => jsonl("clients.jsonl", { error: String(e) }));
			c.ws.push(ws);
		}
		c.sse = request({ socketPath: plan.socket, path: "/events" }, (res) => res.resume());
		c.sse.on("error", () => {});
		c.sse.end();
		c.timers.push(setInterval(() => call("/sessions").catch(() => {}), work.client.poll_sessions_ms));
		c.timers.push(setInterval(() => call(`/repo/summary?path=${encodeURIComponent(repos[i % repos.length])}`).catch(() => {}), work.client.poll_repo_summary_ms));
		clients.push(c);
	}
};

let status = 2;
let stop = false;
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { stop = true; });
try {
	const phases = [...work.phases];
	while (!stop && Date.now() - t0 < work.duration_s * 1000) {
		const elapsed = (Date.now() - t0) / 1000;
		while (phases.length && phases[0].at_s <= elapsed) {
			const p = phases.shift();
			await addSessions(p.sessions);
			addClients(p.clients);
			log("phase", JSON.stringify(p), "sessions", sessions.length, "clients", clients.length);
		}
		if (Math.max(maxGap, Date.now() - lastCallback) >= threshold) {
			log("RED: WebView callback gap reached", threshold, "ms");
			break;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	maxGap = Math.max(maxGap, Date.now() - lastCallback);
	// An interrupted replay has no verdict: it may end before the load phases.
	status = maxGap >= threshold ? 1 : stop ? 2 : 0;
} finally {
	// Let a stalled instance recover before teardown, bounded.
	for (let i = 0; i < 120 && Date.now() - lastCallback > 3000; i++) await new Promise((r) => setTimeout(r, 1000));
	for (const c of clients) {
		for (const w of c.ws) w.terminate();
		for (const t of c.timers) clearInterval(t);
		c.sse?.destroy();
	}
	for (const id of sessions) await call(`/sessions/${id}`, undefined, "DELETE", 60000).catch((e) => log("delete failed", id, String(e)));
	clearInterval(probe);
	clearInterval(band);
	clearInterval(watch);
	server.closeAllConnections();
	server.close();
	const result = { verdict: status === 0 ? "GREEN" : status === 1 ? "RED" : "ERROR", max_callback_gap_ms: maxGap, threshold_ms: threshold, seconds: (Date.now() - t0) / 1000, sessions: sessions.length, clients: clients.length };
	save("result.json", result);
	log(JSON.stringify(result));
	process.exit(status);
}
