#!/usr/bin/env node
/** Operator-only, read-only verification against an explicitly selected isolated desktop. */
import { randomUUID } from "node:crypto";

const usage = `Usage: node scripts/github-work-live-check.mjs <isolated-url> <account-id> <issue-url> <pr-url> <project-node-id> --isolated-desktop
Requires a loaded/configured github-work plugin and completed device-flow login.
Refuses port 9876. Never starts an app, logs in, reads token stores or writes to GitHub.
Prints counts/check names only; no issue bodies, account credentials or server errors.`;
if (process.argv.includes("--help")) {
	console.log(usage);
	process.exit(0);
}
const [base, account, issue, pr, project, consent, ...extra] = process.argv.slice(2);
let origin;
try {
	origin = new URL(base);
	if (
		origin.protocol !== "http:" ||
		origin.hostname !== "127.0.0.1" ||
		!origin.port ||
		origin.port === "9876" ||
		origin.pathname !== "/" ||
		origin.search ||
		origin.hash ||
		origin.username ||
		origin.password ||
		!account ||
		!project ||
		consent !== "--isolated-desktop" ||
		extra.length
	)
		throw new Error();
	for (const [url, kind] of [
		[issue, "issues"],
		[pr, "pull"],
	]) {
		const parsed = new URL(url);
		if (
			parsed.origin !== "https://github.com" ||
			!new RegExp(`^/[^/]+/[^/]+/${kind}/[1-9][0-9]*$`).test(parsed.pathname) ||
			parsed.search ||
			parsed.hash
		)
			throw new Error();
	}
} catch {
	console.error(usage);
	process.exit(2);
}

// Runs inside the selected desktop WebView, not in Node or Boss's MCP instance.
async function probe(input) {
	let stage = "desktop plugin load";
	let registration;
	const checks = [];
	const require = (condition) => {
		if (!condition) throw new Error("check failed");
	};
	try {
		const loaded = window.__TUIC__?.plugin("github-work");
		require(loaded?.loaded && loaded.enabled && !loaded.error);
		checks.push("desktop plugin loaded");
		const invoke = window.__TAURI__.core.invoke;
		stage = "Tasks account configuration";
		const raw = await invoke("read_plugin_data", { pluginId: "github-work", path: "work-items.json" });
		const entry = JSON.parse(raw).accounts.find((value) => value.id === input.account);
		require(entry);
		// A fresh module graph avoids stale cached modules. Do not call onload/onunload:
		// that would replace the real plugin's active registration. Temporary registrations
		// below collect providers locally and never change Tasks or application settings.
		stage = "installed module import";
		const windows = navigator.userAgent.includes("Windows");
		const moduleUrl = `${windows ? "http://plugin.localhost/" : "plugin://"}github-work/~v${Date.now()}/main.js`;
		const { registerGitHubAccounts } = await import(moduleUrl);
		let provider;
		let requests = 0;
		const budget = () => require(++requests <= 24);
		const host = {
			httpFetch: (url, options) => {
				budget();
				// Only REST GETs and GraphQL queries are permitted by this operator probe.
				require(
					options.method === "GET" ||
						(options.method === "POST" &&
							new URL(url).pathname === "/graphql" &&
							/^query\b/.test(JSON.parse(options.body).query.trim())),
				);
				return invoke("plugin_http_fetch", { pluginId: "github-work", url, ...options });
			},
			githubReviewThreads: (account, reference, after) => {
				budget();
				return invoke("plugin_github_action", {
					pluginId: "github-work",
					account,
					reference,
					request: { action: "threads", after },
				});
			},
			githubPrAction: (account, reference, request) => {
				budget();
				require(request.action === "state");
				return invoke("plugin_github_action", { pluginId: "github-work", account, reference, request });
			},
			registerWorkItemProvider: (value) => {
				provider = value;
				return {
					dispose() {
						provider = undefined;
					},
				};
			},
			registerUrlResolver: () => ({ dispose() {} }),
		};
		registration = registerGitHubAccounts(host, [entry]);
		const query = { filters: [], savedFilterId: null, search: "", sort: null, groupBy: null, cursor: null, limit: 5 };
		stage = "account-scoped search";
		const page = await provider.list(query);
		require(Array.isArray(page.items));
		checks.push(`search: ${page.items.length} items`);
		for (const [url, type] of [
			[input.issue, "issue"],
			[input.pr, "pull"],
		]) {
			stage = `${type} URL and detail`;
			const reference = provider.resolveUrl(url);
			const detail = await provider.detail(reference);
			require(detail.item.reference.id === reference.id && detail.item.itemType === type);
			checks.push(`${type} URL/detail`);
			stage = `${type} comment pagination`;
			let comments = detail.comments;
			let pages = 1;
			const seen = new Set();
			while (comments.nextCursor && pages < 4) {
				require(!seen.has(comments.nextCursor));
				seen.add(comments.nextCursor);
				comments = await provider.comments(reference, comments.nextCursor, 5);
				pages++;
			}
			checks.push(`${type} comment pages: ${pages}${comments.nextCursor ? " (remaining pages not read)" : ""}`);
			if (type === "pull") {
				stage = "B6 review threads";
				const threads = await provider.comments(reference, "threads:first", 5);
				require(Array.isArray(threads.entries));
				checks.push(`B6: ${threads.entries.length} threads`);
				stage = "B7 action-state read";
				require(await provider.runPrAction(reference, "state", {}));
				checks.push("B7 state (no action submitted)");
			} else {
				stage = "duplicate candidates";
				require(Array.isArray((await provider.duplicates(detail.item.title)).items));
				checks.push("duplicate candidates");
			}
		}
		stage = "Projects board and roadmap read";
		require((await provider.board(input.project, query)).board.id === input.project);
		require(Array.isArray((await provider.projectItems(input.project, query)).items));
		checks.push("Projects board/roadmap");
		return {
			marker: input.marker,
			ok: true,
			checks,
			requests,
			limits:
				"Read-only transport/module probe; does not exercise Tasks rendering, actual registry cleanup, start-work delivery or live mutations.",
		};
	} catch {
		// Do not copy provider errors or private response data to the application log.
		return { marker: input.marker, ok: false, stage, checks };
	} finally {
		registration?.dispose();
	}
}

const marker = `github-work-check-${randomUUID()}`;
async function request(path, body) {
	const response = await fetch(new URL(path, origin), {
		method: body ? "POST" : "GET",
		headers: body ? { "Content-Type": "application/json" } : {},
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(5000),
		redirect: "error",
	});
	if (!response.ok) throw new Error("Isolated desktop HTTP request failed");
	return response.json();
}
try {
	const input = { marker, account, issue, pr, project };
	const result = await request("/debug/invoke_js", {
		script: `return (${probe.toString()})(${JSON.stringify(input)});`,
	});
	if (!result.ok) throw new Error("Selected instance cannot run desktop verification");
	const deadline = Date.now() + 90000;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const logs = await request("/logs?source=eval_js&limit=20");
		for (const log of logs) {
			let report;
			try {
				report = JSON.parse(log.message);
			} catch {
				continue;
			}
			if (report.marker !== marker) continue;
			console.log(JSON.stringify(report, null, 2));
			process.exit(report.ok ? 0 : 1);
		}
	}
	throw new Error("Desktop result not received within 90 seconds; remote reads may still finish");
} catch (error) {
	console.error(error.message);
	process.exit(1);
}
