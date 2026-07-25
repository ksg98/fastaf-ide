import { afterEach, describe, expect, it } from "vitest";
import { containsShellMetacharacters, sendCommand, shouldAutoSubmitSuggestion } from "../../utils/sendCommand";

/**
 * Fake writer that records every call in order. Returns a resolved promise
 * so sendCommand's internal awaits don't stall.
 */
function makeRecorder() {
	const calls: string[] = [];
	const writeFn = async (data: string): Promise<void> => {
		calls.push(data);
	};
	return { writeFn, calls };
}

/**
 * Replace navigator.platform for the duration of a test so isWindows()
 * returns the expected value. Restored via afterEach.
 */
function setPlatform(value: string) {
	Object.defineProperty(navigator, "platform", {
		value,
		configurable: true,
	});
}

describe("sendCommand", () => {
	const originalPlatform = navigator.platform;

	afterEach(() => {
		setPlatform(originalPlatform);
	});

	it("always sends Ctrl-U prefix when an agent is attached (ignores shellFamily)", async () => {
		setPlatform("Win32");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "ls", "claude", "windows-native");
		expect(calls).toEqual(["\x15ls", "\r"]);
	});

	it("sends Ctrl-U for POSIX shellFamily even when running on Windows (git-bash regression)", async () => {
		setPlatform("Win32");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "ls", null, "posix");
		expect(calls).toEqual(["\x15ls", "\r"]);
	});

	it("skips Ctrl-U for windows-native shellFamily when no agent", async () => {
		setPlatform("Win32");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "dir", null, "windows-native");
		expect(calls).toEqual(["dir", "\r"]);
	});

	it("falls back to platform heuristic for unknown shellFamily on Windows (skip)", async () => {
		setPlatform("Win32");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "echo hi", null, "unknown");
		expect(calls).toEqual(["echo hi", "\r"]);
	});

	it("falls back to platform heuristic for unknown shellFamily on macOS (send Ctrl-U)", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "ls", null, "unknown");
		expect(calls).toEqual(["\x15ls", "\r"]);
	});

	it("falls back to platform heuristic when shellFamily omitted on macOS", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "ls");
		expect(calls).toEqual(["\x15ls", "\r"]);
	});

	it("falls back to platform heuristic when shellFamily omitted on Windows", async () => {
		setPlatform("Win32");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "dir");
		expect(calls).toEqual(["dir", "\r"]);
	});

	it("wraps multi-line text in bracketed paste sequences", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "line1\nline2", null, "posix");
		expect(calls).toEqual(["\x15\x1b[200~line1\nline2\x1b[201~", "\r"]);
	});

	it("does not wrap single-line text in bracketed paste", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "single line", null, "posix");
		expect(calls).toEqual(["\x15single line", "\r"]);
	});

	it("sends Enter as a separate write regardless of prefix decision", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "foo", null, "posix");
		expect(calls.length).toBe(2);
		expect(calls[1]).toBe("\r");
	});

	it("withholds the trailing Enter when submit is false", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "rm -rf /", null, "posix", false);
		// Text is typed (with Ctrl-U prefix) but NOT executed — user must press Enter.
		expect(calls).toEqual(["\x15rm -rf /"]);
	});

	it("submits by default (submit omitted) — backward compatible", async () => {
		setPlatform("MacIntel");
		const { writeFn, calls } = makeRecorder();
		await sendCommand(writeFn, "ls", null, "posix");
		expect(calls).toEqual(["\x15ls", "\r"]);
	});
});

describe("containsShellMetacharacters", () => {
	it("flags command chaining, substitution, and redirection", () => {
		for (const s of ["a; b", "a | b", "a && b", "$(whoami)", "`id`", "echo > f", "cat < f", "a\nb"]) {
			expect(containsShellMetacharacters(s)).toBe(true);
		}
	});

	it("does not flag plain suggestion prose", () => {
		for (const s of ["Fix the bug", "Run tests", "Deploy", "Refactor auth module"]) {
			expect(containsShellMetacharacters(s)).toBe(false);
		}
	});
});

describe("shouldAutoSubmitSuggestion", () => {
	it("always submits on an agent, even multi-line or metachar-bearing text", () => {
		for (const s of ["Fix the bug", "line one\nline two", "a; b", "$(whoami)", "echo > f"]) {
			expect(shouldAutoSubmitSuggestion("codex", s)).toBe(true);
			expect(shouldAutoSubmitSuggestion("claude", s)).toBe(true);
		}
	});

	it("withholds submit on a shell for metachar-bearing or multi-line text", () => {
		for (const agentType of [null, undefined]) {
			for (const s of ["a; b", "a | b", "$(whoami)", "echo > f", "line one\nline two"]) {
				expect(shouldAutoSubmitSuggestion(agentType, s)).toBe(false);
			}
		}
	});

	it("submits on a shell for plain single-line prose", () => {
		for (const agentType of [null, undefined]) {
			for (const s of ["Run tests", "Deploy", "Fix the bug"]) {
				expect(shouldAutoSubmitSuggestion(agentType, s)).toBe(true);
			}
		}
	});
});
