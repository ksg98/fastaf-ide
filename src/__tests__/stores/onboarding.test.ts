import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "fastaf.onboarding.v1";

async function freshStore() {
	// The module reads localStorage once at import time, so every test gets
	// its own instance.
	vi.resetModules();
	const mod = await import("../../stores/onboarding");
	return mod.onboardingStore;
}

describe("onboardingStore", () => {
	beforeEach(() => {
		localStorage.removeItem(KEY);
	});

	it("starts with nothing dismissed or done", async () => {
		const store = await freshStore();
		expect(store.isDismissed("welcome")).toBe(false);
		expect(store.isDone("multi")).toBe(false);
	});

	it("remembers a dismissed hint across instances", async () => {
		const first = await freshStore();
		first.dismiss("chat");
		expect(first.isDismissed("chat")).toBe(true);
		const second = await freshStore();
		expect(second.isDismissed("chat")).toBe(true);
		expect(second.isDismissed("dictation")).toBe(false);
	});

	it("ticks milestones once and persists them", async () => {
		const store = await freshStore();
		store.markDone("dictation");
		store.markDone("dictation");
		expect(store.state.done).toEqual(["dictation"]);
		expect(JSON.parse(localStorage.getItem(KEY) ?? "{}").done).toEqual(["dictation"]);
	});

	it("reset forgets everything, so the hints show again", async () => {
		const store = await freshStore();
		store.dismiss("welcome");
		store.markDone("chat");
		store.reset();
		expect(store.isDismissed("welcome")).toBe(false);
		expect(store.isDone("chat")).toBe(false);
		expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ dismissed: [], done: [] });
	});

	it("survives a corrupt entry", async () => {
		localStorage.setItem(KEY, "{not json");
		const store = await freshStore();
		expect(store.isDismissed("welcome")).toBe(false);
	});
});
