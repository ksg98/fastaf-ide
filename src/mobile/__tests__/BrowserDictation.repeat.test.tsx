import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandInput } from "../components/CommandInput";

vi.mock("../../stores/appLogger", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../stores/appLogger")>();
	return { ...original, appLogger: { ...original.appLogger, warn: vi.fn(), info: vi.fn() } };
});

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: vi.fn(async () => ({})),
}));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));

// Lifecycle driver, not an iPhone recording: end is deliberately separate from
// abort/error, as specified at https://webaudio.github.io/web-speech-api/.
// Physical iOS timing remains an assumption pending Boss's device replay.
class Recognition {
	static instances: Recognition[] = [];
	static failStart = false;
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((event: { results: { 0: { transcript: string }; isFinal: boolean }[] }) => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	constructor() {
		Recognition.instances.push(this);
	}
	start() {
		if (Recognition.failStart) throw new Error("start refused");
	}
	stop() {}
	abort = vi.fn();
	result(transcript: string) {
		this.onresult?.({ results: [{ 0: { transcript }, isFinal: true }] });
	}
}

function start() {
	fireEvent.click(screen.getByRole("button", { name: "Dictate into draft" }));
	const current = Recognition.instances.at(-1);
	if (!current) throw new Error("Recognition was not constructed");
	return current;
}

function mount() {
	vi.stubGlobal("webkitSpeechRecognition", Recognition);
	render(() => <CommandInput sessionId="repeat-dictation" managedSession awaitingInput />);
	return screen.getByRole("textbox") as HTMLTextAreaElement;
}

afterEach(() => {
	cleanup();
	localStorage.clear();
	vi.unstubAllGlobals();
	Recognition.instances = [];
	Recognition.failStart = false;
});

// Catches: cancel/error drops the live service before end, allowing overlapping
// starts and losing the end callback needed to release microphone ownership.
it.each(["draft edit", "aborted", "network"])("waits for end after %s before dictating again", (reason) => {
	const draft = mount();
	const first = start();
	first.result("first");
	if (reason === "draft edit") fireEvent.input(draft, { target: { value: "edited" } });
	else first.onerror?.({ error: reason });
	first.result("late result");
	expect(draft.value).toBe(reason === "draft edit" ? "edited" : "first");
	fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
	expect(Recognition.instances).toHaveLength(1);
	first.onend?.();
	start().result("second");
	expect(draft.value).toBe(reason === "draft edit" ? "edited second" : "first second");
	Recognition.instances[1].onend?.();
	start().result("third");
	expect(draft.value).toBe(reason === "draft edit" ? "edited second third" : "first second third");
});

// Catches: onerror latches discarding without requesting shutdown, so the next
// take cannot insert its transcript without a manual send. This synthetic service
// ends after abort; it is not evidence of the original iPhone callback ordering.
it.each(["aborted", "network", "no-speech"])(
	"finishes a failed %s take before inserting the next transcript",
	async (error) => {
		const draft = mount();
		const first = start();
		first.abort.mockImplementation(() => queueMicrotask(() => first.onend?.()));
		first.onerror?.({ error });
		first.result("discarded");
		expect(draft.value).toBe("");
		await Promise.resolve();
		// Retry through the actual mic control, even if stale ownership left it
		// labelled Stop. The oracle is inserted text, not an abort spy count.
		fireEvent.click(screen.getByRole("button", { name: /^(Dictate into draft|Stop dictation)$/ }));
		Recognition.instances.at(-1)!.result("retry succeeded");
		expect(draft.value).toBe("retry succeeded");
	},
);

// Catches: an empty successful take leaves ownership behind despite its end.
it("inserts the next transcript after an empty take ends", () => {
	const draft = mount();
	const first = start();
	first.result("");
	first.onend?.();
	start().result("retry succeeded");
	expect(screen.queryByRole("status")).toBeNull();
	expect(draft.value).toBe("retry succeeded");
});

// Catches: normal completion retains the old recognizer or its draft tail.
it("dictates three times after result then end without duplicating earlier speech", () => {
	const draft = mount();
	for (const text of ["first", "second", "third"]) {
		const current = start();
		current.result(text);
		current.onend?.();
	}
	expect(draft.value).toBe("first second third");
	expect(Recognition.instances).toHaveLength(3);
});

// Catches: waiting for an end event after start throws, permanently locking the mic.
it("dictates again after a synchronous start failure without waiting for end", () => {
	const draft = mount();
	Recognition.failStart = true;
	start();
	Recognition.failStart = false;
	start().result("retry succeeded");
	expect(screen.queryByRole("status")).toBeNull();
	expect(draft.value).toBe("retry succeeded");
});

// Catches: push-to-talk dictation on a phone lets the screen auto-lock mid-recording,
// and a lock that outlives every way a recording ends (stop, error, abort).
describe("screen wake lock while dictating", () => {
	const lock = { release: vi.fn(async () => {}) };
	const request = vi.fn(async () => lock);
	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	beforeEach(() => {
		localStorage.clear();
		Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
	});
	afterEach(() => {
		Reflect.deleteProperty(navigator, "wakeLock");
		vi.clearAllMocks();
	});

	it("holds the lock from start to end", async () => {
		mount();
		const current = start();
		await flush();
		expect(request).toHaveBeenCalledOnce();
		expect(lock.release).not.toHaveBeenCalled();
		current.onend?.();
		expect(lock.release).toHaveBeenCalledOnce();
	});

	it("releases the lock when recognition fails to start", async () => {
		mount();
		Recognition.failStart = true;
		start();
		await flush();
		expect(lock.release).toHaveBeenCalledTimes(request.mock.calls.length);
	});

	it("holds one lock across a repeat dictation, not a leaked one per take", async () => {
		mount();
		for (let take = 0; take < 3; take++) {
			start().onend?.();
			await flush();
		}
		expect(request).toHaveBeenCalledTimes(3);
		expect(lock.release).toHaveBeenCalledTimes(3);
	});
});
