import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { CommandInput } from "../components/CommandInput";

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: vi.fn(async () => ({})),
}));

class Recognition {
	static current: Recognition;
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onerror = null;
	onend = null;
	constructor() {
		Recognition.current = this;
	}
	start() {}
	stop() {}
	abort() {}
	result(...transcripts: string[]) {
		this.onresult?.({ results: transcripts.map((transcript) => ({ 0: { transcript }, isFinal: true })) });
	}
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

// Catches: cumulative final speech is appended a second time after a manual draft edit.
it("keeps final speech exactly once when typing a suffix between recognition results", () => {
	vi.stubGlobal("SpeechRecognition", Recognition);
	render(() => <CommandInput sessionId="draft-review" managedSession awaitingInput />);
	fireEvent.click(screen.getByRole("button", { name: "Dictate into draft" }));
	Recognition.current.result("run tests");
	const draft = screen.getByRole("textbox") as HTMLTextAreaElement;
	fireEvent.input(draft, { target: { value: "run tests in package" } });
	Recognition.current.result("run tests", "now");
	expect(draft.value).toContain("in package");
	expect(draft.value.match(/run tests/g)).toHaveLength(1);
});
