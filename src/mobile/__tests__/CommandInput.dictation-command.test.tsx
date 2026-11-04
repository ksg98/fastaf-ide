import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { CommandInput } from "../components/CommandInput";
import { TerminalKeybar } from "../components/TerminalKeybar";

vi.mock("../../stores/appLogger", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../stores/appLogger")>();
	return { ...original, appLogger: { ...original.appLogger, debug: vi.fn(), info: vi.fn() } };
});

vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => ({})),
	HttpRpcError: class extends Error {},
}));

import { rpc } from "../../transport";

// A Web Speech callback driver, not evidence of iPhone audio recognition.
class Recognition {
	static current: Recognition;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		Recognition.current = this;
	}
	start() {}
	stop() {}
	abort() {}
}

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});

// Catches: a new mobile composer assumes the PTY is empty and appends speech to an unseen slash draft.
it.each(["/wiz:work ", "/", "old draft"])("replaces unseen %s before sending dictated text", async (initial) => {
	vi.stubGlobal("SpeechRecognition", Recognition);
	let remoteDraft = initial;
	let submitted = "";
	vi.mocked(rpc).mockImplementation(async (command, args) => {
		if (command === "write_pty") {
			for (const char of String(args?.data)) {
				if (char === "\r") submitted = remoteDraft;
				else if (char === "\x7f") remoteDraft = remoteDraft.slice(0, -1);
				else remoteDraft += char;
			}
		}
		return {} as never;
	});
	const view = render(() => (
		<CommandInput
			sessionId="speech"
			ptyInputLine={initial}
			agentType="claude"
			slashItems={[{ command: "/wiz:work", description: "Work", highlighted: true }]}
		/>
	));
	expect(view.getByRole("textbox")).toHaveValue("");
	fireEvent.click(view.getByRole("button", { name: "Dictate into draft" }));
	Recognition.current.onresult?.({ results: [{ 0: { transcript: "OMB è un assistente." }, isFinal: true }] });
	Recognition.current.onend?.();
	expect(view.getByRole("textbox")).toHaveValue("OMB è un assistente.");
	fireEvent.click(view.getByRole("button", { name: "Send" }));
	await waitFor(() => expect(submitted).not.toBe(""));
	expect(submitted).toBe("OMB è un assistente.");
});

// Catches: treating the always-accented slash key as a sticky dictation modifier.
it("inserts slash only on an explicit quick-key tap", () => {
	let insert: ((text: string) => void) | undefined;
	const view = render(() => (
		<>
			<TerminalKeybar sessionId="slash" onSlashRequest={() => insert?.("/")} />
			<CommandInput
				sessionId="slash"
				onRegisterInsertText={(fn) => {
					insert = fn;
				}}
			/>
		</>
	));
	expect(view.getByRole("textbox")).toHaveValue("");
	fireEvent.click(view.getByRole("button", { name: "/" }));
	expect(view.getByRole("textbox")).toHaveValue("/");
	expect(view.getByRole("button", { name: "/" })).not.toHaveAttribute("aria-pressed");
});
