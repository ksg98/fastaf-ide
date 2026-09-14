import { type Accessor, createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createThrottled } from "../../utils/createThrottled";

/**
 * `createThrottled` exists so the AI answer is not re-parsed, re-sanitized and
 * re-inserted on every one of the ~20 store updates a second the token batcher
 * produces. The contract that matters: the first token still shows up at once,
 * a burst collapses into one render, and the last value is never lost.
 *
 * Solid queues effects until the enclosing root finishes, so the harness closes
 * the root first and drives the source from outside it — otherwise nothing the
 * throttle does would be observable.
 */
describe("createThrottled", () => {
	function harness(intervalMs = 200) {
		const [source, setSource] = createSignal("");
		const [generation, setGeneration] = createSignal("conversation-a");
		let throttled!: Accessor<string>;
		let dispose!: () => void;
		createRoot((d) => {
			dispose = d;
			throttled = createThrottled(source, intervalMs, generation);
		});
		return { setSource, setGeneration, throttled: () => throttled(), dispose };
	}

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("emits the first change immediately", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("first token");
		expect(throttled()).toBe("first token");
		dispose();
	});

	it("collapses a burst inside the window into one emission", () => {
		const { setSource, throttled, dispose } = harness();
		const seen: string[] = [];
		setSource("a");
		seen.push(throttled());
		for (const chunk of ["ab", "abc", "abcd"]) {
			vi.advanceTimersByTime(50);
			setSource(chunk);
			seen.push(throttled());
		}
		// Only the leading emission has landed; the rest are still pending.
		expect(seen).toEqual(["a", "a", "a", "a"]);
		dispose();
	});

	it("settles on the last value it saw", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a");
		setSource("ab");
		setSource("abc");
		vi.advanceTimersByTime(200);
		expect(throttled()).toBe("abc");
		dispose();
	});

	it("emits again immediately once the window has passed", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a");
		vi.advanceTimersByTime(500);
		setSource("b");
		expect(throttled()).toBe("b");
		dispose();
	});

	it("passes a reset through at once", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a long finished answer");
		vi.advanceTimersByTime(10);
		// The store clears the accumulator when the next message starts. Holding
		// that back would leave the previous answer on screen under a `Show` that
		// has already flipped to the new stream.
		setSource("");
		expect(throttled()).toBe("");
		dispose();
	});

	it("renders the first token after a reset without waiting", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a long finished answer");
		vi.advanceTimersByTime(10);
		setSource("");
		setSource("H");
		expect(throttled()).toBe("H");
		dispose();
	});

	it("shows a switch to another conversation at once", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("answer for terminal A");
		vi.advanceTimersByTime(10);
		// Not an extension of what is on screen: the panel followed the focus to a
		// different conversation. Holding it back would show A's answer as B's.
		setSource("answer for terminal B");
		expect(throttled()).toBe("answer for terminal B");
		dispose();
	});

	it("shows a switch whose answer begins with the same words at once", () => {
		const { setSource, setGeneration, throttled, dispose } = harness();
		setSource("Hello");
		vi.advanceTimersByTime(10);
		// Terminal B's answer happens to start with the text A had emitted. By value
		// alone this is indistinguishable from A growing, so the text test lets B's
		// answer wait behind A's — and A's partial stays on screen under B's header.
		setGeneration("conversation-b");
		setSource("Hello world");
		expect(throttled()).toBe("Hello world");
		dispose();
	});

	it("still throttles growth inside one conversation", () => {
		const { setSource, setGeneration, throttled, dispose } = harness();
		setGeneration("conversation-b");
		setSource("Hello");
		vi.advanceTimersByTime(10);
		setSource("Hello world");
		expect(throttled()).toBe("Hello");
		vi.advanceTimersByTime(200);
		expect(throttled()).toBe("Hello world");
		dispose();
	});

	it("charges the window to the conversation it switched to", () => {
		const { setSource, setGeneration, throttled, dispose } = harness();
		setSource("Hello");
		vi.advanceTimersByTime(10);
		setGeneration("conversation-b");
		setSource("Hello world");
		// The switch spent the budget; B's next token waits for its own window
		// instead of inheriting whatever A had left.
		setSource("Hello world again");
		vi.advanceTimersByTime(150);
		expect(throttled()).toBe("Hello world");
		vi.advanceTimersByTime(100);
		expect(throttled()).toBe("Hello world again");
		dispose();
	});

	it("keeps a change that lands before the first effect run", () => {
		// A panel opened mid-answer reads one value when the signal is seeded and
		// another by the time effects flush. Skipping that first run outright
		// would drop the chunk in between.
		const [source, setSource] = createSignal("seed");
		let throttled!: Accessor<string>;
		let dispose!: () => void;
		createRoot((d) => {
			dispose = d;
			throttled = createThrottled(source, 200, () => "conversation-a");
			setSource("seed and more");
		});
		expect(throttled()).toBe("seed and more");
		dispose();
	});

	it("does not fire twice when an overdue timer outlives its window", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a");
		vi.advanceTimersByTime(50);
		setSource("ab"); // schedules a trailing emit due at +200

		// The main thread was blocked past that deadline: the wall clock is well
		// beyond it, but the timer callback has not had a turn yet.
		const blocked = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 400);
		setSource("abc"); // overdue by the clock, so it renders straight away
		expect(throttled()).toBe("abc");

		// The next chunk owes a full window. A surviving overdue timer would
		// render it the moment the event loop got a turn.
		setSource("abcd");
		vi.advanceTimersByTime(150);
		expect(throttled()).toBe("abc");
		vi.advanceTimersByTime(100);
		expect(throttled()).toBe("abcd");
		blocked.mockRestore();
		dispose();
	});

	it("drops the pending emission when its owner is disposed", () => {
		const { setSource, throttled, dispose } = harness();
		setSource("a");
		setSource("ab");
		dispose();
		vi.advanceTimersByTime(1000);
		expect(throttled()).toBe("a");
	});
});
