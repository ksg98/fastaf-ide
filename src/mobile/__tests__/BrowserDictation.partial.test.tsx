import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { rpc } from "../../transport";
import { CommandInput } from "../components/CommandInput";

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: vi.fn(async (command: string) =>
		command === "submit_agent_reply" ? { status: "ok", submitted: true, acknowledged: true } : {},
	),
}));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));

class Recognition {
	static instances: Recognition[] = [];
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		Recognition.instances.push(this);
	}
	start() {}
	stop() {}
	abort() {}
}

const mount = (sessionId = "partial-a") =>
	render(() => <CommandInput sessionId={sessionId} managedSession awaitingInput />);
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;

function dictate(transcript: string) {
	fireEvent.click(screen.getByRole("button", { name: "Dictate into draft" }));
	const current = Recognition.instances.at(-1);
	if (!current) throw new Error("Recognition was not constructed");
	current.onresult?.({ results: [{ 0: { transcript }, isFinal: false }] });
	return current;
}

/** The page is reloaded: the component is gone, localStorage survives. */
function reload(sessionId = "partial-a") {
	cleanup();
	return mount(sessionId);
}

beforeEach(() => {
	localStorage.clear();
	vi.stubGlobal("webkitSpeechRecognition", Recognition);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	Recognition.instances = [];
});

// Catches: the partial transcript lives only in a signal, so a PWA reload during or after a
// failed dictation loses what was said.
it("offers the dictated partial back in the composer after a reload", () => {
	mount();
	dictate("review the changes").onerror?.({ error: "network" });
	reload();
	expect(composer().value).toBe("review the changes");
});

// Catches: a restore that presses Enter or writes to the terminal, sending words the user never re-read.
it("restores into the composer only, never sending or typing into the session", () => {
	mount();
	dictate("review the changes");
	vi.mocked(rpc).mockClear();
	reload();
	expect(composer().value).toBe("review the changes");
	expect(
		vi.mocked(rpc).mock.calls.filter(([command]) => command === "write_pty" || command === "submit_agent_reply"),
	).toEqual([]);
});

// Catches: a sent reply comes back after the next reload.
it("forgets the partial once it is sent", async () => {
	mount();
	dictate("review the changes");
	fireEvent.keyDown(composer(), { key: "Enter" });
	await vi.waitFor(() => expect(vi.mocked(rpc)).toHaveBeenCalledWith("submit_agent_reply", expect.anything()));
	await new Promise((resolve) => setTimeout(resolve, 0));
	reload();
	expect(composer().value).toBe("");
});

// Catches: text the user typed over the dictation is replaced by the old transcript after a reload.
it("forgets the partial once the user edits the draft", () => {
	mount();
	dictate("review the changes");
	fireEvent.input(composer(), { target: { value: "review the changes now" } });
	reload();
	expect(composer().value).toBe("");
});

// Catches: the draft of one session appearing in another session's composer.
it("keeps the partial of each session apart", () => {
	mount("partial-a");
	dictate("only for a");
	reload("partial-b");
	expect(composer().value).toBe("");
	reload("partial-a");
	expect(composer().value).toBe("only for a");
});

// Catches: a cleared composer (Escape) resurrecting its old transcript.
it("forgets the partial once the composer is cleared", () => {
	mount();
	dictate("review the changes");
	fireEvent.keyDown(composer(), { key: "Escape" });
	reload();
	expect(composer().value).toBe("");
});
