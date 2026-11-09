import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TALK_FLASH_MS, talkFlash } from "../../stores/talkFlash";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	talkFlash.clear();
	vi.useRealTimers();
});

describe("talkFlash", () => {
	it("names the terminal that was acted in, then lets go once the ring has faded", () => {
		expect(talkFlash.terminalId()).toBeNull();

		talkFlash.flash("term-2");
		expect(talkFlash.terminalId()).toBe("term-2");

		vi.advanceTimersByTime(TALK_FLASH_MS - 1);
		expect(talkFlash.terminalId()).toBe("term-2");
		vi.advanceTimersByTime(1);
		expect(talkFlash.terminalId()).toBeNull();
	});

	// Catches: the first action's timer clearing the ring of a later action in
	// another terminal half way through its fade.
	it("moves to the newest terminal and gives it the full time", () => {
		talkFlash.flash("term-1");
		vi.advanceTimersByTime(TALK_FLASH_MS - 100);
		talkFlash.flash("term-2");

		vi.advanceTimersByTime(200);
		expect(talkFlash.terminalId()).toBe("term-2");
		vi.advanceTimersByTime(TALK_FLASH_MS);
		expect(talkFlash.terminalId()).toBeNull();
	});
});
