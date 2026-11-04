import { afterEach, expect, it, vi } from "vitest";

class BudgetEventSource {
	static readonly instances: BudgetEventSource[] = [];
	static readonly CLOSED = 2;
	readyState = 1;
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readonly listeners = new Map<string, EventListener[]>();
	constructor(readonly url: string) {
		BudgetEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: EventListener) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
	}
	close() {
		this.readyState = 2;
	}
}

const disposers: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	vi.unstubAllGlobals();
});

// Catches: per-consumer streams consume all six HTTP/1.1 slots across two tabs,
// including the separate listen() lane used by dictation and speech.
it("two_mobile_tabs_leave_capacity_for_answer_requests", async () => {
	BudgetEventSource.instances.length = 0;
	vi.stubGlobal("__TAURI_SHIM__", true);
	vi.stubGlobal("EventSource", BudgetEventSource);
	vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
	for (let tab = 0; tab < 2; tab++) {
		vi.resetModules(); // A distinct page has its own module registry.
		const { subscribeEvents } = await import("../transport");
		const { listen } = await import("../invoke");
		disposers.push(await subscribeEvents({ "session-state-changed": vi.fn(), "chat-view-changed": vi.fn() }));
		if (tab === 0) disposers.push(await subscribeEvents({ "open-markdown-tabs-changed": vi.fn() }));
		disposers.push(await listen("dictation-state-changed", vi.fn()));
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	const streams = BudgetEventSource.instances.filter((source) => source.readyState !== 2);
	expect(streams, "two tabs must reserve four of the observed six slots for ordinary requests").toHaveLength(2);
});
