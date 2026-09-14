import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	bumpRevision: vi.fn(),
	bumpGitRevision: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	previewLogPayload: vi.fn((value: string) => `preview:${value}`),
}));

vi.mock("../../stores/repositories", () => ({
	repositoriesStore: { bumpRevision: mocks.bumpRevision, bumpGitRevision: mocks.bumpGitRevision },
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: mocks.debug, warn: mocks.warn },
	previewLogPayload: mocks.previewLogPayload,
}));

import { startRemoteEventBridge } from "../../utils/remoteEventBridge";

class MockEventSource {
	static readonly instances: MockEventSource[] = [];
	readonly listeners = new Map<string, EventListener[]>();
	readonly close = vi.fn();
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;

	constructor(readonly url: string) {
		MockEventSource.instances.push(this);
	}

	addEventListener(type: string, listener: EventListener): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}

	emit(type: string, data = ""): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }));
		}
	}
}

describe("startRemoteEventBridge", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		MockEventSource.instances.length = 0;
		mocks.bumpRevision.mockReset();
		mocks.debug.mockReset();
		mocks.warn.mockReset();
		mocks.previewLogPayload.mockClear();
		vi.stubGlobal("EventSource", MockEventSource);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("subscribes to the supported event types and routes a valid repo change", () => {
		const cleanup = startRemoteEventBridge("remote-1", "http://remote.test:9876");
		const source = MockEventSource.instances[0];

		expect(source.url).toBe("http://remote.test:9876/events?types=repo-changed%2Csession-status%2Csession-closed");
		expect([...source.listeners.keys()]).toEqual(
			expect.arrayContaining(["repo-changed", "session-status", "session-closed"]),
		);

		// `repo_path`, not `path` — this is the key `sse_routes::event_payload`
		// has always sent. Reading the wrong one made the bridge silently drop
		// every remote repo change.
		source.emit("repo-changed", JSON.stringify({ repo_path: "/work/repo", kind: "working-tree" }));
		source.emit("repo-changed", JSON.stringify({ repo_path: 42, kind: "working-tree" }));

		expect(mocks.bumpRevision).toHaveBeenCalledTimes(1);
		expect(mocks.bumpRevision).toHaveBeenCalledWith("/work/repo");
		cleanup();
	});

	// Fail safe, not narrow. A remote daemon older than this field sends
	// `{repo_path}` with no `kind`; treating that as working-tree would leave
	// the committed-history panels stale on every remote commit, silently and
	// forever. Narrow ONLY on an explicit "working-tree".
	it("treats a missing or unknown kind as git-state", () => {
		const cleanup = startRemoteEventBridge("remote-old", "http://remote.test");
		const source = MockEventSource.instances[0];

		source.emit("repo-changed", JSON.stringify({ repo_path: "/legacy" }));
		source.emit("repo-changed", JSON.stringify({ repo_path: "/future", kind: "submodule" }));

		expect(mocks.bumpGitRevision).toHaveBeenCalledWith("/legacy");
		expect(mocks.bumpGitRevision).toHaveBeenCalledWith("/future");
		expect(mocks.bumpRevision).not.toHaveBeenCalled();
		cleanup();
	});

	it("routes a git-state change to the narrower counter", () => {
		const cleanup = startRemoteEventBridge("remote-git", "http://remote.test");
		const source = MockEventSource.instances[0];

		source.emit("repo-changed", JSON.stringify({ repo_path: "/work/repo", kind: "git-state" }));

		expect(mocks.bumpGitRevision).toHaveBeenCalledWith("/work/repo");
		expect(mocks.bumpRevision).not.toHaveBeenCalled();
		cleanup();
	});

	it("logs malformed repo events without allowing a bad payload to break the bridge", () => {
		const cleanup = startRemoteEventBridge("remote-2", "http://remote.test");
		const source = MockEventSource.instances[0];

		source.emit("repo-changed", "not-json");

		expect(mocks.previewLogPayload).toHaveBeenCalledWith("not-json");
		expect(mocks.warn).toHaveBeenCalledWith("network", "Failed to parse repo-changed SSE event", {
			connectionId: "remote-2",
			eventData: "preview:not-json",
		});
		expect(mocks.bumpRevision).not.toHaveBeenCalled();
		cleanup();
	});

	it("reconnects with exponential backoff and resets the delay after a successful open", () => {
		const cleanup = startRemoteEventBridge("remote-3", "http://remote.test");
		const first = MockEventSource.instances[0];

		first.onerror?.();
		expect(first.close).toHaveBeenCalledOnce();
		vi.advanceTimersByTime(999);
		expect(MockEventSource.instances).toHaveLength(1);
		vi.advanceTimersByTime(1);
		expect(MockEventSource.instances).toHaveLength(2);

		const second = MockEventSource.instances[1];
		second.onerror?.();
		vi.advanceTimersByTime(1_999);
		expect(MockEventSource.instances).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(MockEventSource.instances).toHaveLength(3);

		const third = MockEventSource.instances[2];
		third.onopen?.();
		third.onerror?.();
		vi.advanceTimersByTime(999);
		expect(MockEventSource.instances).toHaveLength(3);
		vi.advanceTimersByTime(1);
		expect(MockEventSource.instances).toHaveLength(4);
		expect(mocks.debug).toHaveBeenCalledWith("network", "SSE bridge connected for remote-3");
		cleanup();
	});

	it("cancels a pending reconnect and prevents a late error from scheduling another one", () => {
		const cleanup = startRemoteEventBridge("remote-4", "http://remote.test");
		const source = MockEventSource.instances[0];

		source.onerror?.();
		cleanup();
		source.onerror?.();
		vi.advanceTimersByTime(30_000);

		expect(source.close).toHaveBeenCalled();
		expect(MockEventSource.instances).toHaveLength(1);
	});
});
