import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribePtyOptions } from "../../transport";

let captured: SubscribePtyOptions | undefined;

vi.mock("../../transport", () => ({
	rpc: vi.fn(),
	subscribePty: vi.fn(async (_id: string, _onData: unknown, _onExit: unknown, opts: SubscribePtyOptions) => {
		captured = opts;
		return () => {};
	}),
}));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { OutputView } from "../components/OutputView";

/**
 * The backend re-sends the whole screen on every frame. Before the screen-row
 * reconciliation, each frame produced brand-new LogLine objects, which produced
 * brand-new block wrappers, which made Solid's reference-keyed `<For>` throw
 * away and rebuild every rendered row — thousands of DOM nodes per frame for a
 * screen where typically one row changed.
 *
 * These tests assert node identity, because that is the observable difference
 * between "updated the changed row" and "rebuilt the view".
 */
describe("OutputView screen-row reconciliation", () => {
	beforeEach(() => {
		captured = undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		// Auto-scroll defers to rAF; run it inline so no frame is left pending
		// when the test ends.
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Render the view and wait for its async mount to install the subscription. */
	async function mountView() {
		const result = render(() => <OutputView sessionId="sess-1" />);
		// onMount awaits the initial HTTP fetch before subscribing.
		await vi.waitFor(() => expect(captured).toBeDefined());
		return result;
	}

	const rowNodes = (container: HTMLElement) => Array.from(container.querySelectorAll("div.line"));

	const expectSameNodes = (after: Element[], before: Element[]) => {
		// Identity, not equality: two freshly built divs with the same text are
		// `toEqual` but represent exactly the rebuild this guards against.
		expect(after).toHaveLength(before.length);
		for (const [i, node] of after.entries()) {
			expect(node).toBe(before[i]);
		}
	};

	/**
	 * The wire shape. `PtyLogPayload.screen` is `Vec<LogLine>` in Rust, so every
	 * frame carries separately deserialized objects even for rows that never
	 * moved — reference comparison would never match a single one of them.
	 */
	const wireRow = (text: string, fg?: number) => ({
		spans: [{ text, ...(fg === undefined ? {} : { fg: { idx: fg } }) }],
	});

	it("keeps the DOM nodes of structured rows that did not change", async () => {
		const { container, unmount } = await mountView();

		captured?.onScreenRows?.([wireRow("alpha"), wireRow("beta"), wireRow("gamma")]);
		const before = rowNodes(container);
		expect(before).toHaveLength(3);

		// A new frame with identical content — the backend always resends it all,
		// as new objects.
		captured?.onScreenRows?.([wireRow("alpha"), wireRow("beta"), wireRow("gamma")]);
		expectSameNodes(rowNodes(container), before);
		unmount();
	});

	it("replaces only the structured row whose text changed", async () => {
		const { container, unmount } = await mountView();
		captured?.onScreenRows?.([wireRow("alpha"), wireRow("beta"), wireRow("gamma")]);
		const before = rowNodes(container);

		captured?.onScreenRows?.([wireRow("alpha"), wireRow("BETA"), wireRow("gamma")]);
		const after = rowNodes(container);

		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		expect(after[2]).toBe(before[2]);
		expect(after[1]?.textContent).toBe("BETA");
		unmount();
	});

	it("replaces a row whose colour changed but whose text did not", async () => {
		const { container, unmount } = await mountView();
		captured?.onScreenRows?.([wireRow("alpha"), wireRow("status", 2)]);
		const before = rowNodes(container);

		captured?.onScreenRows?.([wireRow("alpha"), wireRow("status", 1)]);
		const after = rowNodes(container);

		expect(after[0]).toBe(before[0]);
		expect(after[1]).not.toBe(before[1]);
		unmount();
	});

	it("keeps the DOM nodes of plain-string rows that did not change", async () => {
		const { container, unmount } = await mountView();
		captured?.onScreenRows?.(["alpha", "beta"]);
		const before = rowNodes(container);

		captured?.onScreenRows?.(["alpha", "beta"]);
		expectSameNodes(rowNodes(container), before);
		unmount();
	});
});
