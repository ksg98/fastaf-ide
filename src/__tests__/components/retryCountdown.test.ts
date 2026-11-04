import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRetryCountdown } from "../../components/AIChatPanel/retryCountdown";
import { acpTranscript } from "../../stores/acpTranscript";
import type { AcpClientEvent, AcpSessionUpdate } from "../../types/acp";
import recordedRetry from "../fixtures/ego-provider-retry.json";

const sessionId = "retry-session";
let dispose = () => {};
function feed(event: AcpClientEvent) {
	acpTranscript.applyFrame({
		kind: "event",
		sessionId,
		connectionId: "retry-connection",
		sequence: 1,
		generation: 1,
		turnId: null,
		event,
	});
}
function startRetry() {
	feed({ kind: "sessionUpdate", update: recordedRetry as AcpSessionUpdate });
}
beforeEach(() => {
	vi.useFakeTimers();
	acpTranscript.reset();
});
afterEach(() => {
	dispose();
	vi.useRealTimers();
});
function mount() {
	return createRoot((cleanup) => {
		dispose = cleanup;
		return createRetryCountdown(() => acpTranscript.retry(sessionId));
	});
}

describe("retry countdown lifecycle", () => {
	// Catches: measuring from panel mount or resetting on an unrelated session-info patch.
	it("uses arrival time across late mount, unrelated patches and a new attempt", () => {
		startRetry();
		vi.advanceTimersByTime(8000);
		const text = mount();
		expect(text()).toContain("retrying in 4s");
		feed({ kind: "sessionUpdate", update: { sessionUpdate: "session_info_update", title: "Renamed" } });
		vi.advanceTimersByTime(1000);
		expect(text()).toContain("retrying in 3s");
		startRetry();
		expect(text()).toContain("retrying in 12s");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(12000);
		expect(text()).toContain("retrying now");
		expect(vi.getTimerCount()).toBe(0);
	});

	// Catches: a presentation timer surviving recovery, terminal failure, settlement or panel disposal.
	it.each(["recovery", "failure", "settlement", "unmount"])("stops the one timer on %s", (ending) => {
		const text = mount();
		startRetry();
		expect(text()).toContain("retrying in 12s");
		expect(vi.getTimerCount()).toBe(1);
		if (ending === "recovery")
			feed({
				kind: "sessionUpdate",
				update: {
					sessionUpdate: "session_info_update",
					_meta: { ego: { providerRetry: null } },
				} as AcpSessionUpdate,
			});
		else if (ending === "failure") feed({ kind: "turnFailed", message: "Final provider error", state: "idle" });
		else if (ending === "settlement") feed({ kind: "turnSettled", stopReason: "end_turn", usage: null });
		else dispose();
		expect(vi.getTimerCount()).toBe(0);
		if (ending !== "unmount") expect(text()).toBeNull();
	});

	// Catches: malformed provider delays leaking an endless timer or showing NaN/negative seconds.
	it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"keeps provider text for invalid delay %s",
		(delayMs) => {
			const text = mount();
			feed({
				kind: "sessionUpdate",
				update: {
					...recordedRetry,
					_meta: { ego: { providerRetry: { ...recordedRetry._meta.ego.providerRetry, delayMs } } },
				} as AcpSessionUpdate,
			});
			expect(text()).toBe(recordedRetry._meta.ego.providerRetry.text);
			expect(vi.getTimerCount()).toBe(0);
		},
	);
});
