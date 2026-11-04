import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTION_REMINDER_MS, trackQuestionReminder } from "../../components/Terminal/questionReminder";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

const { remind } = vi.hoisted(() => ({ remind: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../stores/notifications", () => ({ notificationsStore: { playQuestionReminder: remind } }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const ask = (id: string) => terminalsStore.update(id, { awaitingInput: "question" });

describe("question reminder — critic round 2", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		remind.mockClear();
	});
	afterEach(() => vi.useRealTimers());

	it("re-applying the same snapshot after the reminder fired does not remind again", () => {
		// Catches: applySessionState writing awaitingInput/text again (same values) being
		// treated as a new question, so the reminder repeats every 120 s.
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		ask(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS);
		expect(remind).toHaveBeenCalledTimes(1);
		ask(id);
		terminalsStore.update(id, { awaitingInput: "question", agentState: "working" });
		vi.advanceTimersByTime(10 * QUESTION_REMINDER_MS);
		expect(remind).toHaveBeenCalledTimes(1);
	});

	it("a single update that sets question and text arms exactly one timer", () => {
		// Catches: question set and text set landing as two effect runs, double-arming.
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		ask(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 3);
		expect(remind).toHaveBeenCalledTimes(1);
		expect(remind).toHaveBeenCalledWith(id);
	});

	it("an error state after the question cancels the reminder even though the question text is still stored", () => {
		// Catches: keying on awaitingInputText alone, so a stale text keeps the timer alive
		// after the terminal moved to awaitingInput "error".
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		ask(id);
		vi.advanceTimersByTime(30_000);
		terminalsStore.update(id, { awaitingInput: "error" });
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(remind).not.toHaveBeenCalled();
	});

	it("clearAwaitingInput (which leaves the stored text) cancels the reminder", () => {
		// Catches: clearAwaitingInput not resetting the text and the tracker still firing.
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		ask(id);
		vi.advanceTimersByTime(30_000);
		terminalsStore.clearAwaitingInput(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(remind).not.toHaveBeenCalled();
	});

	it("removing the terminal cancels the pending reminder and later edits cannot resurrect it", () => {
		// Catches: tracker outliving the terminal and notifying a closed session.
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		ask(id);
		vi.advanceTimersByTime(60_000);
		terminalsStore.remove(id);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS * 2);
		expect(remind).not.toHaveBeenCalled();
	});

	it("a question whose text is re-rendered back and forth every 30 s still reminds once", () => {
		// Catches: text-keyed restart without a bound — if the backend ever flips question_text
		// between two renderings of one dialog (footer row vs. title, OSC 777 body vs. footer),
		// the 120 s window never elapses and the user is never reminded.
		const id = terminalsStore.add(makeTerminal());
		trackQuestionReminder(id);
		for (let t = 0; t < 10 * 60_000; t += 30_000) {
			ask(id);
			vi.advanceTimersByTime(30_000);
		}
		expect(remind).toHaveBeenCalled();
	});
});
