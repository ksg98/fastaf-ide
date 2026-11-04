import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

const { createSession } = vi.hoisted(() => ({
	createSession: vi.fn().mockResolvedValue("session-1"),
}));

vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ createSession, resize: vi.fn(), close: vi.fn(), getKittyFlags: vi.fn().mockResolvedValue(0) }),
}));
vi.mock("../../stores/agentConfigs", () => ({
	ensureAgentConfigsForRepo: vi.fn().mockResolvedValue({ getEnvFlags: () => ({}) }),
	agentConfigsForRepo: () => ({ getEnvFlags: () => ({}) }),
}));
vi.mock("../../components/Terminal/glyphCache", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/glyphCache")>()),
	getSharedMetrics: () => ({ cellWidth: 8, cellHeight: 16 }),
}));
vi.mock("../../components/Terminal/CanvasTerminal", () => ({ default: () => <div /> }));

import { QUESTION_REMINDER_MS } from "../../components/Terminal/questionReminder";
import { Terminal } from "../../components/Terminal/Terminal";
import { notificationsStore } from "../../stores/notifications";
import { terminalsStore } from "../../stores/terminals";

describe("Terminal question reminder wiring", () => {
	afterEach(() => vi.useRealTimers());

	// Catches: the reminder tracker not being started by the mounted Terminal.
	it("re-notifies a question still pending 120 s after a mounted Terminal saw it", () => {
		const reminder = vi.spyOn(notificationsStore, "playQuestionReminder").mockResolvedValue(undefined);
		vi.spyOn(notificationsStore, "playQuestion").mockResolvedValue(undefined);
		const id = terminalsStore.add({
			sessionId: null,
			cwd: "/tmp/repo",
			repoPath: null,
			name: "shell",
			fontSize: 13,
			awaitingInput: null,
		});
		render(() => <Terminal id={id} cwd="/tmp/repo" alwaysVisible />);
		vi.useFakeTimers();
		terminalsStore.setAwaitingInput(id, "question", true);
		vi.advanceTimersByTime(QUESTION_REMINDER_MS);
		expect(reminder).toHaveBeenCalledExactlyOnceWith(id);
	});
});
