import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { CommandInput } from "../components/CommandInput";
import type { ChoicePrompt } from "../useSessions";

vi.mock("../../transport", () => ({
	buildHttpUrl: (path: string) => `http://localhost${path}`,
	rpc: vi.fn(() => Promise.resolve(undefined)),
	HttpRpcError: class extends Error {},
}));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn() } }));

import { toastsStore } from "../../stores/toasts";
import { rpc } from "../../transport";

const prompt: ChoicePrompt = {
	title: "Which color?",
	options: [
		{ key: "1", label: "Red", highlighted: true, destructive: false },
		{ key: "2", label: "Blue", highlighted: false, destructive: false },
	],
	selection_mode: "navigate-enter",
};

function deferredWrite() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	vi.mocked(rpc).mockImplementationOnce(() => promise as never);
	return { resolve, reject };
}

const writes = () =>
	vi
		.mocked(rpc)
		.mock.calls.filter(([command]) => command === "write_pty")
		.map(([, args]) => args);

afterEach(() => {
	cleanup();
	vi.mocked(rpc).mockReset();
	vi.mocked(rpc).mockResolvedValue(undefined);
	vi.mocked(toastsStore.add).mockClear();
});

// Catches: later navigation/Enter keys read the new session (or a null parent)
// after the first key's HTTP acknowledgement instead of the tapped session.
it.each(["replacement", null])("keeps an ego answer bound when the selected session becomes %s", async (next) => {
	const pending = deferredWrite();
	const [session, setSession] = createSignal<{ session_id: string } | null>({ session_id: "question-owner" });
	const view = render(() => <CommandInput sessionId={session()!.session_id} agentType="ego" choicePrompt={prompt} />);
	fireEvent.click(view.getByRole("button", { name: "2 Blue" }));
	expect(writes()).toEqual([{ sessionId: "question-owner", data: "\x1b[B" }]);
	// Same getter chain as MobileApp -> SessionDetailScreen -> CommandInput;
	// dispose first for null, as Back unmounts the detail before the ack arrives.
	if (next === null) view.unmount();
	setSession(next === null ? null : { session_id: next });
	pending.resolve();
	await waitFor(() => expect(writes()).toHaveLength(2));
	expect(writes()).toEqual([
		{ sessionId: "question-owner", data: "\x1b[B" },
		{ sessionId: "question-owner", data: "\r" },
	]);
	expect(toastsStore.add).not.toHaveBeenCalled();
});

// Catches: a changed agent/prompt after a Grok key ack adds an unwanted Enter
// into the replacement session's composer. The native answer is one raw key.
it("sends exactly one Grok answer despite replacement of the question and agent", async () => {
	const pending = deferredWrite();
	const [agent, setAgent] = createSignal("grok");
	const [question, setQuestion] = createSignal<ChoicePrompt | undefined>({ ...prompt, selection_mode: undefined });
	const view = render(() => <CommandInput sessionId="question-owner" agentType={agent()} choicePrompt={question()} />);
	fireEvent.click(view.getByRole("button", { name: "2 Blue" }));
	setAgent("claude");
	setQuestion(undefined);
	pending.resolve();
	// Drain the actual async handler, not a mocked sendPtyKey.
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(writes()).toEqual([{ sessionId: "question-owner", data: "2" }]);
});

// Catches: a rejected answer permanently disables the choices or silently fails.
it("re-enables choice buttons and reports a failed answer before a retry", async () => {
	const pending = deferredWrite();
	const view = render(() => <CommandInput sessionId="question-owner" agentType="grok" choicePrompt={prompt} />);
	const blue = view.getByRole("button", { name: "2 Blue" }) as HTMLButtonElement;
	fireEvent.click(blue);
	expect(blue.disabled).toBe(true);
	pending.reject(new Error("offline"));
	await waitFor(() => expect(blue.disabled).toBe(false));
	expect(toastsStore.add).toHaveBeenCalledWith("Send failed", "Could not send choice: offline", "error", true);
	fireEvent.click(blue);
	await waitFor(() => expect(writes()).toHaveLength(3));
	expect(writes().every((args) => args?.sessionId === "question-owner")).toBe(true);
});

// Catches: delayed Enter targets the newly selected session instead of the one
// whose live text delta is still in flight.
it("keeps composer Enter on the session that received its text", async () => {
	const pending = deferredWrite();
	const [session, setSession] = createSignal("draft-owner");
	const view = render(() => <CommandInput sessionId={session()} agentType="grok" />);
	fireEvent.input(view.container.querySelector("textarea")!, { target: { value: "hello" } });
	fireEvent.click(view.getByRole("button", { name: "Send" }));
	setSession("replacement");
	pending.resolve();
	await waitFor(() => expect(writes()).toHaveLength(2));
	expect(writes()).toEqual([
		{ sessionId: "draft-owner", data: "hello" },
		{ sessionId: "draft-owner", data: "\r" },
	]);
});

// Catches: Queue waits for a draft write, then queues its text on another session.
it("queues the draft for its original session after the last input write settles", async () => {
	const pending = deferredWrite();
	const [session, setSession] = createSignal("draft-owner");
	vi.mocked(rpc).mockResolvedValue({ accepted: true, typed: false });
	const view = render(() => <CommandInput sessionId={session()} />);
	fireEvent.input(view.container.querySelector("textarea")!, { target: { value: "next task" } });
	fireEvent.click(view.getByRole("button", { name: "More composer actions" }));
	fireEvent.click(view.getByRole("menuitem", { name: "Queue" }));
	setSession("replacement");
	pending.resolve();
	await waitFor(() =>
		expect(rpc).toHaveBeenCalledWith("enqueue_agent_command", {
			sessionId: "draft-owner",
			text: "next task",
			expectedDraft: "next task",
		}),
	);
});
