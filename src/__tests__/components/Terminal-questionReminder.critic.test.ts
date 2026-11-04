import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal } from "../helpers/store";

const playQuestionReminder = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../stores/notifications", () => ({ notificationsStore: { playQuestionReminder } }));

describe("trackQuestionReminder (critic)", () => {
	let store: typeof import("../../stores/terminals").terminalsStore;
	let mod: typeof import("../../components/Terminal/questionReminder");
	let dispose: () => void;
	let id: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		playQuestionReminder.mockReset();
		playQuestionReminder.mockResolvedValue(undefined);
		store = (await import("../../stores/terminals")).terminalsStore;
		mod = await import("../../components/Terminal/questionReminder");
		createRoot((d) => {
			dispose = d;
			id = store.add(makeTerminal());
			mod.trackQuestionReminder(id);
		});
	});

	afterEach(() => {
		dispose();
		store._testCancelPendingTimers();
		vi.useRealTimers();
	});

	it("rapid question/answer cycles leave no orphan timer: exactly one reminder after the last question (bug: timer leaked per cycle)", () => {
		for (let i = 0; i < 50; i++) {
			store.setAwaitingInput(id, "question", true);
			vi.advanceTimersByTime(1000);
			store.clearAwaitingInput(id);
		}
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(mod.QUESTION_REMINDER_MS * 3);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("a low->high confidence refresh of the same pending question does not restart or double the reminder (bug: effect keyed on confidence)", () => {
		store.setAwaitingInput(id, "question", false);
		vi.advanceTimersByTime(mod.QUESTION_REMINDER_MS - 1000);
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(1000);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});

	it("remounting the Terminal while the question is pending does not postpone the reminder (bug: age measured from mount, not from the question)", () => {
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(mod.QUESTION_REMINDER_MS - 20_000);
		dispose();
		createRoot((d) => {
			dispose = d;
			mod.trackQuestionReminder(id);
		});
		vi.advanceTimersByTime(20_000);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});
});
