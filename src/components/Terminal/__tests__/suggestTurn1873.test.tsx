import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ onParsed: undefined as undefined | ((frame: Record<string, unknown>) => void) }));
vi.mock("../../../transport", () => ({
	isTauri: () => false,
	HttpRpcError: class extends Error {},
	rpc: vi.fn().mockResolvedValue(null),
	subscribePty: vi.fn(
		async (
			_sid: string,
			_data: unknown,
			_exit: unknown,
			options: { onParsed?: (frame: Record<string, unknown>) => void },
		) => {
			bridge.onParsed = options.onParsed;
			return () => {};
		},
	),
}));
// Browser-mode `listen()` (invoke.ts) reaches the shared SSE stream directly, not through the
// transport index mocked above. Left real, every store that listens for a backend event joins
// one stream, and the next event type widens its filter with a POST to a backend this test
// does not have: the unmocked-fetch guard then throws on the stream's timer, outside any test,
// and the run exits 1 with every test green. Nothing here reads backend events (the recorded
// frames arrive through subscribePty), so the stream is inert and nothing outlives the case.
vi.mock("../../../transport/sse", () => ({
	subscribeSse: () => () => {},
	emitSseLocalEvent: () => {},
}));
vi.mock("../CanvasTerminal", () => ({ default: () => null }));

import { terminalsStore } from "../../../stores/terminals";
import { TerminalArea } from "../../TerminalArea";
import capture from "./fixtures/codex-choice-events-1873.json";

let terminalId: string;
afterEach(() => {
	cleanup();
	if (terminalId) terminalsStore.remove(terminalId);
	vi.restoreAllMocks();
});
it("shows recorded next-turn choices when the submitted-input event follows busy", async () => {
	// Catches: a submitted prompt dismissing its own next-turn suggestions.
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	const id = terminalsStore.add({
		sessionId: "recorded1873",
		name: "Codex",
		fontSize: 14,
		cwd: null,
		awaitingInput: null,
	});
	terminalId = id;
	terminalsStore.setActive(id);
	render(() => (
		<TerminalArea onTerminalFocus={() => {}} onCloseTab={() => {}} onOpenFilePath={() => {}} onContextMenu={() => {}} />
	));
	await waitFor(() => expect(bridge.onParsed).toBeTypeOf("function"));
	for (const frame of capture.events) bridge.onParsed!(frame);
	for (const text of ["Inspect mapping", "Verify chips", "Finish capture"]) {
		expect(screen.getByRole("button", { name: new RegExp(text) })).toBeVisible();
	}
});
