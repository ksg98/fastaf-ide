import { render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PtySubscription, SubscribePtyOptions } from "../../transport";

const { recordSocket } = vi.hoisted(() => ({ recordSocket: vi.fn() }));
vi.mock("../resumeTrail", () => ({ recordMobileSocketState: recordSocket }));

let captured: SubscribePtyOptions | undefined;
const pause = vi.fn();
const resume = vi.fn();

vi.mock("../../transport", () => ({
	rpc: vi.fn(),
	subscribePty: vi.fn(async (_id: string, _onData: unknown, _onExit: unknown, opts: SubscribePtyOptions) => {
		captured = opts;
		return Object.assign(() => {}, { pause, resume }) as PtySubscription;
	}),
}));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { OutputView } from "../components/OutputView";

/**
 * A backgrounded PWA has nothing to render, but the PTY WebSocket kept
 * streaming every frame of a busy agent into a view nobody can see — pure
 * battery and radio cost on the device least able to pay it.
 *
 * The socket is dropped on hide and reconnected on show. These tests assert the
 * view drives that, because "the stream stops" is the whole point of the story;
 * that the cursor survives the drop is asserted in the transport tests.
 */
describe("OutputView page-visibility gating", () => {
	let visibility: DocumentVisibilityState = "visible";

	const setVisibility = (state: DocumentVisibilityState) => {
		visibility = state;
		document.dispatchEvent(new Event("visibilitychange"));
	};

	beforeEach(() => {
		captured = undefined;
		recordSocket.mockClear();
		pause.mockClear();
		resume.mockClear();
		visibility = "visible";
		vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500 })),
		);
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			cb(0);
			return 0;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	/** Render the view and wait for its async mount to install the subscription. */
	async function mountView() {
		const result = render(() => <OutputView sessionId="sess-1" />);
		await vi.waitFor(() => expect(captured).toBeDefined());
		return result;
	}

	it("pauses the subscription when the page is hidden", async () => {
		await mountView();

		setVisibility("hidden");

		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).not.toHaveBeenCalled();
	});

	it("resumes the subscription when the page comes back", async () => {
		await mountView();

		setVisibility("hidden");
		setVisibility("visible");

		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it("does not pause a page that never went away", async () => {
		await mountView();

		setVisibility("visible");

		expect(pause).not.toHaveBeenCalled();
	});

	it("pauses at once when the view mounts on an already hidden page", async () => {
		visibility = "hidden";

		await mountView();

		// The subscription is installed by an awaited mount, so a page hidden
		// before that await finishes would otherwise stream until the NEXT
		// visibilitychange — which, for a tab restored in the background, may
		// never arrive.
		await vi.waitFor(() => expect(pause).toHaveBeenCalledTimes(1));
	});

	// Catches: mobile lifecycle reports show no stream state, so intentional
	// background pauses cannot be distinguished from failed reconnects.
	it("records stream phases without changing pause or reconnect behavior", async () => {
		const { unmount } = await mountView();
		expect(recordSocket.mock.calls).toEqual([
			["sess-1", "connecting"],
			["sess-1", "open"],
		]);
		setVisibility("hidden");
		setVisibility("visible");
		captured?.onReconnecting?.(1, 10);
		captured?.onReconnected?.();
		unmount();
		expect(recordSocket.mock.calls.slice(2)).toEqual([
			["sess-1", "paused"],
			["sess-1", "connecting"],
			["sess-1", "reconnecting"],
			["sess-1", "open"],
			["sess-1", "closed"],
		]);
		expect(pause).toHaveBeenCalledTimes(1);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it("stops listening once the view is disposed", async () => {
		const { unmount } = await mountView();

		unmount();
		setVisibility("hidden");

		expect(pause).not.toHaveBeenCalled();
	});
});
