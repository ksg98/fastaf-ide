import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { ideasStore } from "../../stores/ideas";
import { toastsStore } from "../../stores/toasts";
import { rpc } from "../../transport";
import { IdeasOverlay } from "../components/IdeasOverlay";

vi.mock("../../transport", () => ({ rpc: vi.fn(async () => ({ language: "it" })) }));
vi.mock("../../stores/ideas", () => ({
	ideasStore: { getFilteredIdeas: () => [], addIdea: vi.fn() },
}));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));

class Recognition {
	static current: Recognition;
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		Recognition.current = this;
	}
	start() {}
	stop() {}
	abort = vi.fn();
	result(transcript: string) {
		this.onresult?.({ results: [{ 0: { transcript }, isFinal: false }] });
	}
}

function mount() {
	vi.stubGlobal("SpeechRecognition", Recognition);
	render(() => <IdeasOverlay sessionId="never-write-here" repoPath="/repo" onDismiss={() => {}} />);
	return screen.getByRole("textbox") as HTMLTextAreaElement;
}

function start() {
	fireEvent.click(screen.getByRole("button", { name: "Dictate into draft" }));
	return Recognition.current;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

// Catches: the mobile mic routes speech to the terminal or appends after the idea's suffix.
it("dictates into the idea selection without sending to a session or saving an idea", async () => {
	const input = mount();
	fireEvent.input(input, { target: { value: "Review old later" } });
	input.setSelectionRange(7, 10);
	await Promise.resolve();
	const take = start();
	expect(take.lang).toBe("it");
	take.result("the diff");
	expect(input.value).toBe("Review the diff later");
	take.result("the changes");
	expect(input.value).toBe("Review the changes later");
	expect(ideasStore.addIdea).not.toHaveBeenCalled();
	expect(vi.mocked(rpc).mock.calls.map(([command]) => command)).toEqual(["get_dictation_config"]);
});

// Catches: an empty take deletes the user's selected text.
it("preserves the selection after empty recognition and inserts the next take at the caret", () => {
	const input = mount();
	fireEvent.input(input, { target: { value: "Keep this idea" } });
	input.setSelectionRange(5, 9);
	const empty = start();
	empty.result("");
	expect(input.value).toBe("Keep this idea");
	empty.onend?.();
	input.setSelectionRange(input.value.length, input.value.length);
	start().result("for later");
	expect(input.value).toBe("Keep this idea for later");
});

// Catches: the Ideas consumer bypasses shared error shutdown or cannot dictate again.
it("uses shared failed-take recovery and reports the failure only in a toast", () => {
	const input = mount();
	const first = start();
	first.onerror?.({ error: "no-speech" });
	expect(first.abort).toHaveBeenCalledOnce();
	expect(toastsStore.add).toHaveBeenCalledExactlyOnceWith("Dictation failed", "No speech detected", "error", true);
	expect(screen.queryByRole("status")).toBeNull();
	first.onend?.();
	start().result("A new idea");
	expect(input.value).toBe("A new idea");
	expect(screen.queryByRole("status")).toBeNull();
});

// Catches: a late recognition result overwrites a manual edit or restores an already-added idea.
it.each(["edit", "add"])("discards late speech after an explicit idea %s", (action) => {
	const input = mount();
	const take = start();
	take.result("Remember this");
	const late = take.onresult!;
	if (action === "edit") fireEvent.input(input, { target: { value: "My edit" } });
	else fireEvent.keyDown(input, { key: "Enter" });
	expect(take.abort).toHaveBeenCalledOnce();
	late({ results: [{ 0: { transcript: "stale words" }, isFinal: true }] });
	expect(input.value).toBe(action === "edit" ? "My edit" : "");
	if (action === "add") expect(ideasStore.addIdea).toHaveBeenCalledWith("Remember this", "/repo", "repo");
	expect(vi.mocked(rpc).mock.calls.map(([command]) => command)).toEqual(["get_dictation_config"]);
});
