import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHttpUrl, INTENTIONALLY_UNMAPPED, isTauri, mapCommandToHttp } from "../transport";
import { setTransportLogger } from "../transportRuntime";

function readRepoFile(relativePath: string): string {
	return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function extractBalancedObject(source: string, marker: string): string {
	const markerIndex = source.indexOf(marker);
	if (markerIndex < 0) {
		throw new Error(`Marker not found: ${marker}`);
	}
	const start = source.indexOf("{", markerIndex);
	if (start < 0) {
		throw new Error(`Object start not found after marker: ${marker}`);
	}

	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		const char = source[index];
		if (char === "{") depth += 1;
		if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index + 1);
		}
	}

	throw new Error(`Object end not found after marker: ${marker}`);
}

function extractCommandTableCommands(): Set<string> {
	const transportSource = readRepoFile("src/transport.ts");
	const tableBody = extractBalancedObject(transportSource, "const COMMAND_TABLE");
	return new Set(
		Array.from(tableBody.matchAll(/^\s*([a-zA-Z_][\w]*):\s*\{/gm), (match) => match[1]).filter(
			(command) => command !== undefined,
		),
	);
}

function extractRegisteredTauriCommands(): Set<string> {
	const libSource = readRepoFile("src-tauri/src/lib.rs");
	const handlerStart = libSource.indexOf("tauri::generate_handler![");
	if (handlerStart < 0) {
		throw new Error("tauri::generate_handler![ block not found");
	}
	const listStart = libSource.indexOf("[", handlerStart);
	const listEnd = libSource.indexOf("\n        ])", listStart);
	if (listStart < 0 || listEnd < 0) {
		throw new Error("tauri::generate_handler![ command list bounds not found");
	}

	const commandList = libSource
		.slice(listStart + 1, listEnd)
		.replace(/\/\/.*$/gm, "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.map((entry) => {
			const parts = entry.split("::");
			const rustName = parts[parts.length - 1];
			const renamedCommand = libSource.match(
				new RegExp(
					`#\\[tauri::command\\(rename\\s*=\\s*"([^"]+)"\\)\\]\\s*(?:pub\\(super\\)\\s+)?async\\s+fn\\s+${rustName}\\b`,
				),
			)?.[1];
			return renamedCommand ?? rustName;
		});

	return new Set(commandList);
}

/** Every .ts/.tsx under src/, excluding the test tree itself. */
function collectFrontendSources(): { path: string; source: string }[] {
	const root = join(process.cwd(), "src");
	const files: { path: string; source: string }[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__" || entry.name === "node_modules") continue;
				walk(full);
			} else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
				files.push({ path: full, source: readFileSync(full, "utf8") });
			}
		}
	};
	walk(root);
	return files;
}

/**
 * Per-session Tauri event names the frontend subscribes to, as `pty-<name>-`
 * prefixes. Two spellings reach the same events:
 *   - a literal `` listen(`pty-foo-${sessionId}`) ``
 *   - `transport.onEvent("foo")`, which TauriTransport expands to
 *     `pty-foo-${sessionId}` (canvasTerminalTransport.ts)
 */
function extractSubscribedPtyEvents(): Map<string, string[]> {
	const subscribed = new Map<string, string[]>();
	const add = (name: string, path: string) => {
		const where = subscribed.get(name) ?? [];
		where.push(path.replace(`${process.cwd()}/`, ""));
		subscribed.set(name, where);
	};
	for (const { path, source } of collectFrontendSources()) {
		for (const match of source.matchAll(/listen(?:<[^>]*>)?\(\s*`(pty-[a-z0-9-]+?)-\$\{/g)) {
			add(match[1], path);
		}
		for (const match of source.matchAll(/\.onEvent\(\s*"([a-z0-9-]+)"/g)) {
			add(`pty-${match[1]}`, path);
		}
	}
	return subscribed;
}

describe("transport", () => {
	/**
	 * A listener whose emitter has been deleted fails silently and forever: the
	 * callback simply stops running. That is not hypothetical — commit cda39f31
	 * removed the Rust `pty-output` emit and left `subscribePty` subscribed to
	 * it, freezing desktop `lastDataAt` and the background-tab unread flag for a
	 * commit with nothing red (story 625-56b0).
	 *
	 * So: every per-session event the frontend listens for must be emitted by
	 * Rust. This asserts the direction that broke. The reverse (an emit nobody
	 * consumes) is wasteful but harmless, and is deliberately not asserted.
	 */
	describe("per-session Tauri event parity", () => {
		it("every pty-* event the frontend subscribes to is emitted by Rust", () => {
			const rustSources = ["src-tauri/src/pty.rs", "src-tauri/src/state.rs", "src-tauri/src/terminal_grid.rs"]
				.map((relative) => readRepoFile(relative))
				.join("\n");

			const subscribed = extractSubscribedPtyEvents();
			expect(subscribed.size).toBeGreaterThan(0);

			const orphaned = [...subscribed.entries()].filter(([name]) => !rustSources.includes(`${name}-{session_id}`));

			expect(orphaned.map(([name, where]) => `${name}-{session_id} (listened in ${where.join(", ")})`)).toEqual([]);
		});

		it("includes the activity pulse, which is the signal that regressed", () => {
			// Guards the guard: if the extraction above silently stopped matching,
			// the parity test would pass vacuously for the very event it exists for.
			expect([...extractSubscribedPtyEvents().keys()]).toContain("pty-activity");
		});
	});

	/**
	 * The desktop app receives `repo-changed` over Tauri IPC; browser, PWA and
	 * remote clients receive it over `/events` SSE. They are two transports for
	 * one event, and the same store code consumes both — so the payload keys
	 * must be identical, not merely similar.
	 *
	 * This is the shape the `kind` field was added to. Adding a field to the
	 * Tauri struct and forgetting the SSE arm (or vice versa) is silent: the
	 * desktop build keeps working and only remote clients degrade, which is
	 * exactly the class of drift nobody notices locally.
	 */
	describe("repo-changed cross-transport payload parity", () => {
		/** Field names of the `RepoChangedPayload` struct the Tauri emit sends. */
		function tauriPayloadFields(): string[] {
			const source = readRepoFile("src-tauri/src/repo_watcher.rs");
			const struct = source.match(/pub\(crate\) struct RepoChangedPayload \{([\s\S]*?)\n\}/);
			expect(struct, "RepoChangedPayload struct not found — the extractor is stale").not.toBeNull();
			return [...struct![1].matchAll(/pub (\w+):/g)].map((m) => m[1]).sort();
		}

		/** JSON keys the `/events` SSE arm sends for `AppEvent::RepoChanged`. */
		function ssePayloadKeys(): string[] {
			const source = readRepoFile("src-tauri/src/mcp_http/sse_routes.rs");
			const arm = source.match(/AppEvent::RepoChanged \{[^}]*\} => \{\s*serde_json::json!\(\{([^}]*)\}\)/);
			expect(arm, "RepoChanged SSE arm not found — the extractor is stale").not.toBeNull();
			return [...arm![1].matchAll(/"(\w+)":/g)].map((m) => m[1]).sort();
		}

		it("the Tauri emit and the SSE arm carry the identical field set", () => {
			expect(ssePayloadKeys()).toEqual(tauriPayloadFields());
		});

		it("that field set is the one the frontend reads", () => {
			// Guards the guard: both extractors returning [] would make the
			// equality above pass vacuously. These are the two keys
			// useAppInit.ts and remoteEventBridge.ts destructure.
			expect(tauriPayloadFields()).toEqual(["kind", "repo_path"]);
		});
	});

	describe("isTauri()", () => {
		const original = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;

		afterEach(() => {
			if (original !== undefined) {
				(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = original;
			} else {
				delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
			}
		});

		it("returns true when __TAURI_INTERNALS__ exists", () => {
			(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
			expect(isTauri()).toBe(true);
		});

		it("returns false when __TAURI_INTERNALS__ is absent", () => {
			delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
			expect(isTauri()).toBe(false);
		});
	});

	describe("buildHttpUrl()", () => {
		it("builds URL with current origin by default", () => {
			const url = buildHttpUrl("/health");
			// In test env, location.origin may be empty string, so just check it ends with /health
			expect(url).toContain("/health");
		});
	});

	describe("mapCommandToHttp()", () => {
		it("maps create_pty to POST /sessions", () => {
			const result = mapCommandToHttp("create_pty", { config: { rows: 24, cols: 80, shell: null, cwd: "/tmp" } });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions");
			expect(result.body).toEqual({ rows: 24, cols: 80, shell: null, cwd: "/tmp" });
		});

		it("maps write_pty to POST /sessions/{id}/write", () => {
			const result = mapCommandToHttp("write_pty", { sessionId: "abc", data: "hello" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/abc/write");
			expect(result.body).toEqual({ data: "hello" });
		});

		it("maps enqueue_agent_command to POST /sessions/{id}/queue", () => {
			const result = mapCommandToHttp("enqueue_agent_command", { sessionId: "abc", text: "run tests" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/abc/queue");
			expect(result.body).toEqual({ text: "run tests" });
		});

		it("maps clear_queued_agent_commands to DELETE /sessions/{id}/queue", () => {
			const result = mapCommandToHttp("clear_queued_agent_commands", { sessionId: "abc" });
			expect(result.method).toBe("DELETE");
			expect(result.path).toBe("/sessions/abc/queue");
		});

		it("maps list_queued_agent_commands to GET /sessions/{id}/queue", () => {
			const result = mapCommandToHttp("list_queued_agent_commands", { sessionId: "abc" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/abc/queue");
		});

		it("maps remove_queued_agent_command to DELETE /sessions/{id}/queue/{commandId}", () => {
			const result = mapCommandToHttp("remove_queued_agent_command", { sessionId: "abc", commandId: 7 });
			expect(result.method).toBe("DELETE");
			expect(result.path).toBe("/sessions/abc/queue/7");
		});

		it("maps session names with their custom-name origin", () => {
			const result = mapCommandToHttp("set_session_name", {
				sessionId: "abc",
				name: "Ollama audit",
				isCustom: false,
			});
			expect(result).toEqual({
				method: "PUT",
				path: "/sessions/abc/name",
				body: { name: "Ollama audit", isCustom: false },
			});
		});

		it("maps resize_pty to POST /sessions/{id}/resize", () => {
			const result = mapCommandToHttp("resize_pty", { sessionId: "abc", rows: 40, cols: 120 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/abc/resize");
			expect(result.body).toEqual({ rows: 40, cols: 120 });
		});

		it("maps pause_pty to POST /sessions/{id}/pause", () => {
			const result = mapCommandToHttp("pause_pty", { sessionId: "abc" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/abc/pause");
		});

		it("maps resume_pty to POST /sessions/{id}/resume", () => {
			const result = mapCommandToHttp("resume_pty", { sessionId: "abc" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/abc/resume");
		});

		it("maps close_pty to DELETE /sessions/{id}", () => {
			const result = mapCommandToHttp("close_pty", { sessionId: "abc", cleanupWorktree: false });
			expect(result.method).toBe("DELETE");
			expect(result.path).toBe("/sessions/abc");
		});

		it("maps get_session_foreground_process to GET /sessions/{id}/foreground", () => {
			const result = mapCommandToHttp("get_session_foreground_process", { sessionId: "abc" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/abc/foreground");
			expect(result.transform).toBeDefined();
			expect(result.transform?.({ agent: "claude" })).toBe("claude");
			expect(result.transform?.({ agent: null })).toBeNull();
		});

		it("maps get_pty_capture to GET /diagnostics/capture", () => {
			const result = mapCommandToHttp("get_pty_capture", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/diagnostics/capture");
		});

		it("maps set_pty_capture to POST /diagnostics/capture with a session filter", () => {
			const result = mapCommandToHttp("set_pty_capture", { enabled: true, sessionId: "abc" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/diagnostics/capture");
			expect(result.body).toEqual({ enabled: true, session_id: "abc" });
		});

		it("maps set_pty_capture without a session to an unfiltered tap", () => {
			const result = mapCommandToHttp("set_pty_capture", { enabled: false });
			expect(result.body).toEqual({ enabled: false, session_id: null });
		});

		it("maps get_orchestrator_stats to GET /stats", () => {
			const result = mapCommandToHttp("get_orchestrator_stats", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/stats");
		});

		it("maps get_session_metrics to GET /metrics", () => {
			const result = mapCommandToHttp("get_session_metrics", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/metrics");
		});

		it("maps list_active_sessions to GET /sessions", () => {
			const result = mapCommandToHttp("list_active_sessions", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions");
		});

		it("maps can_spawn_session to GET /stats", () => {
			const result = mapCommandToHttp("can_spawn_session", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/stats");
		});

		it("maps load_config to GET /config", () => {
			const result = mapCommandToHttp("load_config", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/config");
		});

		it("maps save_config to PUT /config", () => {
			const cfg = { font_family: "JetBrains Mono" };
			const result = mapCommandToHttp("save_config", { config: cfg });
			expect(result.method).toBe("PUT");
			expect(result.path).toBe("/config");
			expect(result.body).toEqual(cfg);
		});

		it("maps upstream saves with both the loaded base and desired config", () => {
			const base = { servers: [{ id: "a", enabled: true }] };
			const config = { servers: [{ id: "a", enabled: false }] };
			const result = mapCommandToHttp("save_mcp_upstreams", { base, config });
			expect(result.method).toBe("PUT");
			expect(result.path).toBe("/mcp/upstreams");
			expect(result.body).toEqual({ base, config });
		});

		it("throws for unknown commands", () => {
			expect(() => mapCommandToHttp("unknown_cmd", {})).toThrow("No HTTP mapping for command: unknown_cmd");
		});

		it("maps previously browser-unsupported commands to HTTP", () => {
			const dictation = mapCommandToHttp("start_dictation", {});
			expect(dictation.method).toBe("POST");
			expect(dictation.path).toBe("/dictation/start");

			const openInApp = mapCommandToHttp("open_in_app", { path: "/tmp/x", app: "vscode" });
			expect(openInApp.method).toBe("POST");
			expect(openInApp.path).toBe("/agents/open-in-app");
		});

		it("maps hash_password to POST /config/hash-password with transform", () => {
			const result = mapCommandToHttp("hash_password", { password: "secret" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/config/hash-password");
			expect(result.body).toEqual({ password: "secret" });
			expect(result.transform).toBeDefined();
			expect(result.transform?.({ hash: "abc123" })).toBe("abc123");
		});

		it("maps can_spawn_session with transform", () => {
			const result = mapCommandToHttp("can_spawn_session", {});
			expect(result.transform).toBeDefined();
			expect(result.transform?.({ active_sessions: 2, max_sessions: 5 })).toBe(true);
			expect(result.transform?.({ active_sessions: 5, max_sessions: 5 })).toBe(false);
		});

		it("maps detect_agents to GET /agents", () => {
			const result = mapCommandToHttp("detect_agents", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/agents");
		});

		it("maps get_repo_info to GET /repo/info?path=", () => {
			const result = mapCommandToHttp("get_repo_info", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/info?path=%2Fmy%2Frepo");
		});

		it("maps get_git_diff to GET /repo/diff?path=", () => {
			const result = mapCommandToHttp("get_git_diff", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/diff?path=%2Fmy%2Frepo");
		});

		it("maps get_diff_stats to GET /repo/diff-stats?path=", () => {
			const result = mapCommandToHttp("get_diff_stats", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/diff-stats?path=%2Fmy%2Frepo");
		});

		it("maps get_changed_files to GET /repo/files?path=", () => {
			const result = mapCommandToHttp("get_changed_files", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/files?path=%2Fmy%2Frepo");
		});

		it("maps get_github_status to GET /repo/github?path=", () => {
			const result = mapCommandToHttp("get_github_status", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/github?path=%2Fmy%2Frepo");
		});

		it("maps get_repo_pr_statuses to GET /repo/prs?path=", () => {
			const result = mapCommandToHttp("get_repo_pr_statuses", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/prs?path=%2Fmy%2Frepo");
		});

		it("maps get_git_branches to GET /repo/branches?path=", () => {
			const result = mapCommandToHttp("get_git_branches", { path: "/my/repo" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/branches?path=%2Fmy%2Frepo");
		});

		it("maps get_ci_checks to GET /repo/ci?path=&pr_number=", () => {
			const result = mapCommandToHttp("get_ci_checks", { path: "/my/repo", prNumber: 42 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/ci?path=%2Fmy%2Frepo&pr_number=42");
		});

		it("maps search_content to GET /fs/search-content", () => {
			const result = mapCommandToHttp("search_content", {
				repoPath: "/my/repo",
				query: "hello",
				caseSensitive: true,
				useRegex: false,
				wholeWord: false,
			});
			expect(result.method).toBe("GET");
			expect(result.path).toContain("/fs/search-content");
			expect(result.path).toContain("repoPath=%2Fmy%2Frepo");
			expect(result.path).toContain("query=hello");
			expect(result.path).toContain("caseSensitive=true");
		});

		// --- Terminal grid commands ---

		it("maps terminal_scroll to POST /sessions/{id}/terminal/scroll", () => {
			const result = mapCommandToHttp("terminal_scroll", { sessionId: "s1", delta: -5 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/terminal/scroll");
			expect(result.body).toEqual({ delta: -5 });
		});

		it("maps terminal_scroll_to to POST /sessions/{id}/terminal/scroll-to", () => {
			const result = mapCommandToHttp("terminal_scroll_to", { sessionId: "s1", line: 42 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/terminal/scroll-to");
			expect(result.body).toEqual({ line: 42 });
		});

		it("maps terminal_scroll_info to GET /sessions/{id}/terminal/scroll-info", () => {
			const result = mapCommandToHttp("terminal_scroll_info", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/scroll-info");
		});

		it("maps terminal_search to POST with transform", () => {
			const result = mapCommandToHttp("terminal_search", { sessionId: "s1", query: "foo" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/terminal/search");
			expect(result.body).toEqual({ query: "foo" });
			expect(result.transform?.({ matches: [{ row: 0, col: 1 }] })).toEqual([{ row: 0, col: 1 }]);
		});

		it("maps terminal_search_buffer to POST with transform", () => {
			const result = mapCommandToHttp("terminal_search_buffer", { sessionId: "s1", query: "bar" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/terminal/search-buffer");
			expect(result.body).toEqual({ query: "bar" });
			expect(result.transform?.({ matches: [] })).toEqual([]);
		});

		it("maps terminal_get_row_text to GET with transform", () => {
			const result = mapCommandToHttp("terminal_get_row_text", { sessionId: "s1", row: 5 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/row-text?row=5");
			expect(result.transform?.({ text: "hello" })).toBe("hello");
		});

		it("maps terminal_get_lines to GET with transform", () => {
			const result = mapCommandToHttp("terminal_get_lines", { sessionId: "s1", start: 0, end: 3 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/lines?start=0&end=3");
			expect(result.transform?.({ lines: ["a", "b"] })).toEqual(["a", "b"]);
		});

		it("maps terminal_get_cursor_line to GET with transform", () => {
			const result = mapCommandToHttp("terminal_get_cursor_line", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/cursor-line");
			expect(result.transform?.({ text: "$ " })).toBe("$ ");
		});

		it("maps terminal_hyperlink_at to GET with transform", () => {
			const result = mapCommandToHttp("terminal_hyperlink_at", { sessionId: "s1", row: 2, col: 10 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/hyperlink?row=2&col=10");
			expect(result.transform?.({ url: "https://example.com" })).toBe("https://example.com");
			expect(result.transform?.({ url: null })).toBeNull();
		});

		it("maps terminal_request_frame to POST /sessions/{id}/terminal/request-frame", () => {
			const result = mapCommandToHttp("terminal_request_frame", { sessionId: "s1" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/terminal/request-frame");
		});

		it("maps get_agent_hook_state to GET and unwraps {state}", () => {
			const result = mapCommandToHttp("get_agent_hook_state", { agentType: "claude" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/config/agents/claude/hook-instrumentation");
			expect(result.transform?.({ state: "installed" })).toBe("installed");
		});

		it("maps set_agent_hook_instrumentation to PUT with {enabled} body", () => {
			const result = mapCommandToHttp("set_agent_hook_instrumentation", { agentType: "claude", enabled: true });
			expect(result.method).toBe("PUT");
			expect(result.path).toBe("/config/agents/claude/hook-instrumentation");
			expect(result.body).toEqual({ enabled: true });
		});

		it("maps read_plugin_data to GET /api/plugins/{id}/data/{path} with notFoundAsNull", () => {
			const result = mapCommandToHttp("read_plugin_data", {
				pluginId: "my-plugin",
				path: "credential-consent-anthropic",
			});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/api/plugins/my-plugin/data/credential-consent-anthropic");
			expect(result.notFoundAsNull).toBe(true);
			// Faithful Option<String> bridge: plain strings pass through, non-strings stringify, null stays null.
			expect(result.transform?.("allowed")).toBe("allowed");
			expect(result.transform?.({ a: 1 })).toBe('{"a":1}');
			expect(result.transform?.(null)).toBeNull();
		});

		it("maps write_plugin_data to POST with content body", () => {
			const result = mapCommandToHttp("write_plugin_data", {
				pluginId: "my-plugin",
				path: "credential-consent-anthropic",
				content: "allowed",
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/api/plugins/my-plugin/data/credential-consent-anthropic");
			expect(result.body).toEqual({ content: "allowed" });
		});

		it("maps resolve_terminal_path to GET with null-passthrough transform", () => {
			const result = mapCommandToHttp("resolve_terminal_path", { cwd: "/repo", candidate: "src/x.ts" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/fs/resolve-terminal-path?cwd=%2Frepo&candidate=src%2Fx.ts");
			expect(result.transform?.({ absolute_path: "/repo/src/x.ts", is_directory: false })).toEqual({
				absolute_path: "/repo/src/x.ts",
				is_directory: false,
			});
			expect(result.transform?.(null)).toBeNull();
		});

		// POST, not GET: a screenful of candidates does not belong in a query
		// string, and the whole point of the batch is that it can be large.
		it("maps resolve_terminal_paths to POST with the candidates in the body", () => {
			const result = mapCommandToHttp("resolve_terminal_paths", {
				cwd: "/repo",
				candidates: ["src/x.ts", "missing.ts"],
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/resolve-terminal-paths");
			expect(result.body).toEqual({ cwd: "/repo", candidates: ["src/x.ts", "missing.ts"] });
		});

		it("maps stat_path to GET /fs/stat?path=", () => {
			const result = mapCommandToHttp("stat_path", { path: "/repo/file.md" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/fs/stat?path=%2Frepo%2Ffile.md");
		});

		it("maps warm_content_index to POST /fs/warm-index", () => {
			const result = mapCommandToHttp("warm_content_index", { repoPath: "/repo" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/warm-index");
			expect(result.body).toEqual({ repoPath: "/repo" });
		});

		it("maps write_external_file to POST /fs/write-external", () => {
			const result = mapCommandToHttp("write_external_file", { path: "/repo/a.md", content: "hi" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/write-external");
			expect(result.body).toEqual({ path: "/repo/a.md", content: "hi" });
		});

		it("maps copy_path_abs to POST /fs/copy-abs", () => {
			const result = mapCommandToHttp("copy_path_abs", { from: "/a/x", to: "/b/x" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/copy-abs");
			expect(result.body).toEqual({ from: "/a/x", to: "/b/x" });
		});

		it("maps move_path_abs to POST /fs/move-abs", () => {
			const result = mapCommandToHttp("move_path_abs", { from: "/a/x", to: "/b/x" });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/move-abs");
			expect(result.body).toEqual({ from: "/a/x", to: "/b/x" });
		});

		it("maps fs_transfer_paths to POST /fs/transfer", () => {
			const result = mapCommandToHttp("fs_transfer_paths", {
				destDir: "/repo/dst",
				paths: ["/a/x", "/a/y"],
				mode: "move",
				allowRecursive: true,
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/fs/transfer");
			expect(result.body).toEqual({
				destDir: "/repo/dst",
				paths: ["/a/x", "/a/y"],
				mode: "move",
				allowRecursive: true,
			});
		});

		// --- PTY/terminal read commands (story 062) ---
		it("maps get_shell_state to GET with {state} unwrap transform", () => {
			const result = mapCommandToHttp("get_shell_state", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/shell-state");
			expect(result.transform?.({ state: "busy" })).toBe("busy");
			expect(result.transform?.({ state: null })).toBeNull();
		});

		it("maps get_last_prompt to GET with {prompt} unwrap transform", () => {
			const result = mapCommandToHttp("get_last_prompt", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/last-prompt");
			expect(result.transform?.({ prompt: "do the thing" })).toBe("do the thing");
			expect(result.transform?.({ prompt: null })).toBeNull();
		});

		it("maps get_input_buffer_content to GET with {content} unwrap transform", () => {
			const result = mapCommandToHttp("get_input_buffer_content", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/input-buffer");
			expect(result.transform?.({ content: "ls -la" })).toBe("ls -la");
		});

		it("maps get_session_leaf_pid to GET with {pid} unwrap transform", () => {
			const result = mapCommandToHttp("get_session_leaf_pid", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/leaf-pid");
			expect(result.transform?.({ pid: 4321 })).toBe(4321);
			expect(result.transform?.({ pid: null })).toBeNull();
		});

		it("maps has_foreground_process to GET with {process} unwrap transform", () => {
			const result = mapCommandToHttp("has_foreground_process", { sessionId: "s1" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/has-foreground");
			expect(result.transform?.({ process: "htop" })).toBe("htop");
			expect(result.transform?.({ process: null })).toBeNull();
		});

		it("maps set_session_visible to POST /sessions/{id}/visible", () => {
			const result = mapCommandToHttp("set_session_visible", { sessionId: "s1", visible: false });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/sessions/s1/visible");
			expect(result.body).toEqual({ visible: false });
		});

		it("maps get_process_stats to GET /process/stats", () => {
			const result = mapCommandToHttp("get_process_stats", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/process/stats");
		});

		it("maps terminal_get_selection_text to GET with {text} unwrap transform", () => {
			const result = mapCommandToHttp("terminal_get_selection_text", {
				sessionId: "s1",
				startRow: 1,
				startCol: 2,
				endRow: 3,
				endCol: 4,
			});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/selection-text?startRow=1&startCol=2&endRow=3&endCol=4");
			expect(result.transform?.({ text: "hello" })).toBe("hello");
		});

		it("maps terminal_get_logical_line to GET (tuple array, no transform)", () => {
			const result = mapCommandToHttp("terminal_get_logical_line", { sessionId: "s1", row: 7 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/logical-line?row=7");
			expect(result.transform).toBeUndefined();
		});

		it("maps terminal_hyperlink_span to GET with null-passthrough transform", () => {
			const result = mapCommandToHttp("terminal_hyperlink_span", { sessionId: "s1", row: 2, col: 5 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/sessions/s1/terminal/hyperlink-span?row=2&col=5");
			expect(result.transform?.([2, 9, "https://x.dev"])).toEqual([2, 9, "https://x.dev"]);
			expect(result.transform?.(null)).toBeNull();
		});

		// --- Claude Usage dashboard (story 063) ---
		it("maps get_claude_usage_api to GET /claude/usage", () => {
			const result = mapCommandToHttp("get_claude_usage_api", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/claude/usage");
		});

		it("maps get_claude_project_list to GET /claude/projects", () => {
			const result = mapCommandToHttp("get_claude_project_list", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/claude/projects");
		});

		it("maps get_claude_usage_timeline to GET with scope + days", () => {
			const result = mapCommandToHttp("get_claude_usage_timeline", { scope: "all", days: 7 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/claude/timeline?scope=all&days=7");
		});

		it("maps get_claude_usage_timeline omitting days when absent", () => {
			const result = mapCommandToHttp("get_claude_usage_timeline", { scope: "my-proj" });
			expect(result.path).toBe("/claude/timeline?scope=my-proj");
		});

		it("maps get_claude_session_stats to GET with scope", () => {
			const result = mapCommandToHttp("get_claude_session_stats", { scope: "current" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/claude/session-stats?scope=current");
		});

		// --- Git panel (story 064) ---
		it("maps get_gutter_changes to GET with optional scope", () => {
			const a = mapCommandToHttp("get_gutter_changes", { path: "/r", file: "a.ts", scope: "head" });
			expect(a.method).toBe("GET");
			expect(a.path).toBe("/repo/gutter-changes?path=%2Fr&file=a.ts&scope=head");
			const b = mapCommandToHttp("get_gutter_changes", { path: "/r", file: "a.ts" });
			expect(b.path).toBe("/repo/gutter-changes?path=%2Fr&file=a.ts");
		});

		it("maps get_branches_detail to GET /repo/branches-detail", () => {
			const result = mapCommandToHttp("get_branches_detail", { path: "/r" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/branches-detail?path=%2Fr");
		});

		it("maps get_recent_branches with optional limit", () => {
			expect(mapCommandToHttp("get_recent_branches", { path: "/r", limit: 5 }).path).toBe(
				"/repo/recent-branches?path=%2Fr&limit=5",
			);
			expect(mapCommandToHttp("get_recent_branches", { path: "/r" }).path).toBe("/repo/recent-branches?path=%2Fr");
		});

		it("maps get_branch_base to GET with null-passthrough transform", () => {
			const result = mapCommandToHttp("get_branch_base", { path: "/r", branchName: "feat" });
			expect(result.path).toBe("/repo/branch-base?path=%2Fr&branchName=feat");
			expect(result.transform?.("main")).toBe("main");
			expect(result.transform?.(null)).toBeNull();
		});

		it("maps check_worktree_dirty to GET", () => {
			const result = mapCommandToHttp("check_worktree_dirty", { repoPath: "/r", branchName: "feat" });
			expect(result.path).toBe("/repo/worktree-dirty?repoPath=%2Fr&branchName=feat");
		});

		it("maps list_base_ref_options to GET", () => {
			expect(mapCommandToHttp("list_base_ref_options", { repoPath: "/r" }).path).toBe(
				"/repo/base-ref-options?repoPath=%2Fr",
			);
		});

		it("maps generate_clone_branch_name_cmd to POST", () => {
			const result = mapCommandToHttp("generate_clone_branch_name_cmd", {
				sourceBranch: "main",
				existingNames: ["a", "b"],
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/clone-branch-name");
			expect(result.body).toEqual({ sourceBranch: "main", existingNames: ["a", "b"] });
		});

		it("maps get_commit_graph with optional count", () => {
			expect(mapCommandToHttp("get_commit_graph", { path: "/r", count: 200 }).path).toBe(
				"/repo/commit-graph?path=%2Fr&count=200",
			);
			expect(mapCommandToHttp("get_commit_graph", { path: "/r" }).path).toBe("/repo/commit-graph?path=%2Fr");
		});

		it("maps create_branch to POST", () => {
			const result = mapCommandToHttp("create_branch", {
				path: "/r",
				name: "feat",
				startPoint: "main",
				checkout: true,
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/create-branch");
			expect(result.body).toEqual({ path: "/r", name: "feat", startPoint: "main", checkout: true });
		});

		it("maps delete_branch to POST", () => {
			const result = mapCommandToHttp("delete_branch", { path: "/r", name: "feat", force: false });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/delete-branch");
			expect(result.body).toEqual({ path: "/r", name: "feat", force: false });
		});

		it("maps delete_local_branch to POST", () => {
			const result = mapCommandToHttp("delete_local_branch", {
				repoPath: "/r",
				branchName: "feat",
				keepWorktree: true,
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/delete-local-branch");
			expect(result.body).toEqual({ repoPath: "/r", branchName: "feat", keepWorktree: true });
		});

		it("maps update_from_base to POST", () => {
			const result = mapCommandToHttp("update_from_base", {
				path: "/r",
				branchName: "feat",
				strategy: "rebase",
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/update-from-base");
			expect(result.body).toEqual({ path: "/r", branchName: "feat", strategy: "rebase" });
		});

		it("maps switch_branch to POST", () => {
			const result = mapCommandToHttp("switch_branch", {
				repoPath: "/r",
				branchName: "feat",
				force: false,
				stash: true,
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/switch-branch");
			expect(result.body).toEqual({ repoPath: "/r", branchName: "feat", force: false, stash: true });
		});

		it("maps merge_and_archive_worktree to POST", () => {
			const result = mapCommandToHttp("merge_and_archive_worktree", {
				repoPath: "/r",
				branchName: "feat",
				targetBranch: "main",
				afterMerge: "archive",
			});
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/merge-archive-worktree");
			expect(result.body).toEqual({
				repoPath: "/r",
				branchName: "feat",
				targetBranch: "main",
				afterMerge: "archive",
				force: undefined,
			});
		});

		it("forwards the merge_and_archive_worktree force flag over HTTP", () => {
			const result = mapCommandToHttp("merge_and_archive_worktree", {
				repoPath: "/r",
				branchName: "feat",
				targetBranch: "main",
				afterMerge: "archive",
				force: true,
			});
			expect(result.body).toEqual({
				repoPath: "/r",
				branchName: "feat",
				targetBranch: "main",
				afterMerge: "archive",
				force: true,
			});
		});

		it("forwards the finalize_merged_worktree force flag over HTTP", () => {
			// Finalize ends in `git worktree remove --force` just like merge-and-archive,
			// so the confirmation override has to reach the backend on both transports.
			const guarded = mapCommandToHttp("finalize_merged_worktree", {
				repoPath: "/r",
				branchName: "feat",
				action: "archive",
			});
			expect(guarded.method).toBe("POST");
			expect(guarded.path).toBe("/worktrees/finalize");
			expect(guarded.body).toEqual({
				repoPath: "/r",
				branchName: "feat",
				action: "archive",
				force: undefined,
			});

			const forced = mapCommandToHttp("finalize_merged_worktree", {
				repoPath: "/r",
				branchName: "feat",
				action: "archive",
				force: true,
			});
			expect(forced.body).toEqual({
				repoPath: "/r",
				branchName: "feat",
				action: "archive",
				force: true,
			});
		});

		it("maps close_issue to POST", () => {
			const result = mapCommandToHttp("close_issue", { repoPath: "/r", issueNumber: 42 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/issues/close");
			expect(result.body).toEqual({ repoPath: "/r", issueNumber: 42 });
		});

		it("maps reopen_issue to POST", () => {
			const result = mapCommandToHttp("reopen_issue", { repoPath: "/r", issueNumber: 42 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/issues/reopen");
			expect(result.body).toEqual({ repoPath: "/r", issueNumber: 42 });
		});

		it("maps get_issue_detail to GET", () => {
			const result = mapCommandToHttp("get_issue_detail", { repoPath: "/r", issueNumber: 42 });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/issue-detail?repoPath=%2Fr&issueNumber=42");
		});

		it("maps GitHub write primitives to HTTP", () => {
			const pr = mapCommandToHttp("create_pr", {
				repoPath: "/r",
				title: "Fix bug",
				body: "Details",
				base: "main",
				head: "fix/bug",
				draft: true,
			});
			expect(pr.method).toBe("POST");
			expect(pr.path).toBe("/repo/create-pr");
			expect(pr.body).toEqual({
				repoPath: "/r",
				title: "Fix bug",
				body: "Details",
				base: "main",
				head: "fix/bug",
				draft: true,
			});

			const issue = mapCommandToHttp("create_issue", { repoPath: "/r", title: "Bug", body: "Broken" });
			expect(issue.method).toBe("POST");
			expect(issue.path).toBe("/repo/create-issue");
			expect(issue.body).toEqual({ repoPath: "/r", title: "Bug", body: "Broken" });

			const proposal = { issue_title: "Improve tests", issue_body: "Acceptance:\n- covered" };
			const proposalIssue = mapCommandToHttp("create_issue_from_proposal", { repoPath: "/r", proposal });
			expect(proposalIssue.method).toBe("POST");
			expect(proposalIssue.path).toBe("/repo/create-issue-from-proposal");
			expect(proposalIssue.body).toEqual({ repoPath: "/r", proposal });

			const review = mapCommandToHttp("post_pr_review", {
				repoPath: "/r",
				prNumber: 42,
				body: "Review",
				event: "COMMENT",
				comments: [{ path: "src/main.rs", line: 10, side: "RIGHT", body: "Check this" }],
			});
			expect(review.method).toBe("POST");
			expect(review.path).toBe("/repo/post-pr-review");
			expect(review.body).toEqual({
				repoPath: "/r",
				prNumber: 42,
				body: "Review",
				event: "COMMENT",
				comments: [{ path: "src/main.rs", line: 10, side: "RIGHT", body: "Check this" }],
			});
		});

		it("maps get_merged_prs to GET with optional sinceTag", () => {
			const noTag = mapCommandToHttp("get_merged_prs", { repoPath: "/r" });
			expect(noTag.method).toBe("GET");
			expect(noTag.path).toBe("/repo/merged-prs?path=%2Fr");

			const withTag = mapCommandToHttp("get_merged_prs", { repoPath: "/r", sinceTag: "v1.2.0" });
			expect(withTag.path).toBe("/repo/merged-prs?path=%2Fr&sinceTag=v1.2.0");
		});

		it("maps generate_changelog to GET with optional sinceTag", () => {
			const noTag = mapCommandToHttp("generate_changelog", { repoPath: "/r" });
			expect(noTag.method).toBe("GET");
			expect(noTag.path).toBe("/repo/changelog?path=%2Fr");

			const withTag = mapCommandToHttp("generate_changelog", { repoPath: "/r", sinceTag: "v1.2.0" });
			expect(withTag.path).toBe("/repo/changelog?path=%2Fr&sinceTag=v1.2.0");
		});

		it("maps start_conflict_assist to POST", () => {
			const result = mapCommandToHttp("start_conflict_assist", { repoPath: "/r", prNumber: 7 });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/repo/conflict-assist");
			expect(result.body).toEqual({ repoPath: "/r", prNumber: 7 });
		});

		it("maps get_github_viewer_login to GET", () => {
			const result = mapCommandToHttp("get_github_viewer_login", {});
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/github/viewer-login");
		});

		it("maps fetch_ci_failure_logs to GET with query", () => {
			const result = mapCommandToHttp("fetch_ci_failure_logs", { repoPath: "/r", branch: "feat" });
			expect(result.method).toBe("GET");
			expect(result.path).toBe("/repo/ci-failure-logs?repoPath=%2Fr&branch=feat");
		});

		it("maps github_set_pr_hide_drafts to POST", () => {
			const result = mapCommandToHttp("github_set_pr_hide_drafts", { hide: true });
			expect(result.method).toBe("POST");
			expect(result.path).toBe("/github/pr-hide-drafts");
			expect(result.body).toEqual({ hide: true });
		});

		it("maps github device-code auth flow", () => {
			expect(mapCommandToHttp("github_start_login", {}).path).toBe("/github/auth/start");
			expect(mapCommandToHttp("github_start_login", {}).method).toBe("POST");
			const poll = mapCommandToHttp("github_poll_login", { deviceCode: "abc" });
			expect(poll.method).toBe("POST");
			expect(poll.path).toBe("/github/auth/poll");
			expect(poll.body).toEqual({ deviceCode: "abc" });
			const addPoll = mapCommandToHttp("github_poll_add_account", { deviceCode: "def" });
			expect(addPoll.method).toBe("POST");
			expect(addPoll.path).toBe("/github/auth/poll");
			expect(addPoll.body).toEqual({ deviceCode: "def" });
			expect(mapCommandToHttp("github_logout", {}).path).toBe("/github/auth/logout");
			expect(mapCommandToHttp("github_disconnect", {}).path).toBe("/github/auth/disconnect");
			expect(mapCommandToHttp("github_auth_status", {}).path).toBe("/github/auth/status");
			expect(mapCommandToHttp("github_auth_status", {}).method).toBe("GET");
			expect(mapCommandToHttp("github_diagnostics", {}).path).toBe("/github/diagnostics");
		});

		it("maps multi-account accounts + repo bindings", () => {
			expect(mapCommandToHttp("github_list_accounts", {}).method).toBe("GET");
			expect(mapCommandToHttp("github_list_accounts", {}).path).toBe("/github/accounts");

			const add = mapCommandToHttp("github_add_account", { host: "ghe.acme.com", pat: "ghp_x" });
			expect(add.method).toBe("POST");
			expect(add.path).toBe("/github/accounts");
			expect(add.body).toEqual({ host: "ghe.acme.com", pat: "ghp_x" });

			const rm = mapCommandToHttp("github_remove_account", { id: "ghe.acme.com" });
			expect(rm.method).toBe("POST");
			expect(rm.path).toBe("/github/accounts/remove");
			expect(rm.body).toEqual({ id: "ghe.acme.com" });

			expect(mapCommandToHttp("github_list_bindings", {}).path).toBe("/github/bindings");
			expect(mapCommandToHttp("github_list_bindings", {}).method).toBe("GET");

			const bind = mapCommandToHttp("github_bind_repo", {
				repoPath: "/my/repo",
				accountId: "ghe.acme.com",
				remoteName: "origin",
			});
			expect(bind.method).toBe("POST");
			expect(bind.path).toBe("/github/bindings");
			expect(bind.body).toEqual({ repoPath: "/my/repo", accountId: "ghe.acme.com", remoteName: "origin" });

			const unbind = mapCommandToHttp("github_unbind_repo", { repoPath: "/my/repo" });
			expect(unbind.method).toBe("POST");
			expect(unbind.path).toBe("/github/bindings/remove");
			expect(unbind.body).toEqual({ repoPath: "/my/repo" });

			const resolve = mapCommandToHttp("github_resolve_repo", { repoPath: "/my/repo" });
			expect(resolve.method).toBe("GET");
			expect(resolve.path).toBe("/github/resolve-repo?repoPath=%2Fmy%2Frepo");

			const resolveBatch = mapCommandToHttp("github_resolve_repos", { repoPaths: ["/a", "/b"] });
			expect(resolveBatch.method).toBe("POST");
			expect(resolveBatch.path).toBe("/github/resolve-repos");
			expect(resolveBatch.body).toEqual({ repoPaths: ["/a", "/b"] });
		});

		it("maps ai-prompts load/save", () => {
			expect(mapCommandToHttp("load_ai_prompts", {}).path).toBe("/config/ai-prompts");
			expect(mapCommandToHttp("load_ai_prompts", {}).method).toBe("GET");
			const save = mapCommandToHttp("save_ai_prompts", { config: { a: 1 } });
			expect(save.method).toBe("PUT");
			expect(save.path).toBe("/config/ai-prompts");
			expect(save.body).toEqual({ a: 1 });
		});

		it("maps note asset commands", () => {
			const img = mapCommandToHttp("save_note_image", {
				noteId: "n1",
				dataBase64: "AAA",
				extension: "png",
			});
			expect(img.path).toBe("/config/note-image");
			expect(img.body).toEqual({ noteId: "n1", dataBase64: "AAA", extension: "png" });
			expect(mapCommandToHttp("delete_note_assets", { noteId: "n1" }).path).toBe("/config/note-assets/delete");
			const batch = mapCommandToHttp("delete_note_assets_batch", { noteIds: ["a", "b"] });
			expect(batch.path).toBe("/config/note-assets/delete-batch");
			expect(batch.body).toEqual({ noteIds: ["a", "b"] });
		});

		it("maps config/themes/mcp-upstreams commands", () => {
			expect(mapCommandToHttp("list_themes", {}).path).toBe("/config/themes");
			const rlc = mapCommandToHttp("save_repo_local_config", { repoPath: "/r" });
			expect(rlc.method).toBe("POST");
			expect(rlc.body).toEqual({ repoPath: "/r" });
			const bl = mapCommandToHttp("set_branch_label", {
				repoPath: "/r",
				branchName: "feat",
				label: "x",
			});
			expect(bl.path).toBe("/config/branch-label");
			expect(bl.body).toEqual({ repoPath: "/r", branchName: "feat", label: "x" });
			const up = mapCommandToHttp("set_project_mcp_upstreams", {
				repoPath: "/r",
				upstreamNames: ["a"],
			});
			expect(up.path).toBe("/config/project-mcp-upstreams");
			expect(up.body).toEqual({ repoPath: "/r", upstreamNames: ["a"] });
		});

		it("maps misc command parity (shell/audio/agent/generators/registry)", () => {
			const sh = mapCommandToHttp("execute_shell_script", {
				scriptContent: "echo hi",
				timeoutMs: 5000,
				repoPath: "/r",
			});
			expect(sh.method).toBe("POST");
			expect(sh.path).toBe("/exec/shell-script");
			expect(sh.body).toEqual({ scriptContent: "echo hi", timeoutMs: 5000, repoPath: "/r" });
			expect(mapCommandToHttp("list_audio_output_devices", {}).path).toBe("/audio/output-devices");
			const disc = mapCommandToHttp("discover_agent_session", {
				agentType: "claude",
				cwd: "/r",
				claimedIds: [],
				agentPid: 123,
				envOverrides: {},
			});
			expect(disc.path).toBe("/agent/discover-session");
			expect(disc.body).toEqual({
				agentType: "claude",
				cwd: "/r",
				claimedIds: [],
				agentPid: 123,
				envOverrides: {},
			});
			expect(mapCommandToHttp("claude_project_dir", { cwd: "/r", claudeConfigDir: null }).path).toBe(
				"/agent/claude-project-dir",
			);
			const oic = mapCommandToHttp("open_in_custom", {
				executable: "code",
				args: ["-g"],
				ctx: { repo: "/r" },
			});
			expect(oic.path).toBe("/agent/open-in-custom");
			expect(oic.body).toEqual({ executable: "code", args: ["-g"], ctx: { repo: "/r" } });
			const gen = mapCommandToHttp("generate_value", { request: { type: "password" } });
			expect(gen.path).toBe("/generators/generate");
			expect(gen.body).toEqual({ request: { type: "password" } });
			expect(mapCommandToHttp("fetch_plugin_registry", {}).path).toBe("/registry/plugins");
		});

		it("maps AI watcher CRUD (story 070)", () => {
			expect(mapCommandToHttp("watcher_list", {}).path).toBe("/ai/watchers");
			expect(mapCommandToHttp("watcher_list", {}).method).toBe("GET");
			const create = mapCommandToHttp("watcher_create", {
				name: "w1",
				sessionId: "s1",
				trigger: { type: "Idle" },
				instructions: "do it",
				promptId: null,
				repoPath: "/r",
				maxFires: 3,
				cooldownSecs: 30,
			});
			expect(create.method).toBe("POST");
			expect(create.path).toBe("/ai/watchers");
			expect(create.body).toEqual({
				name: "w1",
				sessionId: "s1",
				trigger: { type: "Idle" },
				instructions: "do it",
				promptId: null,
				repoPath: "/r",
				maxFires: 3,
				cooldownSecs: 30,
			});
			expect(mapCommandToHttp("watcher_update", { id: "x" }).path).toBe("/ai/watchers/update");
			expect(mapCommandToHttp("watcher_delete", { id: "x" }).body).toEqual({ id: "x" });
			expect(mapCommandToHttp("watcher_toggle", { id: "x", enabled: true }).body).toEqual({
				id: "x",
				enabled: true,
			});
			expect(mapCommandToHttp("watcher_attach", { templateId: "t", sessionId: "s" }).body).toEqual({
				templateId: "t",
				sessionId: "s",
			});
			expect(mapCommandToHttp("watcher_detach", { id: "x" }).path).toBe("/ai/watchers/detach");
		});

		it("maps AI chat config + conversation CRUD (story 069)", () => {
			expect(mapCommandToHttp("load_ai_chat_config", {}).path).toBe("/ai/chat/config");
			const save = mapCommandToHttp("save_ai_chat_config", { config: { temperature: 0.5 } });
			expect(save.method).toBe("PUT");
			expect(save.path).toBe("/ai/chat/config");
			expect(save.body).toEqual({ temperature: 0.5 });
			expect(mapCommandToHttp("list_conversations", {}).path).toBe("/ai/chat/conversations");
			expect(mapCommandToHttp("load_conversation", { id: "abc" }).path).toBe("/ai/chat/conversation?id=abc");
			const sc = mapCommandToHttp("save_conversation", { conversation: { meta: { id: "abc" } } });
			expect(sc.method).toBe("POST");
			expect(sc.path).toBe("/ai/chat/conversation");
			expect(sc.body).toEqual({ meta: { id: "abc" } });
			const del = mapCommandToHttp("delete_conversation", { id: "abc" });
			expect(del.path).toBe("/ai/chat/conversation/delete");
			expect(del.body).toEqual({ id: "abc" });
			expect(mapCommandToHttp("new_conversation_id", {}).method).toBe("POST");
			expect(mapCommandToHttp("new_conversation_id", {}).path).toBe("/ai/chat/new-id");
		});

		it("maps agent loop control + knowledge + scheduler (story 068)", () => {
			for (const cmd of ["cancel_conversation", "pause_conversation", "resume_conversation"]) {
				const r = mapCommandToHttp(cmd, { sessionId: "s1" });
				expect(r.method).toBe("POST");
				expect(r.path).toBe(`/ai/conversation/${cmd.split("_")[0]}`);
				expect(r.body).toEqual({ sessionId: "s1" });
			}
			const ap = mapCommandToHttp("approve_conversation_action", { sessionId: "s1", approved: true });
			expect(ap.path).toBe("/ai/conversation/approve");
			expect(ap.body).toEqual({ sessionId: "s1", approved: true });
			expect(mapCommandToHttp("get_session_knowledge", { sessionId: "s1" }).path).toBe(
				"/ai/session-knowledge?sessionId=s1",
			);
			expect(mapCommandToHttp("toggle_ai_suggestions", { sessionId: "s1" }).path).toBe("/ai/suggestions/toggle");
			const lk = mapCommandToHttp("list_knowledge_sessions", { filter: { text: "x" }, limit: 50 });
			expect(lk.method).toBe("POST");
			expect(lk.path).toBe("/ai/knowledge/sessions");
			expect(lk.body).toEqual({ filter: { text: "x" }, limit: 50 });
			expect(mapCommandToHttp("get_knowledge_session_detail", { sessionId: "s1" }).path).toBe(
				"/ai/knowledge/session?sessionId=s1",
			);
			expect(mapCommandToHttp("load_scheduler_config", {}).path).toBe("/ai/scheduler/config");
			const ss = mapCommandToHttp("save_scheduler_config", { config: { jobs: [] } });
			expect(ss.method).toBe("PUT");
			expect(ss.body).toEqual({ jobs: [] });
		});

		it("maps run_diff_triage trigger (event-bridge plan Step 2)", () => {
			const r = mapCommandToHttp("run_diff_triage", { repoPath: "/r", refresh: true });
			expect(r.method).toBe("POST");
			expect(r.path).toBe("/ai/triage/run");
			expect(r.body).toEqual({ repoPath: "/r", refresh: true });
		});

		it("maps run_pr_review trigger", () => {
			const r = mapCommandToHttp("run_pr_review", { repoPath: "/r", prNumber: 42 });
			expect(r.method).toBe("POST");
			expect(r.path).toBe("/ai/review/pr");
			expect(r.body).toEqual({ repoPath: "/r", prNumber: 42 });
		});

		it("maps run_improvement_scan trigger", () => {
			const r = mapCommandToHttp("run_improvement_scan", { repoPath: "/r", focus: "testing" });
			expect(r.method).toBe("POST");
			expect(r.path).toBe("/ai/improvements/scan");
			expect(r.body).toEqual({ repoPath: "/r", focus: "testing" });
		});

		it("maps plugin RPC commands (story 071)", () => {
			// plugin_read_file
			const rf = mapCommandToHttp("plugin_read_file", { pluginId: "my-plugin", path: "/home/user/f.txt" });
			expect(rf.method).toBe("GET");
			expect(rf.path).toBe("/api/plugins/my-plugin/fs/read?path=%2Fhome%2Fuser%2Ff.txt");

			// plugin_read_files — the batch read goes in the body: a query string
			// cannot carry hundreds of paths.
			const rfs = mapCommandToHttp("plugin_read_files", {
				pluginId: "my-plugin",
				paths: ["/home/user/a.md", "/home/user/b.md"],
			});
			expect(rfs.method).toBe("POST");
			expect(rfs.path).toBe("/api/plugins/my-plugin/fs/read-batch");
			expect(rfs.body).toEqual({ paths: ["/home/user/a.md", "/home/user/b.md"] });

			// plugin_read_file_base64
			const rfb = mapCommandToHttp("plugin_read_file_base64", { pluginId: "my-plugin", path: "/home/user/f.docx" });
			expect(rfb.method).toBe("GET");
			expect(rfb.path).toBe("/api/plugins/my-plugin/fs/read-base64?path=%2Fhome%2Fuser%2Ff.docx");

			// plugin_read_file_tail
			const tail = mapCommandToHttp("plugin_read_file_tail", {
				pluginId: "my-plugin",
				path: "/home/user/f.log",
				maxBytes: 4096,
			});
			expect(tail.method).toBe("GET");
			expect(tail.path).toBe("/api/plugins/my-plugin/fs/tail?path=%2Fhome%2Fuser%2Ff.log&maxBytes=4096");

			// plugin_list_directory — with optional params
			const listBase = mapCommandToHttp("plugin_list_directory", { pluginId: "my-plugin", path: "/home/user/dir" });
			expect(listBase.method).toBe("GET");
			expect(listBase.path).toBe("/api/plugins/my-plugin/fs/list?path=%2Fhome%2Fuser%2Fdir");
			const listFull = mapCommandToHttp("plugin_list_directory", {
				pluginId: "my-plugin",
				path: "/home/user/dir",
				pattern: "*.log",
				sortBy: "mtime",
			});
			expect(listFull.path).toContain("pattern=*.log");
			expect(listFull.path).toContain("sortBy=mtime");

			// plugin_write_file
			const wf = mapCommandToHttp("plugin_write_file", {
				pluginId: "my-plugin",
				path: "/home/user/out.txt",
				content: "hello",
			});
			expect(wf.method).toBe("POST");
			expect(wf.path).toBe("/api/plugins/my-plugin/fs/write");
			expect(wf.body).toEqual({ path: "/home/user/out.txt", content: "hello" });

			// plugin_rename_path
			const rn = mapCommandToHttp("plugin_rename_path", {
				pluginId: "my-plugin",
				from: "/home/user/a.txt",
				to: "/home/user/b.txt",
			});
			expect(rn.method).toBe("POST");
			expect(rn.path).toBe("/api/plugins/my-plugin/fs/rename");
			expect(rn.body).toEqual({ from: "/home/user/a.txt", to: "/home/user/b.txt" });

			// scan_build_artifacts
			const scan = mapCommandToHttp("scan_build_artifacts", {
				pluginId: "build-cleaner",
				repoPaths: ["/home/user/repoA", "/home/user/repoB"],
			});
			expect(scan.method).toBe("POST");
			expect(scan.path).toBe("/api/plugins/build-cleaner/build-artifacts/scan");
			expect(scan.body).toEqual({ repoPaths: ["/home/user/repoA", "/home/user/repoB"] });
			const forcedScan = mapCommandToHttp("scan_build_artifacts", {
				pluginId: "build-cleaner",
				repoPaths: ["/home/user/repoA"],
				forceRefresh: true,
			});
			expect(forcedScan.body).toEqual({ repoPaths: ["/home/user/repoA"], forceRefresh: true });

			// delete_build_artifact
			const del = mapCommandToHttp("delete_build_artifact", {
				pluginId: "build-cleaner",
				path: "/home/user/repoA/target",
				repoPaths: ["/home/user/repoA"],
			});
			expect(del.method).toBe("POST");
			expect(del.path).toBe("/api/plugins/build-cleaner/build-artifacts/delete");
			expect(del.body).toEqual({ path: "/home/user/repoA/target", repoPaths: ["/home/user/repoA"] });

			// trim_build_artifact — same body as delete, different route. A browser
			// client must be able to reclaim intermediates without the desktop app.
			const trim = mapCommandToHttp("trim_build_artifact", {
				pluginId: "build-cleaner",
				path: "/home/user/repoA/target",
				repoPaths: ["/home/user/repoA"],
			});
			expect(trim.method).toBe("POST");
			expect(trim.path).toBe("/api/plugins/build-cleaner/build-artifacts/trim");
			expect(trim.body).toEqual({ path: "/home/user/repoA/target", repoPaths: ["/home/user/repoA"] });

			// plugin_exec_cli
			const ex = mapCommandToHttp("plugin_exec_cli", {
				pluginId: "my-plugin",
				binary: "mdkb",
				args: ["--version"],
				cwd: "/home/user",
			});
			expect(ex.method).toBe("POST");
			expect(ex.path).toBe("/api/plugins/my-plugin/exec");
			expect(ex.body).toEqual({ binary: "mdkb", args: ["--version"], cwd: "/home/user" });

			// plugin_http_fetch
			const hf = mapCommandToHttp("plugin_http_fetch", {
				pluginId: "my-plugin",
				url: "https://api.example.com/data",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			expect(hf.method).toBe("POST");
			expect(hf.path).toBe("/api/plugins/my-plugin/http");
			expect(hf.body).toEqual({
				url: "https://api.example.com/data",
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});

			// plugin_read_session_output — with and without maxLines
			const pty = mapCommandToHttp("plugin_read_session_output", {
				pluginId: "my-plugin",
				sessionId: "sess-1",
			});
			expect(pty.method).toBe("GET");
			expect(pty.path).toBe("/api/plugins/my-plugin/pty/output?sessionId=sess-1");
			const ptyLines = mapCommandToHttp("plugin_read_session_output", {
				pluginId: "my-plugin",
				sessionId: "sess-1",
				maxLines: 100,
			});
			expect(ptyLines.path).toContain("maxLines=100");

			// register_loaded_plugin
			const reg = mapCommandToHttp("register_loaded_plugin", {
				pluginId: "my-plugin",
				capabilities: ["fs:read", "net:http"],
			});
			expect(reg.method).toBe("POST");
			expect(reg.path).toBe("/api/plugins/my-plugin/register");
			expect(reg.body).toEqual({ capabilities: ["fs:read", "net:http"] });

			// unregister_loaded_plugin
			const unreg = mapCommandToHttp("unregister_loaded_plugin", { pluginId: "my-plugin" });
			expect(unreg.method).toBe("POST");
			expect(unreg.path).toBe("/api/plugins/my-plugin/unregister");

			// get_plugin_readme_path — null passthrough transform
			const readme = mapCommandToHttp("get_plugin_readme_path", { id: "my-plugin" });
			expect(readme.method).toBe("GET");
			expect(readme.path).toBe("/api/plugins/my-plugin/readme");
			expect(readme.transform?.("/path/to/README.md")).toBe("/path/to/README.md");
			expect(readme.transform?.(null)).toBeNull();
		});

		it("maps provider keyring + slot/ollama checks (story 072)", () => {
			const exists = mapCommandToHttp("get_provider_api_key_exists", { providerId: "anthropic-main" });
			expect(exists.method).toBe("GET");
			expect(exists.path).toBe("/config/provider-key/exists?providerId=anthropic-main");

			const save = mapCommandToHttp("save_provider_api_key", { providerId: "anthropic-main", key: "sk-ant-1" });
			expect(save.method).toBe("POST");
			expect(save.path).toBe("/config/provider-key");
			expect(save.body).toEqual({ providerId: "anthropic-main", key: "sk-ant-1" });

			const del = mapCommandToHttp("delete_provider_api_key", { providerId: "anthropic-main" });
			expect(del.method).toBe("DELETE");
			expect(del.path).toBe("/config/provider-key");
			expect(del.body).toEqual({ providerId: "anthropic-main" });

			const slot = mapCommandToHttp("test_slot_connection", { slot: "main" });
			expect(slot.method).toBe("POST");
			expect(slot.path).toBe("/config/slot-test");
			expect(slot.body).toEqual({ slot: "main" });

			const ollama = mapCommandToHttp("check_ollama_models", { providerId: "ollama-local" });
			expect(ollama.method).toBe("POST");
			expect(ollama.path).toBe("/config/ollama-models");
			expect(ollama.body).toEqual({ providerId: "ollama-local" });
		});

		it("maps agent detection and spawn aliases to HTTP", () => {
			const detectClaude = mapCommandToHttp("detect_claude_binary", {});
			expect(detectClaude.method).toBe("GET");
			expect(detectClaude.path).toBe("/agents/detect?binary=claude");
			expect(detectClaude.transform?.({ path: "/usr/local/bin/claude" })).toBe("/usr/local/bin/claude");

			const spawn = mapCommandToHttp("spawn_agent", {
				pty_config: { rows: 30, cols: 100, cwd: "/repo" },
				agent_config: { prompt: "fix it", agent_type: "codex", model: "gpt-5" },
			});
			expect(spawn.method).toBe("POST");
			expect(spawn.path).toBe("/sessions/agent");
			expect(spawn.body).toEqual({
				rows: 30,
				cols: 100,
				cwd: "/repo",
				prompt: "fix it",
				agent_type: "codex",
				model: "gpt-5",
			});
			expect(spawn.transform?.({ session_id: "s1" })).toBe("s1");
		});
	});

	describe("INTENTIONALLY_UNMAPPED (native/host-only commands)", () => {
		it("classifies renamed async wrappers by their public IPC name", () => {
			const registeredCommands = extractRegisteredTauriCommands();

			expect(registeredCommands.has("load_activity")).toBe(true);
			expect(registeredCommands.has("load_activity_async")).toBe(false);
		});

		it("classifies every registered Tauri command as HTTP-mapped or intentionally host-only", () => {
			const mappedCommands = extractCommandTableCommands();
			const registeredCommands = extractRegisteredTauriCommands();
			const uncoveredCommands = Array.from(registeredCommands)
				.filter((command) => !mappedCommands.has(command) && !INTENTIONALLY_UNMAPPED.has(command))
				.sort();

			expect(uncoveredCommands).toEqual([]);
		});

		it("raises a precise native-only error, not a generic missing-mapping error", () => {
			for (const command of INTENTIONALLY_UNMAPPED) {
				expect(() => mapCommandToHttp(command, {})).toThrow(/native\/host-only/);
			}
		});

		it("covers the documented native-only command families", () => {
			// Sentinels from each group in the story 073 spec.
			for (const cmd of [
				"open_panel_window",
				"start_native_drag",
				"block_sleep",
				"set_global_hotkey",
				"check_microphone_permission",
				"get_connect_url",
				"regenerate_session_token",
				"get_tailscale_status",
				"mcp_oauth_callback",
				"install_cli",
				"set_last_seen_version",
				"install_mdkb",
				"subscribe_terminal_grid",
				"ack_terminal_frame",
				// story 071 desktop-only plugin commands
				"plugin_watch_path",
				"plugin_unwatch",
				"plugin_read_credential",
				"install_plugin_from_zip",
				"install_plugin_from_folder",
				"install_plugin_from_url",
				"uninstall_plugin",
				"delete_plugin_data",
			]) {
				expect(INTENTIONALLY_UNMAPPED.has(cmd)).toBe(true);
			}
		});

		it("does not also have a COMMAND_TABLE mapping (would be contradictory)", () => {
			// If a command were both mapped and listed unmapped, mapCommandToHttp would
			// succeed and the native-only error would be dead. Guard against that drift.
			for (const command of INTENTIONALLY_UNMAPPED) {
				let mapped = true;
				try {
					mapCommandToHttp(command, {});
				} catch {
					mapped = false;
				}
				expect(mapped).toBe(false);
			}
		});
	});

	describe("rpc()", () => {
		const originalFetch = globalThis.fetch;
		const originalTauri = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
		const discoverArgs = {
			agentType: "claude",
			cwd: "/repo",
			claimedIds: [],
			agentPid: 123,
			envOverrides: {},
		};

		function jsonResponse(body: string, status = 200, statusText = "OK") {
			return {
				ok: status >= 200 && status < 300,
				status,
				statusText,
				headers: new Headers({ "content-type": "application/json" }),
				text: vi.fn().mockResolvedValue(body),
			};
		}

		beforeEach(() => {
			// Ensure non-Tauri mode for HTTP tests
			delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
		});

		afterEach(() => {
			globalThis.fetch = originalFetch;
			if (originalTauri !== undefined) {
				(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = originalTauri;
			} else {
				delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
			}
		});

		it("uses fetch in non-Tauri mode with JSON response", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({ "content-type": "application/json" }),
				text: vi.fn().mockResolvedValue('{"sessions":[]}'),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc<{ sessions: unknown[] }>("list_active_sessions");
			expect(result).toEqual({ sessions: [] });
			expect(globalThis.fetch).toHaveBeenCalledWith(
				expect.stringContaining("/sessions"),
				expect.objectContaining({ method: "GET" }),
			);
		});

		it("returns a decoded JSON null response as null", async () => {
			const { rpc } = await import("../transport");
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse("null"));

			await expect(rpc<string | null>("discover_agent_session", discoverArgs)).resolves.toBeNull();
		});

		it("preserves a decoded non-null JSON response", async () => {
			const { rpc } = await import("../transport");
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse('"agent-session-1"'));

			await expect(rpc<string | null>("discover_agent_session", discoverArgs)).resolves.toBe("agent-session-1");
		});

		it("rejects a zero-length JSON response with command context", async () => {
			const { rpc } = await import("../transport");
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse(""));

			await expect(rpc("discover_agent_session", discoverArgs)).rejects.toThrow(
				"RPC discover_agent_session: empty response body",
			);
		});

		it("rejects malformed JSON with command context", async () => {
			const { rpc } = await import("../transport");
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse("{"));

			await expect(rpc("discover_agent_session", discoverArgs)).rejects.toThrow(
				"RPC discover_agent_session: invalid JSON response",
			);
		});

		it("rejects a non-success JSON response with command context", async () => {
			const { rpc } = await import("../transport");
			globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse("backend unavailable", 503, "Service Unavailable"));

			await expect(rpc("discover_agent_session", discoverArgs)).rejects.toThrow(
				"RPC discover_agent_session failed: 503 backend unavailable",
			);
		});

		/** Drives a burst of writes with the first request held open, and reports
		 *  each request as the list of inputs it carried. */
		async function burstWrites(
			rpc: (c: string, a: Record<string, unknown>) => Promise<unknown>,
			datas: string[],
		): Promise<{ url: string; parts: string[] }[]> {
			const requests: { url: string; parts: string[] }[] = [];
			let releaseFirst: (() => void) | undefined;
			const firstSent = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			globalThis.fetch = vi.fn().mockImplementation((url: string, init: { body: string }) => {
				const body = JSON.parse(init.body);
				requests.push({ url, parts: body.parts ?? [body.data] });
				const settle = requests.length === 1 ? firstSent : Promise.resolve();
				return settle.then(() => ({
					ok: true,
					headers: new Headers({ "content-type": "application/json" }),
					text: vi.fn().mockResolvedValue("{}"),
				}));
			});
			const writes = datas.map((data) => rpc("write_pty", { sessionId: "s1", data }));
			releaseFirst?.();
			await Promise.all(writes);
			return requests;
		}

		it("coalesces keystrokes typed while a write is in flight", async () => {
			// Browser mode posts one HTTP request per keystroke and awaits each before
			// sending the next, so typing speed is capped at one character per RTT.
			const { rpc } = await import("../transport");

			const requests = await burstWrites(rpc, ["h", "e", "l", "l", "o"]);

			expect(requests.flatMap((r) => r.parts).join("")).toBe("hello");
			expect(requests.length).toBeLessThan(5);
			expect(requests[0].parts).toEqual(["h"]);
		});

		it("keeps coalesced keystrokes separate instead of joining them", async () => {
			// The bytes reaching the PTY are the same either way, but `write_pty` is
			// not a byte pipe: the backend runs its per-input bookkeeping once per
			// REQUEST, and that is not a function of the concatenated bytes. A lone
			// "/" opens slash mode; an Escape dismisses it. Joined into "\x1b/" the
			// backend reads a dismissal and the slash menu never opens — so what
			// piles up must travel as parts, not as one string.
			const { rpc } = await import("../transport");

			const requests = await burstWrites(rpc, ["\x1b", "/", "h"]);

			const coalesced = requests.slice(1);
			expect(coalesced.length).toBeGreaterThan(0);
			for (const request of coalesced) {
				expect(request.url).toContain("/write-parts");
			}
			expect(coalesced.flatMap((r) => r.parts)).toEqual(["/", "h"]);
		});

		it("sends a solitary keystroke on the single-input route", async () => {
			// Nothing piled up behind it, so there is no batch — and routing it
			// through the N-ary path would change nothing except the shape.
			const { rpc } = await import("../transport");
			const requests = await burstWrites(rpc, ["x"]);
			expect(requests).toHaveLength(1);
			expect(requests[0].url).toContain("/write");
			expect(requests[0].url).not.toContain("/write-parts");
			expect(requests[0].parts).toEqual(["x"]);
		});

		it("collapses a resize burst to the newest dimensions", async () => {
			// A drag-resize fires one resize_pty per frame and never awaits the last
			// one. The backend reflows on the blocking pool, so two resizes in flight
			// race for the per-session lock and can be applied newest-first: the PTY
			// is left at the OLDER size while the frontend has already recorded the
			// newer one, and nothing corrects it until the next physical resize.
			// Only the newest size means anything, so only the newest may follow the
			// request already in flight — an intermediate size in flight is an
			// intermediate size that can land last.
			const { rpc } = await import("../transport");

			const sent: Array<{ rows: number; cols: number }> = [];
			let releaseFirst: (() => void) | undefined;
			const firstSent = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			globalThis.fetch = vi.fn().mockImplementation((_url: string, init: { body: string }) => {
				const { rows, cols } = JSON.parse(init.body);
				sent.push({ rows, cols });
				const settle = sent.length === 1 ? firstSent : Promise.resolve();
				return settle.then(() => ({
					ok: true,
					headers: new Headers({ "content-type": "application/json" }),
					text: vi.fn().mockResolvedValue("{}"),
				}));
			});

			const resizes = [
				rpc("resize_pty", { sessionId: "s1", rows: 10, cols: 40 }),
				rpc("resize_pty", { sessionId: "s1", rows: 20, cols: 80 }),
				rpc("resize_pty", { sessionId: "s1", rows: 30, cols: 120 }),
				rpc("resize_pty", { sessionId: "s1", rows: 40, cols: 160 }),
			];
			releaseFirst?.();
			await Promise.all(resizes);

			expect(sent[0]).toEqual({ rows: 10, cols: 40 });
			expect(sent[sent.length - 1]).toEqual({ rows: 40, cols: 160 });
			expect(sent).toHaveLength(2);
		});

		it("keeps one session's resize out of another's", async () => {
			// The queue is keyed per session for the same reason the write queue is:
			// collapsing across sessions would drop a real resize, not a stale one.
			const { rpc } = await import("../transport");

			const seen: Array<{ url: string; rows: number }> = [];
			globalThis.fetch = vi.fn().mockImplementation((url: string, init: { body: string }) => {
				seen.push({ url, rows: JSON.parse(init.body).rows });
				return Promise.resolve({
					ok: true,
					headers: new Headers({ "content-type": "application/json" }),
					text: vi.fn().mockResolvedValue("{}"),
				});
			});

			await Promise.all([
				rpc("resize_pty", { sessionId: "a", rows: 10, cols: 40 }),
				rpc("resize_pty", { sessionId: "b", rows: 20, cols: 80 }),
			]);

			expect(seen.filter((s) => s.url.includes("/sessions/a/")).map((s) => s.rows)).toEqual([10]);
			expect(seen.filter((s) => s.url.includes("/sessions/b/")).map((s) => s.rows)).toEqual([20]);
		});

		it("keeps each session's keystrokes to itself", async () => {
			const { rpc } = await import("../transport");
			const seen: Array<{ url: string; data: string }> = [];
			globalThis.fetch = vi.fn().mockImplementation((url: string, init: { body: string }) => {
				seen.push({ url, data: JSON.parse(init.body).data });
				return Promise.resolve({
					ok: true,
					headers: new Headers({ "content-type": "application/json" }),
					text: vi.fn().mockResolvedValue("{}"),
				});
			});

			await Promise.all([
				rpc("write_pty", { sessionId: "a", data: "1" }),
				rpc("write_pty", { sessionId: "b", data: "2" }),
				rpc("write_pty", { sessionId: "a", data: "3" }),
			]);

			const a = seen.filter((s) => s.url.includes("/sessions/a/")).map((s) => s.data);
			const b = seen.filter((s) => s.url.includes("/sessions/b/")).map((s) => s.data);
			expect(a.join("")).toBe("13");
			expect(b.join("")).toBe("2");
		});

		it("sends body for POST requests", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({ "content-type": "application/json" }),
				text: vi.fn().mockResolvedValue('{"id":"sess-1"}'),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			await rpc("create_pty", { config: { rows: 24, cols: 80, shell: null, cwd: "/tmp" } });
			const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(fetchCall[1].body).toBeDefined();
			expect(JSON.parse(fetchCall[1].body)).toEqual({ rows: 24, cols: 80, shell: null, cwd: "/tmp" });
		});

		// Styled row chunks are packed bytes, ~141 KB each. Reading them with
		// `text()` (the pre-binary path) hands the decoder a mojibake string, and
		// `json()` throws. The content-type is what tells the two apart.
		it("reads an octet-stream response as an ArrayBuffer", async () => {
			const { rpc } = await import("../transport");

			const payload = new Uint8Array([26, 0, 200, 7]);
			const mockResponse = {
				ok: true,
				headers: new Headers({ "content-type": "application/octet-stream" }),
				arrayBuffer: vi.fn().mockResolvedValue(payload.buffer),
				json: vi.fn(),
				text: vi.fn(),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc<ArrayBuffer>("terminal_styled_rows", {
				sessionId: "s1",
				start: 0,
				count: 64,
			});
			expect(result).toBeInstanceOf(ArrayBuffer);
			expect([...new Uint8Array(result)]).toEqual([26, 0, 200, 7]);
			expect(mockResponse.text).not.toHaveBeenCalled();
			expect(mockResponse.json).not.toHaveBeenCalled();
		});

		// A dead session answers with zero bytes. That is a valid empty chunk, and
		// the generic "empty response body" guard must not turn it into a throw.
		it("accepts an empty octet-stream body", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({ "content-type": "application/octet-stream" }),
				arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc<ArrayBuffer>("terminal_styled_rows", {
				sessionId: "s1",
				start: 0,
				count: 64,
			});
			expect(result.byteLength).toBe(0);
		});

		it("handles text response without content-type as JSON fallback", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({}),
				text: vi.fn().mockResolvedValue('{"result":"ok"}'),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc("get_orchestrator_stats");
			expect(result).toEqual({ result: "ok" });
		});

		it("returns plain text when response is not JSON", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({}),
				text: vi.fn().mockResolvedValue("plain text response"),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc("get_orchestrator_stats");
			expect(result).toBe("plain text response");
		});

		it("throws on non-ok response", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: false,
				status: 500,
				statusText: "Internal Server Error",
				text: vi.fn().mockResolvedValue("Something went wrong"),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			await expect(rpc("get_orchestrator_stats")).rejects.toThrow("RPC get_orchestrator_stats failed: 500");
		});

		it("applies transform when present", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: true,
				headers: new Headers({ "content-type": "application/json" }),
				text: vi.fn().mockResolvedValue('{"active_sessions":2,"max_sessions":5}'),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc<boolean>("can_spawn_session");
			expect(result).toBe(true);
		});

		it("returns null on 404 when notFoundAsNull is set (read_plugin_data)", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: vi.fn().mockResolvedValue(""),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			const result = await rpc<string | null>("read_plugin_data", { pluginId: "p", path: "missing-key" });
			expect(result).toBeNull();
		});

		it("still throws on non-404 errors even with notFoundAsNull", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: false,
				status: 400,
				statusText: "Bad Request",
				text: vi.fn().mockResolvedValue("bad path"),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			await expect(rpc("read_plugin_data", { pluginId: "p", path: "../escape" })).rejects.toThrow(
				"RPC read_plugin_data failed: 400",
			);
		});

		it("handles resp.text() failure in error path", async () => {
			const { rpc } = await import("../transport");

			const mockResponse = {
				ok: false,
				status: 502,
				statusText: "Bad Gateway",
				text: vi.fn().mockRejectedValue(new Error("read failed")),
			};
			globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

			await expect(rpc("get_orchestrator_stats")).rejects.toThrow("Bad Gateway");
		});
	});

	describe("subscribePty()", () => {
		const originalTauri = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;

		beforeEach(() => {
			// Ensure non-Tauri mode for WebSocket tests
			delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
		});

		afterEach(() => {
			if (originalTauri !== undefined) {
				(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = originalTauri;
			} else {
				delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
			}
		});

		it("creates WebSocket in browser mode and subscribes to events", async () => {
			const { subscribePty } = await import("../transport");

			let wsInstance: {
				onopen: (() => void) | null;
				onmessage: ((event: { data: string }) => void) | null;
				onclose: ((event: { wasClean: boolean; code: number; reason: string }) => void) | null;
				onerror: ((e: unknown) => void) | null;
				close: () => void;
			};

			class MockWebSocket {
				onopen: (() => void) | null = null;
				onmessage: ((event: { data: string }) => void) | null = null;
				onclose: ((event: { wasClean: boolean; code: number; reason: string }) => void) | null = null;
				onerror: ((e: unknown) => void) | null = null;
				close = vi.fn();
				constructor() {
					wsInstance = this;
				}
			}

			const origWs = globalThis.WebSocket;
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

			const onData = vi.fn();
			const onExit = vi.fn();

			const subscribePromise = subscribePty("sess-1", onData, onExit);

			// Trigger onopen to resolve
			wsInstance!.onopen!();
			const unsub = await subscribePromise;

			// Simulate data
			wsInstance!.onmessage!({ data: "hello" });
			expect(onData).toHaveBeenCalledWith("hello");

			// Simulate clean close
			wsInstance!.onclose!({ wasClean: true, code: 1000, reason: "" });
			expect(onExit).toHaveBeenCalled();

			// Unsubscribe closes WS
			unsub();
			expect(wsInstance!.close).toHaveBeenCalled();

			globalThis.WebSocket = origWs;
		});

		it("routes the WebSocket activity frame to onActivity, not onData", async () => {
			const { subscribePty } = await import("../transport");

			let wsInstance: {
				onopen: (() => void) | null;
				onmessage: ((event: { data: string }) => void) | null;
				onclose: (() => void) | null;
				onerror: unknown;
				close: () => void;
			};

			class MockWebSocket {
				onopen: (() => void) | null = null;
				onmessage: ((event: { data: string }) => void) | null = null;
				onclose: (() => void) | null = null;
				onerror: unknown = null;
				close = vi.fn();
				constructor() {
					wsInstance = this as never;
				}
			}

			const origWs = globalThis.WebSocket;
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

			const onData = vi.fn();
			const onActivity = vi.fn();
			const subscribePromise = subscribePty("sess-1", onData, vi.fn(), { onActivity });
			wsInstance!.onopen!();
			const unsub = await subscribePromise;

			wsInstance!.onmessage!({ data: JSON.stringify({ type: "activity", session_id: "sess-1" }) });

			expect(onActivity).toHaveBeenCalledTimes(1);
			// The pulse carries no output; anything else would mean the browser is
			// still deriving activity from bytes while desktop is not.
			expect(onData).not.toHaveBeenCalled();

			unsub();
			globalThis.WebSocket = origWs;
		});

		it("routes the Tauri activity event to onActivity and subscribes to no output event", async () => {
			const { listen } = await import("@tauri-apps/api/event");
			const handlers = new Map<string, (event: { payload: unknown }) => void>();
			vi.mocked(listen).mockImplementation((async (name: string, handler: never) => {
				handlers.set(name, handler);
				return vi.fn();
			}) as never);

			(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};
			const { subscribePty } = await import("../transport");

			const onData = vi.fn();
			const onActivity = vi.fn();
			const unsub = await subscribePty("sess-1", onData, vi.fn(), { onActivity });

			expect([...handlers.keys()]).toContain("pty-activity-sess-1");
			// The regression: a listener for an event Rust no longer emits.
			expect([...handlers.keys()].filter((name) => name.startsWith("pty-output"))).toEqual([]);

			handlers.get("pty-activity-sess-1")!({ payload: { session_id: "sess-1" } });
			expect(onActivity).toHaveBeenCalledTimes(1);
			expect(onData).not.toHaveBeenCalled();

			unsub();
			vi.mocked(listen).mockReset();
			vi.mocked(listen).mockResolvedValue(vi.fn());
		});

		it("logs warning and schedules reconnect on abnormal WebSocket close", async () => {
			const { subscribePty } = await import("../transport");

			let wsInstance: {
				onopen: (() => void) | null;
				onclose: ((event: { wasClean: boolean; code: number; reason: string }) => void) | null;
				onmessage: unknown;
				onerror: unknown;
				close: () => void;
			};

			class MockWebSocket {
				onopen: (() => void) | null = null;
				onmessage: unknown = null;
				onclose: ((event: { wasClean: boolean; code: number; reason: string }) => void) | null = null;
				onerror: unknown = null;
				close = vi.fn();
				constructor() {
					wsInstance = this;
				}
			}

			const origWs = globalThis.WebSocket;
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

			const debugSpy = vi.fn();
			setTransportLogger({ debug: debugSpy, warn: vi.fn() });
			const onExit = vi.fn();

			const subscribePromise = subscribePty("sess-1", vi.fn(), onExit);
			wsInstance!.onopen!();
			const unsub = await subscribePromise;

			// Abnormal close triggers reconnect, not onExit
			wsInstance!.onclose!({ wasClean: false, code: 1006, reason: "" });
			expect(debugSpy).toHaveBeenCalledWith("network", expect.stringContaining("abnormally"));
			// onExit is NOT called on abnormal close — the transport schedules a reconnect instead
			expect(onExit).not.toHaveBeenCalled();

			unsub();
			setTransportLogger({ debug: vi.fn(), warn: vi.fn() });
			globalThis.WebSocket = origWs;
		});

		it("log mode reconnect resumes from the tracked cursor, not the mount offset", async () => {
			const { subscribePty } = await import("../transport");
			vi.useFakeTimers();

			const instances: {
				url: string;
				onopen: (() => void) | null;
				onmessage: ((e: { data: string }) => void) | null;
				onclose: ((e: { code: number; reason?: string }) => void) | null;
				onerror: unknown;
				close: () => void;
			}[] = [];

			class MockWebSocket {
				url: string;
				onopen: (() => void) | null = null;
				onmessage: ((e: { data: string }) => void) | null = null;
				onclose: ((e: { code: number; reason?: string }) => void) | null = null;
				onerror: unknown = null;
				close = vi.fn();
				constructor(url: string) {
					this.url = url;
					instances.push(this as never);
				}
			}

			const origWs = globalThis.WebSocket;
			globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;

			// Mount in log mode with the HTTP-fetched offset (50).
			const subscribePromise = subscribePty("sess-1", vi.fn(), vi.fn(), { format: "log", logOffset: 50 });
			instances[0].onopen?.();
			const unsub = await subscribePromise;
			expect(instances[0].url).toContain("offset=50");

			// Server advances the monotonic line cursor to 80 via a log frame.
			instances[0].onmessage?.({
				data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "x" }] }], offset: 50, total_lines: 80 }),
			});

			// Abnormal close → reconnect after backoff.
			instances[0].onclose?.({ code: 1006 });
			await vi.advanceTimersByTimeAsync(1000);

			// Reconnect must resume from the consumed cursor (80), NOT replay from mount (50).
			expect(instances.length).toBe(2);
			expect(instances[1].url).toContain("offset=80");
			expect(instances[1].url).not.toContain("offset=50");

			// Complete the reconnect handshake so the in-flight connect() promise settles.
			// (A real browser WebSocket fires onclose on close(); the mock does not, so an
			// unsettled connect() promise would otherwise leak past the test.)
			instances[1].onopen?.();

			unsub();
			globalThis.WebSocket = origWs;
			vi.useRealTimers();
		});

		/**
		 * A backgrounded PWA must stop draining the socket, and the naive way to
		 * do that ships two silent bugs: `ws.close()` looks exactly like a session
		 * exit to the close handler, and re-subscribing from scratch replays from
		 * the MOUNT offset because the live cursor is closure-private. So pause and
		 * resume live here, next to the cursor they have to preserve.
		 */
		describe("pause/resume", () => {
			interface FakeWs {
				url: string;
				onopen: (() => void) | null;
				onmessage: ((e: { data: string }) => void) | null;
				onclose: ((e: { code: number; reason?: string }) => void) | null;
				onerror: unknown;
				close: ReturnType<typeof vi.fn>;
			}

			let instances: FakeWs[] = [];
			let origWs: typeof WebSocket;

			beforeEach(() => {
				instances = [];
				class MockWebSocket {
					url: string;
					onopen: (() => void) | null = null;
					onmessage: ((e: { data: string }) => void) | null = null;
					onclose: ((e: { code: number; reason?: string }) => void) | null = null;
					onerror: unknown = null;
					close = vi.fn();
					constructor(url: string) {
						this.url = url;
						instances.push(this as unknown as FakeWs);
					}
				}
				origWs = globalThis.WebSocket;
				globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
			});

			afterEach(() => {
				globalThis.WebSocket = origWs;
			});

			/** Mount in log mode at the given offset and settle the handshake. */
			async function mount(onExit = vi.fn(), opts: Record<string, unknown> = {}) {
				const { subscribePty } = await import("../transport");
				const onLogLines = vi.fn();
				const pending = subscribePty("sess-1", vi.fn(), onExit, {
					format: "log",
					logOffset: 50,
					onLogLines,
					...opts,
				});
				instances[0].onopen?.();
				return { sub: await pending, onExit, onLogLines };
			}

			it("closes the socket on pause without reporting a session exit", async () => {
				const { sub, onExit } = await mount();

				sub.pause();
				// A real socket answers close() with onclose, and 1000 is the code the
				// live handler reads as "the session is over".
				instances[0].onclose?.({ code: 1000 });

				expect(instances[0].close).toHaveBeenCalled();
				expect(onExit).not.toHaveBeenCalled();
			});

			it("delivers nothing that arrives after a pause", async () => {
				const { sub, onLogLines } = await mount();

				sub.pause();
				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "late" }] }], total_lines: 99 }),
				});

				expect(onLogLines).not.toHaveBeenCalled();
			});

			it("resumes from the live cursor, not the mount offset", async () => {
				const { sub } = await mount();

				// Server advances the consumed line cursor to 80.
				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "x" }] }], total_lines: 80 }),
				});
				sub.pause();
				instances[0].onclose?.({ code: 1000 });
				sub.resume();

				expect(instances.length).toBe(2);
				expect(instances[1].url).toContain("offset=80");
				expect(instances[1].url).not.toContain("offset=50");
				instances[1].onopen?.();
			});

			it("delivers again after a resume", async () => {
				const { sub, onLogLines } = await mount();

				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				instances[1].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "back" }] }], total_lines: 81 }),
				});

				expect(onLogLines).toHaveBeenCalledTimes(1);
			});

			it("does not open a second socket when resume follows no pause", async () => {
				const { sub } = await mount();

				sub.resume();

				expect(instances.length).toBe(1);
			});

			it("does not reconnect while paused", async () => {
				vi.useFakeTimers();
				const { sub } = await mount();

				sub.pause();
				// An abnormal code is the reconnect trigger; a paused subscription
				// must not race the backoff timer against its own resume.
				instances[0].onclose?.({ code: 1006 });
				await vi.advanceTimersByTimeAsync(60_000);

				expect(instances.length).toBe(1);
				vi.useRealTimers();
			});

			it("cancels a pending reconnect when it is paused mid-backoff", async () => {
				vi.useFakeTimers();
				const { sub } = await mount();

				instances[0].onclose?.({ code: 1006 });
				sub.pause();
				await vi.advanceTimersByTimeAsync(60_000);

				expect(instances.length).toBe(1);
				vi.useRealTimers();
			});

			/**
			 * Pause suppresses DATA, never lifecycle. Swallowing the exit frame
			 * would leave the view showing a live session until the reconnect
			 * backoff finally gave up — ten attempts, roughly three minutes — and
			 * on desktop, where there is no socket to fail, forever.
			 */
			it("reports a session exit that arrives while paused", async () => {
				const { sub, onExit } = await mount();

				sub.pause();
				instances[0].onmessage?.({ data: JSON.stringify({ type: "exit" }) });

				expect(onExit).toHaveBeenCalledTimes(1);
			});

			it("does not reopen the socket after an exit seen while paused", async () => {
				const { sub } = await mount();

				sub.pause();
				instances[0].onmessage?.({ data: JSON.stringify({ type: "exit" }) });
				sub.resume();

				expect(instances.length).toBe(1);
			});

			it("still reports the exit on desktop while paused", async () => {
				const { listen } = await import("@tauri-apps/api/event");
				const handlers = new Map<string, (event: { payload: unknown }) => void>();
				vi.mocked(listen).mockImplementation((async (name: string, handler: never) => {
					handlers.set(name, handler);
					return vi.fn();
				}) as never);
				(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {};

				const { subscribePty } = await import("../transport");
				const onExit = vi.fn();
				const onActivity = vi.fn();
				const sub = await subscribePty("sess-1", vi.fn(), onExit, { onActivity });

				sub.pause();
				handlers.get("pty-activity-sess-1")?.({ payload: {} });
				handlers.get("pty-exit-sess-1")?.({ payload: {} });

				expect(onActivity).not.toHaveBeenCalled();
				expect(onExit).toHaveBeenCalledTimes(1);

				sub();
				delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
				vi.mocked(listen).mockReset();
				vi.mocked(listen).mockResolvedValue(vi.fn());
			});

			/**
			 * `close()` is asynchronous: the socket a pause dropped can still fire
			 * its handlers after the resume that replaced it. A `paused` flag alone
			 * cannot see that — by then the flag is false again — so the guard has
			 * to be socket identity, not subscription state.
			 */
			it("ignores data from the socket it already paused, even after resume", async () => {
				const { sub, onLogLines } = await mount();

				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "a" }] }], total_lines: 80 }),
				});
				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				onLogLines.mockClear();

				// The dropped socket flushes what it had buffered, late.
				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "stale" }] }], total_lines: 200 }),
				});

				expect(onLogLines).not.toHaveBeenCalled();
			});

			it("does not let a stale socket's cursor rewrite the live one", async () => {
				const { sub } = await mount();

				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "a" }] }], total_lines: 80 }),
				});
				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				// A late frame from the dropped socket claiming a cursor we never
				// consumed. If it were tracked, the NEXT reconnect would resume past
				// lines the user never saw.
				instances[0].onmessage?.({
					data: JSON.stringify({ type: "log", lines: [{ spans: [{ text: "stale" }] }], total_lines: 999 }),
				});

				sub.pause();
				sub.resume();
				instances[2].onopen?.();

				expect(instances[2].url).toContain("offset=80");
				expect(instances[2].url).not.toContain("offset=999");
			});

			it("does not read a stale socket's close as a session exit", async () => {
				const { sub, onExit } = await mount();

				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				instances[0].onclose?.({ code: 1000 });

				expect(onExit).not.toHaveBeenCalled();
			});

			it("does not reconnect on a stale socket's abnormal close", async () => {
				vi.useFakeTimers();
				const { sub } = await mount();

				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				instances[0].onclose?.({ code: 1006 });
				await vi.advanceTimersByTimeAsync(60_000);

				expect(instances.length).toBe(2);
				vi.useRealTimers();
			});

			/**
			 * The window a pause can land in is not just "connected": a backoff
			 * timer may already have called connect(), which assigns the socket
			 * synchronously but resolves much later. That in-flight attempt has to
			 * be superseded, or its late failure schedules a reconnect of its own
			 * and the session ends up on two live sockets at once.
			 */
			it("does not open a parallel socket when a pause lands mid-connect", async () => {
				vi.useFakeTimers();
				const { sub } = await mount();

				instances[0].onclose?.({ code: 1006 });
				await vi.advanceTimersByTimeAsync(1000);
				expect(instances.length).toBe(2); // the backoff attempt, still opening

				sub.pause();
				sub.resume();
				instances[2].onopen?.();
				// The superseded attempt now reports its failure, late.
				instances[1].onclose?.({ code: 1006 });
				await vi.advanceTimersByTimeAsync(60_000);

				expect(instances.length).toBe(3);
				vi.useRealTimers();
			});

			it("closes an attempt that opens after it was superseded", async () => {
				vi.useFakeTimers();
				const { sub } = await mount();

				instances[0].onclose?.({ code: 1006 });
				await vi.advanceTimersByTimeAsync(1000);
				sub.pause();
				sub.resume();
				instances[2].onopen?.();
				instances[1].close.mockClear();
				// The superseded attempt completes its handshake anyway. Left open it
				// would stream a second copy of the session at the server's expense.
				instances[1].onopen?.();

				expect(instances[1].close).toHaveBeenCalled();
				vi.useRealTimers();
			});

			it("gives up for good once the retry budget is spent", async () => {
				vi.useFakeTimers();
				const { sub, onExit } = await mount();

				// Ten failures is MAX_RETRIES; the eleventh close is the one that
				// finds the budget spent.
				for (let i = 0; i < 11; i++) {
					instances[instances.length - 1].onclose?.({ code: 1006 });
					await vi.advanceTimersByTimeAsync(60_000);
				}
				expect(onExit).toHaveBeenCalledTimes(1);

				const opened = instances.length;
				sub.pause();
				sub.resume();
				await vi.advanceTimersByTimeAsync(60_000);

				// A dead subscription stays dead. Refilling the budget on every
				// hide/show would let a session that is gone retry forever, and
				// report its exit again each time the budget ran out.
				expect(instances.length).toBe(opened);
				expect(onExit).toHaveBeenCalledTimes(1);
				vi.useRealTimers();
			});

			/**
			 * Exit frames and retry exhaustion are terminal. A clean close is the
			 * same news arriving by a third route, so it has to be terminal too —
			 * otherwise the session is declared exited to the consumer while the
			 * subscription still believes it can be reopened.
			 */
			it("treats a clean close as terminal, so hide/show cannot reopen it", async () => {
				const { sub, onExit } = await mount();

				instances[0].onclose?.({ code: 1000 });
				expect(onExit).toHaveBeenCalledTimes(1);

				sub.pause();
				sub.resume();

				expect(instances.length).toBe(1);
				expect(onExit).toHaveBeenCalledTimes(1);
			});

			it("reports the reconnection that a pause interrupted", async () => {
				const onReconnecting = vi.fn();
				const onReconnected = vi.fn();
				const { sub } = await mount(vi.fn(), { onReconnecting, onReconnected });

				instances[0].onclose?.({ code: 1006 });
				expect(onReconnecting).toHaveBeenCalledTimes(1);

				// The user backgrounds the page mid-backoff and comes back. The
				// socket is healthy again, so a consumer told "reconnecting" must be
				// told it finished — otherwise its banner never comes down.
				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				await Promise.resolve();

				expect(onReconnected).toHaveBeenCalledTimes(1);
			});

			it("does not announce a reconnection for a resume that never lost one", async () => {
				const onReconnected = vi.fn();
				const { sub } = await mount(vi.fn(), { onReconnected });

				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				await Promise.resolve();

				expect(onReconnected).not.toHaveBeenCalled();
			});

			/**
			 * The reconnect callbacks sit on the same promise chain as `connect()`.
			 * A consumer that throws inside `onReconnected` would land in the
			 * rejection handler and be read as a failed connection — announcing a
			 * reconnect that never broke and opening a second socket alongside the
			 * healthy one. A consumer's bug must not become a transport failure.
			 */
			it("does not read a throwing onReconnected as a failed connection", async () => {
				const onReconnecting = vi.fn();
				const onReconnected = vi.fn(() => {
					throw new Error("consumer blew up");
				});
				const { sub } = await mount(vi.fn(), { onReconnecting, onReconnected });

				instances[0].onclose?.({ code: 1006 });
				sub.pause();
				sub.resume();
				instances[1].onopen?.();
				await Promise.resolve();
				await Promise.resolve();

				expect(onReconnected).toHaveBeenCalledTimes(1);
				// One announcement, from the abnormal close that really happened.
				expect(onReconnecting).toHaveBeenCalledTimes(1);
			});

			it("stays disposed when pause or resume arrive after unsubscribe", async () => {
				const { sub } = await mount();

				sub();
				sub.pause();
				sub.resume();

				expect(instances.length).toBe(1);
			});
		});
	});
});
