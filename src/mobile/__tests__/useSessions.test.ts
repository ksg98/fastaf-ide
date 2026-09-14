import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock external dependencies — we test the REAL signal logic in useSessions,
// only faking the network/event layer it depends on.
// ---------------------------------------------------------------------------

/** Event handlers the hook registered with `subscribeEvents`. */
const sseHandlers = new Map<string, (payload: unknown) => void>();

vi.mock("../../transport", () => ({
	rpc: vi.fn(),
	isTauri: vi.fn(() => false),
	subscribeEvents: vi.fn((handlers: Record<string, (payload: unknown) => void>) => {
		for (const [event, handler] of Object.entries(handlers)) sseHandlers.set(event, handler);
		return Promise.resolve(() => sseHandlers.clear());
	}),
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { rpc, subscribeEvents } from "../../transport";
import type { SessionInfo } from "../useSessions";
import { useSessions } from "../useSessions";

const mockRpc = vi.mocked(rpc);
const mockSubscribeEvents = vi.mocked(subscribeEvents);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SessionInfo for test data */
function makeSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		session_id: id,
		cwd: `/tmp/${id}`,
		worktree_path: null,
		worktree_branch: null,
		...overrides,
	};
}

/**
 * Create a deferred promise we can resolve/reject manually.
 * This lets us control exactly when the RPC completes so we can
 * inspect intermediate signal states.
 */
function deferred<T>() {
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let resolve = (_value: T): void => {};
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	let reject = (_reason: unknown): void => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useSessions — refreshing signal", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("refreshing is false initially (before initial fetch resolves)", async () => {
		// The initial fetch is fire-and-forget; refreshing should still be false
		// because only an explicit refresh() sets it to true.
		const d = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(d.promise as Promise<never>);

		let refreshing: () => boolean = () => false;

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			refreshing = hook.refreshing;
			return dispose;
		});

		expect(refreshing()).toBe(false);

		// Clean up
		d.resolve([]);
		await d.promise;
		dispose();
	});

	it("refresh() sets refreshing to true immediately", async () => {
		// Resolve the initial fetch first so we start from a clean state
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let refreshing: () => boolean = () => false;
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			refreshing = hook.refreshing;
			refresh = hook.refresh;
			return dispose;
		});

		// Complete initial fetch
		initialD.resolve([]);
		await initialD.promise;
		expect(refreshing()).toBe(false);

		// Now set up a deferred for the refresh call
		const refreshD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(refreshD.promise as Promise<never>);

		refresh();

		// refreshing should be true synchronously after calling refresh()
		expect(refreshing()).toBe(true);

		// Clean up
		refreshD.resolve([]);
		await refreshD.promise;
		dispose();
	});

	it("refreshing returns to false after successful fetch", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let refreshing: () => boolean = () => false;
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			refreshing = hook.refreshing;
			refresh = hook.refresh;
			return dispose;
		});

		initialD.resolve([]);
		await initialD.promise;

		const refreshD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(refreshD.promise as Promise<never>);

		refresh();
		expect(refreshing()).toBe(true);

		// Resolve the refresh fetch
		refreshD.resolve([makeSession("s1")]);
		await refreshD.promise;

		// Allow microtasks to flush — the async fetchSessions() needs several
		// ticks: the await inside the try, then the finally block.
		await vi.advanceTimersByTimeAsync(0);

		expect(refreshing()).toBe(false);

		dispose();
	});

	it("refreshing returns to false after failed fetch", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let refreshing: () => boolean = () => false;
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			refreshing = hook.refreshing;
			refresh = hook.refresh;
			return dispose;
		});

		initialD.resolve([]);
		await initialD.promise;

		const refreshD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(refreshD.promise as Promise<never>);

		refresh();
		expect(refreshing()).toBe(true);

		// Reject the refresh fetch
		refreshD.reject(new Error("network down"));
		await refreshD.promise.catch(() => {}); // swallow rejection

		// Allow microtasks to flush
		await Promise.resolve();

		expect(refreshing()).toBe(false);

		dispose();
	});

	it("sessions are updated after a successful refresh", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let sessions: () => SessionInfo[] = () => [];
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			sessions = hook.sessions;
			refresh = hook.refresh;
			return dispose;
		});

		initialD.resolve([]);
		await initialD.promise;
		await Promise.resolve();
		expect(sessions()).toEqual([]);

		const refreshD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(refreshD.promise as Promise<never>);

		refresh();

		const newSessions = [makeSession("s1"), makeSession("s2")];
		refreshD.resolve(newSessions);
		await refreshD.promise;
		await Promise.resolve();

		expect(sessions()).toEqual(newSessions);

		dispose();
	});

	it("error is set after a failed refresh and cleared after success", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let error: () => string | null = () => null;
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			error = hook.error;
			refresh = hook.refresh;
			return dispose;
		});

		initialD.resolve([]);
		await initialD.promise;
		await Promise.resolve();
		expect(error()).toBeNull();

		// Trigger a failed refresh
		const failD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(failD.promise as Promise<never>);
		refresh();

		failD.reject(new Error("server error"));
		await failD.promise.catch(() => {});
		await Promise.resolve();

		expect(error()).toBe("server error");

		// Trigger a successful refresh — should clear the error
		const successD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(successD.promise as Promise<never>);
		refresh();

		successD.resolve([makeSession("s1")]);
		await successD.promise;
		await Promise.resolve();

		expect(error()).toBeNull();

		dispose();
	});

	it("loading transitions from true to false after initial fetch", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let loading: () => boolean = () => false;

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			loading = hook.loading;
			return dispose;
		});

		// loading starts true
		expect(loading()).toBe(true);

		initialD.resolve([]);
		await initialD.promise;
		await Promise.resolve();

		// loading is false after initial fetch completes
		expect(loading()).toBe(false);

		dispose();
	});

	it("questionCount reflects sessions with awaiting_input", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let questionCount: () => number = () => 0;
		let refresh: () => void = () => {};

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			questionCount = hook.questionCount;
			refresh = hook.refresh;
			return dispose;
		});

		initialD.resolve([]);
		await initialD.promise;
		await Promise.resolve();
		expect(questionCount()).toBe(0);

		// Refresh with sessions that have questions
		const refreshD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(refreshD.promise as Promise<never>);
		refresh();

		refreshD.resolve([
			makeSession("s1", {
				state: {
					awaiting_input: true,
					rate_limited: false,
					shell_state: "idle",
					last_activity_ms: Date.now(),
				},
			}),
			makeSession("s2", {
				state: {
					awaiting_input: false,
					rate_limited: false,
					shell_state: "busy",
					last_activity_ms: Date.now(),
				},
			}),
			makeSession("s3", {
				state: {
					awaiting_input: true,
					question_text: "Continue?",
					rate_limited: false,
					shell_state: "idle",
					last_activity_ms: Date.now(),
				},
			}),
		]);
		await refreshD.promise;
		await Promise.resolve();

		expect(questionCount()).toBe(2);

		dispose();
	});

	it("pty-parsed SSE with shell-state updates session in-place", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let sessions: () => SessionInfo[] = () => [];

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			sessions = hook.sessions;
			return dispose;
		});

		initialD.resolve([
			makeSession("s1", {
				state: {
					awaiting_input: false,
					rate_limited: false,
					shell_state: "busy",
					last_activity_ms: Date.now(),
				},
			}),
		]);
		await initialD.promise;
		await Promise.resolve();

		expect(sessions()[0].state?.shell_state).toBe("busy");

		const handler = sseHandlers.get("pty-parsed");
		expect(handler).toBeDefined();

		handler!({
			session_id: "s1",
			parsed: { type: "shell-state", state: "idle" },
		});

		expect(sessions()[0].state?.shell_state).toBe("idle");

		dispose();
	});

	it("pty-parsed SSE ignores non-shell-state events", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let sessions: () => SessionInfo[] = () => [];

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			sessions = hook.sessions;
			return dispose;
		});

		initialD.resolve([
			makeSession("s1", {
				state: {
					awaiting_input: false,
					rate_limited: false,
					shell_state: "busy",
					last_activity_ms: Date.now(),
				},
			}),
		]);
		await initialD.promise;
		await Promise.resolve();

		const handler = sseHandlers.get("pty-parsed");
		handler!({
			session_id: "s1",
			parsed: { type: "question", text: "Continue?" },
		});

		expect(sessions()[0].state?.shell_state).toBe("busy");

		dispose();
	});

	it("pty-parsed SSE ignores unknown session IDs", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValue(initialD.promise as Promise<never>);

		let sessions: () => SessionInfo[] = () => [];

		const dispose = createRoot((dispose) => {
			const hook = useSessions();
			sessions = hook.sessions;
			return dispose;
		});

		initialD.resolve([
			makeSession("s1", {
				state: {
					awaiting_input: false,
					rate_limited: false,
					shell_state: "busy",
					last_activity_ms: Date.now(),
				},
			}),
		]);
		await initialD.promise;
		await Promise.resolve();

		const handler = sseHandlers.get("pty-parsed");
		handler!({
			session_id: "unknown",
			parsed: { type: "shell-state", state: "idle" },
		});

		expect(sessions()[0].state?.shell_state).toBe("busy");

		dispose();
	});

	it("poll interval triggers fetchSessions periodically", async () => {
		const initialD = deferred<SessionInfo[]>();
		mockRpc.mockReturnValueOnce(initialD.promise as Promise<never>);

		const dispose = createRoot((dispose) => {
			useSessions();
			return dispose;
		});

		// Complete initial fetch
		initialD.resolve([]);
		await initialD.promise;

		// rpc was called once for the initial fetch
		expect(mockRpc).toHaveBeenCalledTimes(1);

		// Set up a resolved promise for the next poll
		mockRpc.mockResolvedValue([] as never);

		// Advance past one poll interval (3000ms)
		await vi.advanceTimersByTimeAsync(3000);

		expect(mockRpc).toHaveBeenCalledTimes(2);

		// Advance another interval
		await vi.advanceTimersByTimeAsync(3000);

		expect(mockRpc).toHaveBeenCalledTimes(3);

		dispose();
	});
});

/** Build a SessionInfo carrying a shell_state, as the server sends it. */
function makeStatefulSession(id: string, shellState: string): SessionInfo {
	return makeSession(id, {
		state: {
			awaiting_input: false,
			rate_limited: false,
			shell_state: shellState,
			last_activity_ms: 1,
		},
	});
}

describe("useSessions — SSE subscription", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		sseHandlers.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens one filtered subscription covering only the events it handles", async () => {
		mockRpc.mockResolvedValue([] as never);

		const dispose = createRoot((d) => {
			useSessions();
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);

		// `subscribeEvents` derives the `?types=` query from the handler keys, so
		// one call with exactly these three keys is what keeps the client from
		// receiving and parsing every event kind the backend publishes.
		expect(mockSubscribeEvents).toHaveBeenCalledTimes(1);
		const handlers = mockSubscribeEvents.mock.calls[0][0];
		expect(Object.keys(handlers).sort()).toEqual(["pty-parsed", "session-closed", "session-created"]);

		dispose();
	});

	it("session-created and session-closed each trigger a refetch", async () => {
		mockRpc.mockResolvedValue([] as never);

		const dispose = createRoot((d) => {
			useSessions();
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(mockRpc).toHaveBeenCalledTimes(1);

		sseHandlers.get("session-created")!({ session_id: "s1", cwd: "/tmp/s1" });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockRpc).toHaveBeenCalledTimes(2);

		sseHandlers.get("session-closed")!({ session_id: "s1" });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockRpc).toHaveBeenCalledTimes(3);

		dispose();
	});
});

describe("useSessions — poll reconciliation", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("a poll that changes nothing keeps every session object identity", async () => {
		// The server rebuilds each SessionInfo from scratch on every request, so
		// the poll always sees fresh objects with identical content.
		mockRpc.mockImplementation(() => Promise.resolve([makeSession("s1"), makeSession("s2")]) as never);

		let sessions: () => SessionInfo[] = () => [];
		const dispose = createRoot((d) => {
			sessions = useSessions().sessions;
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		const first = sessions();
		expect(first).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(3000);

		expect(sessions()[0]).toBe(first[0]);
		expect(sessions()[1]).toBe(first[1]);
		// Nothing changed at all, so even the list identity must survive —
		// otherwise every memo and <For> downstream re-runs 20 times a minute.
		expect(sessions()).toBe(first);

		dispose();
	});

	it("only the session whose payload changed gets a new object", async () => {
		let shellState = "busy";
		mockRpc.mockImplementation(
			() => Promise.resolve([makeStatefulSession("s1", shellState), makeSession("s2")]) as never,
		);

		let sessions: () => SessionInfo[] = () => [];
		const dispose = createRoot((d) => {
			sessions = useSessions().sessions;
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		const first = sessions();

		shellState = "idle";
		await vi.advanceTimersByTimeAsync(3000);

		expect(sessions()[0]).not.toBe(first[0]);
		expect(sessions()[0].state?.shell_state).toBe("idle");
		expect(sessions()[1]).toBe(first[1]);

		dispose();
	});

	it("survivors keep identity when a session is added and another removed", async () => {
		let payload = [makeSession("s1"), makeSession("s2")];
		mockRpc.mockImplementation(() => Promise.resolve(payload.map((s) => ({ ...s }))) as never);

		let sessions: () => SessionInfo[] = () => [];
		const dispose = createRoot((d) => {
			sessions = useSessions().sessions;
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		const first = sessions();

		payload = [makeSession("s2"), makeSession("s3")];
		await vi.advanceTimersByTimeAsync(3000);

		expect(sessions().map((s) => s.session_id)).toEqual(["s2", "s3"]);
		expect(sessions()[0]).toBe(first[1]);

		dispose();
	});
});

/** Swap `document.visibilityState` and fire the matching event. */
function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
	document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSessions — visibility gating", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		setVisibility("visible");
	});

	afterEach(() => {
		vi.useRealTimers();
		setVisibility("visible");
	});

	it("stops polling while the page is hidden", async () => {
		mockRpc.mockResolvedValue([] as never);

		const dispose = createRoot((d) => {
			useSessions();
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		expect(mockRpc).toHaveBeenCalledTimes(1); // initial fetch

		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(30_000); // ten poll intervals

		expect(mockRpc).toHaveBeenCalledTimes(1);

		dispose();
	});

	it("refetches immediately when the page becomes visible again", async () => {
		mockRpc.mockResolvedValue([] as never);

		const dispose = createRoot((d) => {
			useSessions();
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mockRpc).toHaveBeenCalledTimes(1);

		setVisibility("visible");
		await vi.advanceTimersByTimeAsync(0);

		// Visible again: catch up at once rather than showing stale state for 3s.
		expect(mockRpc).toHaveBeenCalledTimes(2);

		// And resume the regular cadence.
		await vi.advanceTimersByTimeAsync(3000);
		expect(mockRpc).toHaveBeenCalledTimes(3);

		dispose();
	});

	it("does not poll at all when mounted on a hidden page", async () => {
		mockRpc.mockResolvedValue([] as never);
		setVisibility("hidden");

		const dispose = createRoot((d) => {
			useSessions();
			return d;
		});

		await vi.advanceTimersByTimeAsync(0);
		// The initial fetch still runs — a hidden page may become visible at any
		// moment and must not start from an empty list.
		expect(mockRpc).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(mockRpc).toHaveBeenCalledTimes(1);

		dispose();
	});
});
