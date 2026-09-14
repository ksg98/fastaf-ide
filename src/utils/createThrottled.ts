import { type Accessor, createEffect, createSignal, onCleanup } from "solid-js";

/**
 * Mirror a growing text accumulator at most once every `intervalMs`, always
 * settling on the last value it saw.
 *
 * This exists to decouple *render* cadence from *data* cadence. The AI token
 * batcher delivers a growing accumulator ~20 times a second, which is the right
 * rate for data but the wrong rate for layout: every change re-parses,
 * re-sanitizes and re-inserts the whole markdown document, so the cost of an
 * answer is quadratic in its length. Rendering on a slower cadence divides that
 * constant without dropping the final text — the trailing emit always fires.
 *
 * A value that does not extend what is already on screen is not throttled. An
 * accumulator only ever appends, so anything else means the stream was reset or
 * the panel switched to another conversation, and holding that back would leave
 * the previous answer visible under a header that has already moved on. Such a
 * value also restarts the interval, and an empty one restarts it from scratch:
 * rendering nothing costs nothing, so it must not spend the budget the first
 * token of the next answer needs.
 *
 * The value test alone cannot decide that, because a switch may land on an
 * answer that begins with the words already on screen: "Hello" growing into
 * "Hello world" looks the same whether one conversation wrote both or two wrote
 * one each. `generation` names which stream the value belongs to — the caller
 * passes the conversation id — and a change of it always emits at once, so a
 * held-back partial can never be shown under a header that has moved on.
 */
export function createThrottled(
	source: Accessor<string>,
	intervalMs: number,
	generation: Accessor<unknown>,
): Accessor<string> {
	const [value, setValue] = createSignal(source());
	let emitted = source();
	let emittedGeneration = generation();
	let lastEmit = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const cancelPending = () => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const emit = (next: string) => {
		emitted = next;
		setValue(next);
	};

	createEffect(() => {
		const next = source();
		const nextGeneration = generation();
		const switched = nextGeneration !== emittedGeneration;
		emittedGeneration = nextGeneration;
		if (switched) {
			// The prefix relation holds inside one stream and says nothing across
			// two, so the new stream starts on an unspent window: whatever it has
			// now renders at once, and so does its first value if it has none yet.
			cancelPending();
			lastEmit = 0;
		}
		// Covers the effect's first run, which only re-reads the value the signal
		// was seeded with. Comparing rather than skipping unconditionally matters
		// when the source moved between the seed and that run — with a panel
		// opened mid-answer, an unconditional skip would drop a real chunk.
		if (next === emitted) return;

		if (!next.startsWith(emitted)) {
			cancelPending();
			lastEmit = next === "" ? 0 : Date.now();
			emit(next);
			return;
		}

		const wait = intervalMs - (Date.now() - lastEmit);
		if (wait <= 0) {
			// A timer may still be pending and overdue if the main thread was
			// blocked past its deadline. Letting it survive would fire a second
			// render immediately after this one.
			cancelPending();
			lastEmit = Date.now();
			emit(next);
			return;
		}
		// A trailing emit is already pending; it reads the newest value when it
		// fires, so further changes inside the window need no extra timer.
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			lastEmit = Date.now();
			emit(source());
		}, wait);
	});

	onCleanup(cancelPending);

	return value;
}
