import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fixture from "../../dev/fixtures/ego-intent-1948.json";
import wrappedFixture from "../../dev/fixtures/ego-intent-1949.json";
import { VisibleIntersectionObserver } from "../helpers/visibleIntersectionObserver";

const { transport } = vi.hoisted(() => ({
	transport: {
		sink: null as ((data: ArrayBuffer) => void) | null,
		invoke: vi.fn(),
	},
}));
vi.mock("../../components/Terminal/canvasTerminalTransport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/canvasTerminalTransport")>()),
	createTransport: () => ({
		onEvent: vi.fn().mockResolvedValue(undefined),
		onStreamError: vi.fn(),
		subscribe: async (sink: (data: ArrayBuffer) => void) => {
			transport.sink = sink;
		},
		resubscribe: vi.fn().mockResolvedValue(undefined),
		unsubscribe: vi.fn(),
		ackFrame: vi.fn(),
		invoke: transport.invoke,
	}),
}));

import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { appLogger } from "../../stores/appLogger";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

// Canvas output port: retain painted rectangles until the renderer clears them.
// The assertion observes the resulting overlay, not a call to a private painter.
function recordingContext() {
	const fills: { colour: unknown; y: number; h: number }[] = [];
	const text: string[] = [];
	const state: Record<string, unknown> = {
		fillStyle: "#000000",
		fillText: (glyph: string) => text.push(glyph),
		clearRect: () => {
			fills.length = 0;
		},
		fillRect: (_x: number, y: number, _w: number, h: number) => {
			fills.push({ colour: state.fillStyle, y, h });
		},
		measureText: () => ({ width: 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }),
	};
	const context = new Proxy(state, { get: (target, key: string) => target[key] ?? (() => {}) });
	return { context: context as unknown as CanvasRenderingContext2D, fills, text };
}

let canvases: Map<HTMLCanvasElement, ReturnType<typeof recordingContext>>;
beforeEach(() => {
	canvases = new Map();
	vi.spyOn(appLogger, "info").mockImplementation(() => {});
	transport.sink = null;
	transport.invoke.mockReset().mockResolvedValue(undefined);
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: async () => [], ready: Promise.resolve() },
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		width: 800,
		height: 400,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
		let entry = canvases.get(this);
		if (!entry) {
			entry = recordingContext();
			canvases.set(this, entry);
		}
		return entry.context;
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal("IntersectionObserver", VisibleIntersectionObserver);
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

// Catches: classified ego intent blocks are discarded by the overlay painter.
it("styles the recorded column-zero ego intent without hiding its text", async () => {
	const terminalId = terminalsStore.add(makeTerminal({ sessionId: "ego-intent-1948" }));
	const view = render(() => <CanvasTerminal sessionId="ego-intent-1948" terminalId={terminalId} />);
	try {
		await waitFor(() => expect(transport.sink).not.toBeNull());
		transport.sink?.(Uint8Array.from(atob(fixture.frameBase64), (c) => c.charCodeAt(0)).buffer);
		await waitFor(() => expect(view.container.querySelectorAll('[data-terminal-marker="intent"]')).toHaveLength(1));
		const strips = [...view.container.querySelectorAll<HTMLElement>('[data-terminal-marker="intent"]')];
		expect(strips.every((strip) => strip.style.background.includes("--warning"))).toBe(true);
		expect(strips[0].style.top).toBe("0px");
		expect(
			[...canvases.values()].some((output) => output.text.join("").replaceAll(" ", "").includes("intent:Recording")),
		).toBe(true);
	} finally {
		view.unmount();
		terminalsStore.remove(terminalId);
	}
});

// Catches: ego's soft-wrapped intent tail receives no tint or spills onto ordinary output.
it("tints both recorded ego intent rows and stops before ordinary output", async () => {
	const terminalId = terminalsStore.add(makeTerminal({ sessionId: "ego-intent-1949" }));
	const view = render(() => <CanvasTerminal sessionId="ego-intent-1949" terminalId={terminalId} />);
	try {
		await waitFor(() => expect(transport.sink).not.toBeNull());
		transport.sink?.(Uint8Array.from(atob(wrappedFixture.frameBase64), (c) => c.charCodeAt(0)).buffer);
		await waitFor(() => expect(view.container.querySelectorAll('[data-terminal-marker="intent"]')).toHaveLength(2));
		const strips = [...view.container.querySelectorAll<HTMLElement>('[data-terminal-marker="intent"]')];
		expect(strips.map((strip) => strip.style.top)).toEqual(["0px", strips[0].style.height]);
		expect(strips.every((strip) => strip.style.background.includes("--warning"))).toBe(true);
		expect(
			[...canvases.values()].some((output) =>
				output.text.join("").replaceAll(" ", "").includes("Ordinaryoutputstaysoutsidetheintenttint."),
			),
		).toBe(true);
	} finally {
		view.unmount();
		terminalsStore.remove(terminalId);
	}
});
