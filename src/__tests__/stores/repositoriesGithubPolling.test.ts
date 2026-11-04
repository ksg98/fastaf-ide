import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { mockInvoke } from "../mocks/tauri";

const remoteRpc = vi.fn().mockResolvedValue(undefined);
vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: remoteRpc,
}));

describe("repository mutation GitHub polling ownership", () => {
	let store: typeof import("../../stores/repositories").repositoriesStore;

	beforeEach(async () => {
		vi.resetModules();
		vi.useFakeTimers();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		remoteRpc.mockClear();
		vi.mocked(tauriListen).mockClear();
		localStorage.clear();
		store = (await import("../../stores/repositories")).repositoriesStore;
		store._testSetHydrated(true);
		const runtime = await import("../../transportRuntime");
		runtime.setRemoteBaseUrlLookup((owner) => (owner === "mint" ? "http://daemon" : undefined));
	});

	afterEach(() => vi.useRealTimers());

	// Catches: mutation paths bypass owner grouping and poll remote paths locally.
	it("add excludes active remote repositories from local polling", () => {
		store.add({ path: "/remote", displayName: "Remote", connectionId: "mint" });
		mockInvoke.mockClear();
		remoteRpc.mockClear();
		store.add({ path: "/local", displayName: "Local" });
		expect(mockInvoke).toHaveBeenCalledWith("github_update_paths", { paths: ["/local"] });
		expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: ["/remote"] }, "mint");
	});
	// Catches: an all-remote mutation leaves stale local paths configured.
	it("remote-only additions clear the local poller", () => {
		store.add({ path: "/remote", displayName: "Remote", connectionId: "mint" });
		expect(mockInvoke).toHaveBeenCalledWith("github_update_paths", { paths: [] });
		expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: ["/remote"] }, "mint");
	});

	// Catches: removing or parking an owner's last path leaves that daemon polling it.
	it.each(["remove", "park"])("%s clears the last remote path without changing local ownership", (operation) => {
		store.add({ path: "/remote", displayName: "Remote", connectionId: "mint" });
		store.add({ path: "/local", displayName: "Local" });
		mockInvoke.mockClear();
		remoteRpc.mockClear();
		if (operation === "remove") store.remove("/remote");
		else store.setPark("/remote", true);
		expect(mockInvoke).toHaveBeenCalledWith("github_update_paths", { paths: ["/local"] });
		expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: [] }, "mint");
		if (operation === "park") {
			remoteRpc.mockClear();
			store.setPark("/remote", false);
			expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: ["/remote"] }, "mint");
		}
	});

	// Catches: disconnected paths either leak locally or issue an unroutable remote call.
	it("does not contact a disconnected owner or include its paths locally", () => {
		store.add({ path: "/offline", displayName: "Offline", connectionId: "offline" });
		expect(mockInvoke).toHaveBeenCalledWith("github_update_paths", { paths: [] });
		expect(remoteRpc).not.toHaveBeenCalled();
	});

	// Catches: startup and mutation disagree on parked or remote ownership.
	it("startup uses the same owner partition as mutations", async () => {
		store.add({ path: "/remote", displayName: "Remote", connectionId: "mint" });
		store.add({ path: "/local", displayName: "Local" });
		store.add({ path: "/parked", displayName: "Parked" });
		store.setPark("/parked", true);
		mockInvoke.mockClear();
		remoteRpc.mockClear();
		const { githubStore } = await import("../../stores/github");
		githubStore.startPolling();
		expect(mockInvoke).toHaveBeenCalledWith("github_start_polling", expect.objectContaining({ paths: ["/local"] }));
		expect(remoteRpc).toHaveBeenCalledWith(
			"github_start_polling",
			expect.objectContaining({ paths: ["/remote"] }),
			"mint",
		);
		await Promise.resolve();
		githubStore.stopPolling();
	});

	// Catches: disk adoption bypasses mutation routing or forgets a removed owner.
	it("adoption partitions paths and clears a removed remote owner", async () => {
		let disk: Record<string, unknown> = { repos: {}, repoOrder: [] };
		mockInvoke.mockImplementation(async (command) =>
			command === "load_repositories" ? structuredClone(disk) : undefined,
		);
		await store.hydrate();
		const onChanged = vi.mocked(tauriListen).mock.calls.find(([name]) => name === "repositories-changed")![1];
		const repo = (path: string, connectionId?: string) => ({
			path,
			displayName: path,
			initials: "",
			expanded: true,
			collapsed: false,
			parked: false,
			workspaces: {},
			activeWorkspaceId: null,
			connectionId,
		});
		disk = {
			repos: { "/remote": repo("/remote", "mint"), "/local": repo("/local") },
			repoOrder: ["/remote", "/local"],
		};
		onChanged({ payload: {}, event: "repositories-changed", id: 0 });
		await vi.advanceTimersByTimeAsync(0);
		expect(mockInvoke).toHaveBeenCalledWith("github_update_paths", { paths: ["/local"] });
		expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: ["/remote"] }, "mint");
		remoteRpc.mockClear();
		disk = { repos: { "/local": repo("/local") }, repoOrder: ["/local"] };
		onChanged({ payload: {}, event: "repositories-changed", id: 0 });
		await vi.advanceTimersByTimeAsync(0);
		expect(remoteRpc).toHaveBeenCalledWith("github_update_paths", { paths: [] }, "mint");
	});
});
