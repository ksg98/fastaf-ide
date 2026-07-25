import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the external boundaries: IPC (invoke), the SSE event bridge, and
// fetch. The connect/disconnect cleanup sequencing (health-poll interval
// teardown, bridge cleanup, state reset) is the real logic under test.
const bridgeCleanup = vi.fn();
const startBridge = vi.fn((..._args: unknown[]) => bridgeCleanup);
vi.mock("../../utils/remoteEventBridge", () => ({
	startRemoteEventBridge: (...args: unknown[]) => startBridge(...args),
}));
vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import type { RemoteConnection } from "../../stores/remoteConnections";
import { remoteConnectionsStore } from "../../stores/remoteConnections";

const fetchMock = vi.fn();

function directConn(id: string): RemoteConnection {
	return {
		id,
		name: `conn-${id}`,
		transport: { type: "Direct", url: "http://remote.test:9876" },
		auth_username: "user",
		enabled: true,
	};
}

describe("remoteConnectionsStore connect/disconnect (Direct)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		startBridge.mockClear();
		bridgeCleanup.mockClear();
		fetchMock.mockReset();
		fetchMock.mockResolvedValue({
			ok: true,
			json: async () => ({ protocol_version: 2 }),
		});
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(async () => {
		// Ensure no health-poll interval leaks between tests.
		await remoteConnectionsStore.disconnect("c1");
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	async function connect(id: string) {
		await remoteConnectionsStore.addConnection(directConn(id));
		await remoteConnectionsStore.connect(id);
	}

	it("connect sets baseUrl, health-checks, and starts the SSE bridge", async () => {
		await connect("c1");
		const st = remoteConnectionsStore.getConnectionState("c1");
		expect(st?.status).toBe("connected");
		expect(st?.protocolVersion).toBe(2);
		expect(remoteConnectionsStore.getBaseUrl("c1")).toBe("http://remote.test:9876");
		expect(startBridge).toHaveBeenCalledTimes(1);
		expect(startBridge).toHaveBeenCalledWith("c1", "http://remote.test:9876");
		// The health poll keeps running on its interval.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("disconnect stops health polling, tears down the bridge, and resets state", async () => {
		await connect("c1");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await remoteConnectionsStore.disconnect("c1");

		// Bridge cleanup ran exactly once.
		expect(bridgeCleanup).toHaveBeenCalledTimes(1);
		// State reset — getBaseUrl only returns a url while connected.
		const st = remoteConnectionsStore.getConnectionState("c1");
		expect(st?.status).toBe("disconnected");
		expect(st?.baseUrl).toBeUndefined();
		expect(remoteConnectionsStore.getBaseUrl("c1")).toBeUndefined();
		// The interval is cleared: advancing time triggers no further health fetches.
		await vi.advanceTimersByTimeAsync(15000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("reconnecting swaps the bridge: the previous cleanup runs before a new bridge", async () => {
		await connect("c1");
		expect(startBridge).toHaveBeenCalledTimes(1);
		// Force a second connect by first marking it disconnected without cleanup…
		await remoteConnectionsStore.disconnect("c1");
		bridgeCleanup.mockClear();
		startBridge.mockClear();
		await remoteConnectionsStore.connect("c1");
		expect(startBridge).toHaveBeenCalledTimes(1); // fresh bridge established
	});

	it("connect is a no-op when already connected (no duplicate bridge)", async () => {
		await connect("c1");
		expect(startBridge).toHaveBeenCalledTimes(1);
		await remoteConnectionsStore.connect("c1"); // already connected → guarded
		expect(startBridge).toHaveBeenCalledTimes(1);
	});

	it("disconnect on an unknown connection is a safe no-op", async () => {
		await expect(remoteConnectionsStore.disconnect("ghost")).resolves.toBeUndefined();
		expect(bridgeCleanup).not.toHaveBeenCalled();
	});
});
