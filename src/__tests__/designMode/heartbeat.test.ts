import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain MV3 module
import { HEARTBEAT_MS, heartbeatReply } from "../../../browser-extension/design-mode/heartbeat.js";

function browser() {
	let saved = {};
	return {
		storage: {
			get: async () => saved,
			set: async (value: object) => {
				saved = { ...saved, ...value };
			},
		},
		tabs: { reload: vi.fn(async () => {}), update: vi.fn(async () => {}), query: vi.fn(async () => [{ id: 7 }]) },
	};
}

describe("Design Mode heartbeat reload delivery", () => {
	// Catches: a pending reload lost on the first reply or repeated after a worker restart.
	it("reload_request_reaches_the_extension_once", async () => {
		const { storage, tabs } = browser();
		await heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs, 9);
		await heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs, 9);
		expect(tabs.reload.mock.calls).toEqual([[9]]);
		await heartbeatReply({ armed: true, reloadSeq: 2 }, storage, tabs, 9);
		expect(tabs.reload.mock.calls).toEqual([[9], [9]]);
	});
	// Catches: a failed Chrome reload acknowledged before the page reloads.
	it("retries a failed reload on the next beat", async () => {
		const { storage, tabs } = browser();
		tabs.reload.mockRejectedValueOnce(new Error("Tab unavailable"));
		await expect(heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs, 9)).rejects.toThrow("Tab unavailable");
		await heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs, 9);
		expect(tabs.reload).toHaveBeenCalledTimes(2);
	});
	// Catches: an unarmed or malformed reply reloading a user's unrelated tab.
	it("ignores unarmed and malformed replies and resolves the review tab when unset", async () => {
		const { storage, tabs } = browser();
		for (const reply of [
			{ armed: false, reloadSeq: 1 },
			{ armed: true, reloadSeq: undefined },
			{ armed: true, reloadSeq: 0 },
		]) {
			await heartbeatReply(reply, storage, tabs);
		}
		expect(tabs.reload).not.toHaveBeenCalled();
		await heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs);
		expect(tabs.reload).toHaveBeenCalledWith(7);
		expect(HEARTBEAT_MS).toBe(5000);
	});
});

// Catches: a backend restart leaves the browser acknowledgement ahead of all new reload requests.
it("reload_after_backend_restart_is_not_suppressed_by_previous_sequence", async () => {
	const values: Record<string, unknown> = { reloadSeq: 3, reviewedTab: 42 };
	const storage = {
		get: async () => ({ ...values }),
		set: async (next: Record<string, unknown>) => {
			Object.assign(values, next);
		},
	};
	const reloaded: number[] = [];
	const tabs = {
		reload: async (id: number) => {
			reloaded.push(id);
		},
		query: async () => [{ id: 42 }],
	};
	await heartbeatReply({ armed: true, reloadSeq: 0 }, storage, tabs);
	expect(reloaded).toEqual([]);
	await heartbeatReply({ armed: true, reloadSeq: 1 }, storage, tabs);
	expect(reloaded).toEqual([42]);
});

describe("Design Mode heartbeat navigation delivery", () => {
	const reply = (seq: number, url = "http://localhost:5173/a") => ({
		armed: true,
		reloadSeq: 0,
		navigate: { seq, url },
	});
	// Catches: a navigation request ignored, or repeated on every beat and after a worker restart.
	it("navigates the reviewed tab once per request", async () => {
		const { storage, tabs } = browser();
		await heartbeatReply(reply(1), storage, tabs, 9);
		await heartbeatReply(reply(1), storage, tabs, 9);
		expect(tabs.update.mock.calls).toEqual([[9, { url: "http://localhost:5173/a" }]]);
		await heartbeatReply(reply(2, "http://localhost:5173/b"), storage, tabs, 9);
		expect(tabs.update).toHaveBeenLastCalledWith(9, { url: "http://localhost:5173/b" });
		expect(tabs.reload).not.toHaveBeenCalled();
	});
	// Catches: a failed tab update acknowledged, so the navigation is lost.
	it("retries a failed navigation on the next beat", async () => {
		const { storage, tabs } = browser();
		tabs.update.mockRejectedValueOnce(new Error("Tab unavailable"));
		await expect(heartbeatReply(reply(1), storage, tabs, 9)).rejects.toThrow("Tab unavailable");
		await heartbeatReply(reply(1), storage, tabs, 9);
		expect(tabs.update).toHaveBeenCalledTimes(2);
	});
	// Catches: unarmed or malformed replies driving a user's tab, and a backend restart suppressing navigation.
	it("ignores unarmed and malformed navigation and rebases after a backend restart", async () => {
		const { storage, tabs } = browser();
		await heartbeatReply({ armed: false, navigate: { seq: 1, url: "http://localhost/" } }, storage, tabs, 9);
		await heartbeatReply({ armed: true, reloadSeq: 0, navigate: { seq: 1 } }, storage, tabs, 9);
		await heartbeatReply(
			{ armed: true, reloadSeq: 0, navigate: { seq: "1", url: "http://localhost/" } },
			storage,
			tabs,
			9,
		);
		expect(tabs.update).not.toHaveBeenCalled();
		await heartbeatReply(reply(5), storage, tabs, 9);
		await heartbeatReply(reply(1, "http://localhost:5173/new"), storage, tabs, 9);
		await heartbeatReply(reply(2, "http://localhost:5173/new"), storage, tabs, 9);
		expect(tabs.update).toHaveBeenLastCalledWith(9, { url: "http://localhost:5173/new" });
		expect(tabs.update).toHaveBeenCalledTimes(3);
	});
});

// Catches: the browser's saved acknowledgement silently dropping the first navigation after TUIC restarts.
it("delivers the first navigation after an idle backend restart heartbeat", async () => {
	for (const previousSeq of [1, 5]) {
		const { storage, tabs } = browser();
		await heartbeatReply(
			{ armed: true, reloadSeq: 0, navigate: { seq: previousSeq, url: "http://localhost:5173/before" } },
			storage,
			tabs,
			9,
		);
		// A newly started backend has no pending URL until the agent requests one.
		await heartbeatReply({ armed: true, reloadSeq: 0 }, storage, tabs, 9);
		await heartbeatReply(
			{ armed: true, reloadSeq: 0, navigate: { seq: 1, url: "http://localhost:5173/after" } },
			storage,
			tabs,
			9,
		);
		expect(tabs.update.mock.calls, `previous sequence ${previousSeq}`).toEqual([
			[9, { url: "http://localhost:5173/before" }],
			[9, { url: "http://localhost:5173/after" }],
		]);
	}
});

// Catches: equal counters after restart losing a command that arrives before an idle beat.
it("delivers navigation before the first idle beat of a new backend", async () => {
	for (const previousSeq of [1, 5]) {
		const { storage, tabs } = browser();
		await heartbeatReply(
			{ armed: true, backendId: "old", navigate: { seq: previousSeq, url: "http://localhost/before" } },
			storage,
			tabs,
			9,
		);
		const reply = { armed: true, backendId: "new", navigate: { seq: 1, url: "http://localhost/after" } };
		tabs.update.mockRejectedValueOnce(new Error("Tab unavailable"));
		await expect(heartbeatReply(reply, storage, tabs, 9)).rejects.toThrow("Tab unavailable");
		await heartbeatReply(reply, storage, tabs, 9);
		await heartbeatReply(reply, storage, tabs, 9);
		expect(tabs.update.mock.calls).toEqual([
			[9, { url: "http://localhost/before" }],
			[9, { url: "http://localhost/after" }],
			[9, { url: "http://localhost/after" }],
		]);
	}
});
// Catches: a URL-free sequence reply reusing an old acknowledgement or replaying an old URL.
it("rebases URL-free navigation sequences without applying a page", async () => {
	const { storage, tabs } = browser();
	await heartbeatReply({ armed: true, navigate: { seq: 3, url: "http://localhost/before" } }, storage, tabs, 9);
	await heartbeatReply({ armed: true, navigate: { seq: 0 } }, storage, tabs, 9);
	await heartbeatReply({ armed: true, navigate: { seq: 1, url: "http://localhost/after" } }, storage, tabs, 9);
	expect(tabs.update.mock.calls).toEqual([
		[9, { url: "http://localhost/before" }],
		[9, { url: "http://localhost/after" }],
	]);
});
