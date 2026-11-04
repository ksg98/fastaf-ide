import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toastsStore } from "../../stores/toasts";
import { rpc } from "../../transport";
import { CommandInput } from "../components/CommandInput";

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: vi.fn(async () => ({})),
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
	start = vi.fn();
	stop = vi.fn();
	abort() {}
}

function dictate() {
	fireEvent.click(screen.getByRole("button", { name: "Dictate into draft" }));
	const current = Recognition.instances.at(-1);
	if (!current) throw new Error("Recognition was not constructed");
	return current;
}

/** The push_log bodies the server would receive for source=dictation. */
function serverLines() {
	return vi
		.mocked(rpc)
		.mock.calls.filter(
			([command, args]) => command === "push_log" && (args as { source?: string }).source === "dictation",
		)
		.map(([, args]) => args as { level: string; message: string; dataJson: string | null });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.spyOn(console, "debug").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.stubGlobal("webkitSpeechRecognition", Recognition);
	render(() => <CommandInput sessionId="errors" managedSession awaitingInput />);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.clearAllMocks();
	Recognition.instances = [];
});

// Catches: focus and activation both starting speech for one mic tap.
it("starts once when the mic receives focus and one activation", () => {
	const mic = screen.getByRole("button", { name: "Dictate into draft" });
	fireEvent.pointerDown(mic);
	mic.focus();
	fireEvent.click(mic);
	expect(Recognition.instances).toHaveLength(1);
	expect(Recognition.instances[0].start).toHaveBeenCalledOnce();
});

// Catches: abort's follow-up error creating a second toast for the same failed take.
it("reports one failure when audio capture fails and shutdown reports aborted", () => {
	const current = dictate();
	const error = current.onerror!;
	error({ error: "audio-capture" });
	error({ error: "aborted" });
	current.onend?.();
	expect(toastsStore.add).toHaveBeenCalledExactlyOnceWith(
		"Dictation failed",
		"No microphone found, or it is in use",
		"error",
		true,
	);
});

// Catches: the toast leaves a second, persistent failure label and red mic over the composer.
it("keeps a failure in the toast without retaining a composer failure label", () => {
	const current = dictate();
	current.onerror?.({ error: "audio-capture" });
	expect(toastsStore.add).toHaveBeenCalledOnce();
	expect(screen.queryByText("Dictation failed")).toBeNull();
	current.onend?.();
	const mic = screen.getByRole("button", { name: "Dictate into draft" });
	expect(mic.getAttribute("data-failed")).toBeNull();
	expect(mic.getAttribute("aria-pressed")).toBe("false");
});

// Catches: a recognition error code and state that never leave the phone, so the cause of
// "Dictation failed" cannot be proven from the server log.
it("sends the error code and the recognition state to the server log", async () => {
	const current = dictate();
	current.onresult?.({ results: [{ 0: { transcript: "partial words" }, isFinal: false }] });
	current.onerror?.({ error: "network" });
	await flush();
	const lines = serverLines().filter((line) => line.level === "warn");
	expect(lines).toHaveLength(1);
	expect(lines[0].message).toContain("network");
	expect(JSON.parse(lines[0].dataJson ?? "{}")).toMatchObject({ code: "network", recording: true, partialChars: 13 });
});

// Catches: the logger coalescing consecutive failures by message, so a second failure with a
// different code is dropped from the server and only the first code is ever visible.
it("sends every failure when two different codes follow each other", async () => {
	// Codes unlike the previous test's: an identical consecutive message is coalesced by design.
	dictate().onerror?.({ error: "audio-capture" });
	Recognition.instances.at(-1)?.onend?.();
	dictate().onerror?.({ error: "language-not-supported" });
	await flush();
	const text = serverLines()
		.filter((line) => line.level === "warn")
		.map((line) => line.dataJson)
		.join(" ");
	expect(text).toContain("audio-capture");
	expect(text).toContain("language-not-supported");
});

// Catches: a toast that says only "Dictation failed" next to a raw code the user cannot read.
it.each([
	["not-allowed", "permission denied"],
	["service-not-allowed", "not allowed"],
	["no-speech", "No speech"],
	["audio-capture", "microphone"],
	["network", "unavailable"],
])("names %s in plain words in the toast", (code, words) => {
	dictate().onerror?.({ error: code });
	const [, message] = vi.mocked(toastsStore.add).mock.calls[0];
	expect(message).toContain(words);
	expect(message).not.toBe(code);
});

// Catches: an unknown code is swallowed instead of shown.
it("falls back to the raw code for a code it does not know", () => {
	dictate().onerror?.({ error: "bad-grammar" });
	expect(vi.mocked(toastsStore.add).mock.calls[0][1]).toContain("bad-grammar");
});

// Catches: mobile lifecycle debug records never reach the owner, lose their order/identity,
// or grow per hypothesis so the next stuck-take trace cannot be reconstructed.
it("mirrors one bounded ordered lifecycle for an error then end, with session and take identity", async () => {
	const debugOutput = vi.spyOn(console, "debug").mockImplementation(() => {});
	try {
		const current = dictate();
		const result = current.onresult!;
		const error = current.onerror!;
		const end = current.onend!;
		result({ results: [{ 0: { transcript: "private first hypothesis" }, isFinal: false }] });
		result({ results: [{ 0: { transcript: "private later hypothesis" }, isFinal: false }] });
		error({ error: "network" });
		error({ error: "aborted" });
		end();
		end();
		await flush();
		const lifecycle = () => serverLines().filter((line) => line.level === "debug");
		const first = lifecycle().map((line) => JSON.parse(line.dataJson ?? "{}"));
		expect(first.map((entry) => entry.event)).toEqual([
			"start",
			"first-result",
			"error",
			"abort-requested",
			"end",
			"ownership-release",
		]);
		expect(first.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
		const takeId = first[0].takeId;
		expect(takeId).toEqual(expect.any(String));
		expect(takeId.length).toBeGreaterThan(0);
		for (const entry of first) expect(entry).toMatchObject({ sessionId: "errors", takeId });
		expect(first[2].code).toBe("network");
		expect(first[5].recording).toBe(false);
		expect(JSON.stringify(first)).not.toContain("private");
		// A new take must remain distinguishable even in one browser/session.
		dictate().onend?.();
		await flush();
		const second = lifecycle()
			.slice(6)
			.map((line) => JSON.parse(line.dataJson ?? "{}"));
		expect(second.map((entry) => entry.event)).toEqual(["start", "end", "ownership-release"]);
		expect(second.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
		expect(second[0].takeId).not.toBe(takeId);
	} finally {
		debugOutput.mockRestore();
	}
});
