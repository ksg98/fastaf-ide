// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SubscribePtyOptions } from "../../transport";

const stream = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("../../transport", () => ({ subscribePty: stream.subscribe }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { ConnectionBanner } from "../components/ConnectionBanner";
import { OutputView } from "../components/OutputView";

let options: SubscribePtyOptions;
let exit: () => void;
let visibility: DocumentVisibilityState;
const stop = vi.fn();
function setVisibility(state: DocumentVisibilityState) {
	visibility = state;
	document.dispatchEvent(new Event("visibilitychange"));
}
function Harness(props: { sessionExists?: boolean } = {}) {
	const [error, setError] = createSignal<string | null>(null);
	let retry: (() => void) | undefined;
	return (
		<>
			<ConnectionBanner offline={error() !== null} authError={false} error={error()} onRetry={() => retry?.()} />
			<OutputView
				sessionExists={props.sessionExists}
				sessionId="test-session"
				onConnectionError={setError}
				onRegisterRetry={(value) => {
					retry = value;
				}}
			/>
		</>
	);
}
beforeEach(() => {
	vi.useFakeTimers();
	visibility = "visible";
	vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
	stop.mockClear();
	stream.subscribe.mockReset().mockImplementation(async (_id, _data, _exit, opts) => {
		options = opts;
		exit = _exit;
		return Object.assign(stop, { pause: vi.fn(), resume: vi.fn() });
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: true, json: async () => ({ lines: [], screen: [], total_lines: 0 }) })),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("requestAnimationFrame", () => 0);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("terminal stream connection landing", () => {
	// Catches: a disposed subscription remains owned and visibility resume cannot reopen it.
	it("visible_pwa_restarts_stream_after_hidden_retry_exhaustion", async () => {
		const view = render(() => <Harness sessionExists={true} />);
		await vi.advanceTimersByTimeAsync(0);
		options.onReconnecting?.(10, 10);
		await vi.advanceTimersByTimeAsync(5_000);
		exit(); // Our transport reports onExit after disposing its exhausted subscription.
		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(30_000);
		expect(stream.subscribe).toHaveBeenCalledTimes(1);
		setVisibility("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.subscribe).toHaveBeenCalledTimes(2);
		options.onLogLines?.([{ spans: [{ text: "output after returning" }] }]);
		expect(view.getByText("output after returning")).toBeTruthy();
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});
	// Catches: visibility recovery reopens a terminal already removed by the session poll.
	it("does not restart a confirmed ended session on hide/show or manual retry", async () => {
		const [exists, setExists] = createSignal(true);
		let retry: (() => void) | undefined;
		render(() => (
			<OutputView sessionId="ended" sessionExists={exists()} onRegisterRetry={(value) => (retry = value)} />
		));
		await vi.advanceTimersByTimeAsync(0);
		setExists(false);
		exit();
		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(30_000);
		setVisibility("visible");
		retry?.();
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.subscribe).toHaveBeenCalledTimes(1);
	});

	// Catches: a late old-generation exit clears the new stream and schedules a duplicate connection.
	it("ignores obsolete exit and reconnect callbacks after manual replacement", async () => {
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		const oldExit = exit;
		const oldOptions = options;
		options.onReconnecting?.(1, 10);
		await vi.advanceTimersByTimeAsync(5_000);
		fireEvent.click(view.getByRole("button", { name: "Retry now" }));
		await vi.advanceTimersByTimeAsync(0);
		oldExit();
		oldOptions.onReconnecting?.(10, 10);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(stream.subscribe).toHaveBeenCalledTimes(2);
		expect(view.queryByText("--- session exited ---")).toBeNull();
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
		options.onLogLines?.([{ spans: [{ text: "replacement still live" }] }]);
		expect(view.getByText("replacement still live")).toBeTruthy();
	});

	// Catches: an exit before the subscription promise settles reinstalls the disposed handle.
	it("does not reinstall a subscription that exited before installation", async () => {
		const earlyStop = vi.fn();
		stream.subscribe.mockImplementationOnce(async (_id, _data, onExit) => {
			onExit();
			return Object.assign(earlyStop, { pause: vi.fn(), resume: vi.fn() });
		});
		render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		expect(earlyStop).toHaveBeenCalledTimes(1);
		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(3_000);
		setVisibility("visible");
		await vi.advanceTimersByTimeAsync(0);
		expect(stream.subscribe).toHaveBeenCalledTimes(2);
	});

	// Catches: repeated handshake failures spin immediately instead of keeping the bounded retry delay.
	it("backs off failed handshakes to thirty seconds and stops retrying while hidden", async () => {
		stream.subscribe.mockRejectedValue(new Error("connection refused"));
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByRole("region", { name: "Connection test" })).toBeTruthy();
		for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000, 30_000]) {
			const before = stream.subscribe.mock.calls.length;
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(stream.subscribe).toHaveBeenCalledTimes(before);
			await vi.advanceTimersByTimeAsync(1);
			expect(stream.subscribe).toHaveBeenCalledTimes(before + 1);
		}
		setVisibility("hidden");
		await vi.advanceTimersByTimeAsync(60_000);
		expect(stream.subscribe).toHaveBeenCalledTimes(7);
	});

	// Catches: a rejected handshake after session removal permanently claims the healthy server is unreachable.
	it("does not report a server outage when the session ends during its initial handshake", async () => {
		let rejectHandshake!: (reason: Error) => void;
		stream.subscribe.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectHandshake = reject;
				}),
		);
		const [exists, setExists] = createSignal(true);
		const view = render(() => <Harness sessionExists={exists()} />);
		await vi.advanceTimersByTimeAsync(0);
		setExists(false);
		rejectHandshake(new Error("WebSocket closed before opening (code 1006): session not found"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});

	// Catches: healthy session API hides a failed WebSocket, leaving an apparently frozen terminal forever.
	it("shows an outage after five seconds of reconnects and removes it when the stream returns", async () => {
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		options.onReconnecting?.(1, 10);
		await vi.advanceTimersByTimeAsync(3_000);
		options.onReconnecting?.(2, 10);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(view.getByRole("heading", { name: "Server unreachable" })).toBeTruthy();
		options.onReconnected?.();
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});
	// Catches: transport retry exhaustion is treated as session death and removes a still-needed outage landing.
	it("keeps the outage visible after socket retry exhaustion and reconnects", async () => {
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		options.onReconnecting?.(10, 10);
		await vi.advanceTimersByTimeAsync(5_000);
		exit();
		expect(view.getByRole("region", { name: "Connection test" })).toBeTruthy();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});
	// Catches: the first rejected handshake has no subscription to resume and manual Retry does nothing.
	it("retries an initial subscription failure from the connection landing", async () => {
		stream.subscribe.mockRejectedValueOnce(new Error("connection refused"));
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByRole("heading", { name: "Server unreachable" })).toBeTruthy();
		fireEvent.click(view.getByRole("button", { name: "Retry now" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});
	// Catches: an initial failed handshake stays failed after the server returns unless the user presses Retry.
	it("automatically recovers an initial subscription failure", async () => {
		stream.subscribe.mockRejectedValueOnce(new Error("connection refused"));
		const view = render(() => <Harness />);
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByRole("region", { name: "Connection test" })).toBeTruthy();
		await vi.advanceTimersByTimeAsync(3_000);
		expect(view.queryByRole("region", { name: "Connection test" })).toBeNull();
	});
});
