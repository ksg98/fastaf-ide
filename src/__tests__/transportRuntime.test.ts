import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getRemoteBaseUrl,
	getRemoteToken,
	previewLogPayload,
	resolveOwningConnection,
	setRemoteBaseUrlLookup,
	setRemoteTokenLookup,
	setRepoConnectionLookup,
	setSessionConnectionLookup,
	setTransportLogger,
	transportLogger,
	withRemoteToken,
} from "../transportRuntime";

describe("transport runtime ports", () => {
	it("uses injected logging and remote connection lookup without store imports", () => {
		const debug = vi.fn();
		const warn = vi.fn();
		setTransportLogger({ debug, warn });
		setRemoteBaseUrlLookup((id) => (id === "connected" ? "http://remote.test" : undefined));

		transportLogger().debug("network", "connected");
		expect(debug).toHaveBeenCalledWith("network", "connected");
		expect(getRemoteBaseUrl("connected")).toBe("http://remote.test");
		expect(getRemoteBaseUrl("missing")).toBeUndefined();
	});

	// HTTP, WebSocket and SSE all reach the same daemon; only the query string can
	// carry a credential on all three, so one helper builds it for all three.
	describe("withRemoteToken", () => {
		it("appends the token, choosing the right separator", () => {
			setRemoteTokenLookup((id) => (id === "c1" ? "tok-abc" : undefined));
			expect(getRemoteToken("c1")).toBe("tok-abc");
			expect(withRemoteToken("http://remote.test/api/version", "c1")).toBe(
				"http://remote.test/api/version?token=tok-abc",
			);
			expect(withRemoteToken("ws://remote.test/sessions/s1/stream?format=grid", "c1")).toBe(
				"ws://remote.test/sessions/s1/stream?format=grid&token=tok-abc",
			);
		});

		it("leaves a local call untouched — it has no connection id and needs none", () => {
			setRemoteTokenLookup(() => "tok-abc");
			expect(withRemoteToken("/sessions")).toBe("/sessions");
		});

		// A connection that needs no credential (a desktop instance on the LAN)
		// holds no token; signing its URL with "undefined" would break it.
		it("leaves the URL untouched when the connection holds no token", () => {
			setRemoteTokenLookup(() => undefined);
			expect(withRemoteToken("http://remote.test/api/version", "c1")).toBe("http://remote.test/api/version");
		});
	});

	it("bounds malformed payload previews", () => {
		expect(previewLogPayload("short")).toBe("short");
		expect(previewLogPayload("x".repeat(501))).toBe(`${"x".repeat(500)}...`);
	});
});

/**
 * Which machine every RPC in the app reaches.
 *
 * This resolver runs for every call, and it decides from the call's own
 * arguments rather than from anything the caller threaded through — which is
 * what makes routing mechanical, and what makes a change to it silent. The
 * ordering below is load-bearing in both directions: a repo could start
 * reaching the wrong machine, or a remote repo could stop being routed at all,
 * and nothing else in the suite would notice.
 */
describe("resolveOwningConnection", () => {
	const SESSION = "sess-on-tycho";
	const REPO = "/Volumes/work/api";
	const TYCHO = "conn-tycho";
	const CERES = "conn-ceres";

	beforeEach(() => {
		setSessionConnectionLookup((id) => (id === SESSION ? TYCHO : undefined));
		setRepoConnectionLookup((path) => (path.startsWith(REPO) ? CERES : undefined));
	});

	afterEach(() => {
		setSessionConnectionLookup(() => undefined);
		setRepoConnectionLookup(() => undefined);
	});

	it.each(["sessionId", "session_id", "id"])("reads a session from the top-level %s", (key) => {
		expect(resolveOwningConnection({ [key]: SESSION })).toBe(TYCHO);
	});

	// A PTY spawn names its session inside the config it is given, not beside it.
	it("reads a session out of a nested pty_config", () => {
		expect(resolveOwningConnection({ pty_config: { sessionId: SESSION } })).toBe(TYCHO);
	});

	it.each(["repoPath", "repo_path", "path", "cwd", "worktreePath", "base_repo", "project"])(
		"reads a repository from the top-level %s",
		(key) => {
			expect(resolveOwningConnection({ [key]: `${REPO}/src/main.rs` })).toBe(CERES);
		},
	);

	// Narrower than the top-level list on purpose: `config` is also the app's
	// whole settings object, so only the two keys a spawn request carries are
	// read inside a bag.
	it("reads a repository out of a nested worktree_config", () => {
		expect(resolveOwningConnection({ worktree_config: { base_repo: REPO } })).toBe(CERES);
		expect(resolveOwningConnection({ worktree_config: { cwd: REPO } })).toBe(CERES);
	});

	it("ignores a nested path key that is not one a spawn request carries", () => {
		// A `path` added to the settings object someday must not start sending
		// settings saves to another machine.
		expect(resolveOwningConnection({ config: { path: REPO } })).toBeUndefined();
	});

	// A session id is an exact identity and already knows which backend spawned
	// it; a path is a prefix match. When a call carries both — a write into a
	// session opened on a directory registered elsewhere — the session wins.
	it("lets the session decide when the arguments carry both", () => {
		expect(resolveOwningConnection({ sessionId: SESSION, repoPath: REPO })).toBe(TYCHO);
	});

	// `id` is in the session keys because `write_pty` accepts it as an alias, and
	// the same key names a plugin, a tunnel and a connection on other commands.
	// A miss has to stay a miss rather than becoming a guess.
	it("returns undefined when nothing on the call is owned remotely", () => {
		expect(resolveOwningConnection({})).toBeUndefined();
		expect(resolveOwningConnection({ id: "some-plugin" })).toBeUndefined();
		expect(resolveOwningConnection({ repoPath: "/local/repo" })).toBeUndefined();
		expect(resolveOwningConnection({ sessionId: 42, repoPath: null })).toBeUndefined();
	});
});
