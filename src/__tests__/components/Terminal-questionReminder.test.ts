import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTerminal } from "../helpers/store";

const playQuestionReminder = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../../stores/notifications", () => ({ notificationsStore: { playQuestionReminder } }));

describe("trackQuestionReminder", () => {
	let store: typeof import("../../stores/terminals").terminalsStore;
	let QUESTION_REMINDER_MS: number;
	let mod: typeof import("../../components/Terminal/questionReminder");
	let dispose: () => void;
	let id: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		playQuestionReminder.mockClear();
		store = (await import("../../stores/terminals")).terminalsStore;
		mod = await import("../../components/Terminal/questionReminder");
		QUESTION_REMINDER_MS = mod.QUESTION_REMINDER_MS;
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

	it("re-notifies once when the question is still pending after 120 s (bug: notified only once)", () => {
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS - 1);
		expect(playQuestionReminder).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(playQuestionReminder).toHaveBeenCalledExactlyOnceWith(id);
		// one reminder per question: no repeat every 2 minutes
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 5);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});

	it("is cancelled when the question is answered or the agent resumes (state cleared)", () => {
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS - 1000);
		store.clearAwaitingInput(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(playQuestionReminder).not.toHaveBeenCalled();
	});

	it("is cancelled when the pending state turns into an error", () => {
		store.setAwaitingInput(id, "question", true);
		store.setAwaitingInput(id, "error", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(playQuestionReminder).not.toHaveBeenCalled();
	});

	it("is cancelled when the session is closed (bug: reminder for a removed terminal)", () => {
		store.setAwaitingInput(id, "question", true);
		store.remove(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(playQuestionReminder).not.toHaveBeenCalled();
	});

	it("unmounting the component does not cancel the reminder (bug: reminder tied to a component that remounts)", () => {
		store.setAwaitingInput(id, "question", true);
		dispose();
		vi.advanceTimersByTime(QUESTION_REMINDER_MS);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});

	it("two components tracking one terminal id produce a single reminder (bug: FloatingTerminal + TerminalArea double notice)", () => {
		createRoot((d) => {
			mod.trackQuestionReminder(id);
			d();
		});
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});

	it("answering one question and being asked the next restarts the timer (user input clears awaiting; multi-question wizard)", () => {
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS - 1000);
		store.clearAwaitingInput(id);
		store.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS - 1);
		expect(playQuestionReminder).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(playQuestionReminder).toHaveBeenCalledTimes(1);
	});
});
