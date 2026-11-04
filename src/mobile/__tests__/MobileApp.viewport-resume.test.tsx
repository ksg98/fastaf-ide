// @vitest-environment jsdom
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MobileApp from "../MobileApp";

vi.mock("../../transport", () => ({
	isTauri: () => false,
	rpc: vi.fn(async (command: string) => (command === "load_config" ? {} : [])),
	subscribeEvents: vi.fn(async () => () => {}),
}));
vi.mock("../../invoke", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../../stores/ideas", () => ({ ideasStore: { hydrate: vi.fn() } }));
vi.mock("../mobileTheme", () => ({ loadMobileTheme: vi.fn(async () => "commander") }));
vi.mock("../useMobileNotifications", () => ({ useMobileNotifications: vi.fn() }));
vi.mock("../useVersionCheck", () => ({
	useVersionCheck: () => ({ updateAvailable: () => false, applyUpdate: vi.fn() }),
}));
vi.mock("../../components/McpConfirmHost/McpConfirmHost", () => ({ McpConfirmHost: () => <div /> }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let viewport: EventTarget & { width: number; height: number; offsetTop: number };
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

function flushFrame() {
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) callback(0);
}

function visibility(state: DocumentVisibilityState) {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
	document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
	history.replaceState(null, "", "/mobile");
	viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0 });
	vi.stubGlobal("visualViewport", viewport);
	frames = new Map();
	nextFrame = 0;
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	visibility("visible");
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	delete (document as unknown as Record<string, unknown>).visibilityState;
	document.documentElement.style.removeProperty("--app-height");
	document.documentElement.style.removeProperty("--app-top");
});

// Conditional inputs, not a claim that an iPhone emitted these viewport values.
// Catches: stale zero shell height or an off-screen top hides header and tabs after resume.
describe("MobileApp viewport resume", () => {
	it.each([
		["zero height", 0, 0],
		["off-screen top", 844, 844],
	] as const)("re-measures stale %s after persisted pageshow and visible", async (_label, height, offsetTop) => {
		const view = render(() => <MobileApp />);
		await waitFor(() => expect(view.getByText("No active sessions")).toBeTruthy());
		flushFrame();
		expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
		viewport.height = height;
		viewport.offsetTop = offsetTop;
		viewport.dispatchEvent(new Event("resize"));
		flushFrame();
		expect(document.documentElement.style.getPropertyValue("--app-height")).toBe(`${height}px`);
		expect(document.documentElement.style.getPropertyValue("--app-top")).toBe(`${offsetTop}px`);
		window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		visibility("hidden");
		viewport.height = 844;
		viewport.offsetTop = 0;
		// No resize or scroll accompanies the restored geometry.
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		visibility("visible");
		flushFrame();
		expect.soft(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
		expect.soft(document.documentElement.style.getPropertyValue("--app-top")).toBe("0px");
		expect(view.getByRole("button", { name: /^Sessions$/ })).toBeTruthy();
	});

	// Catches: a missing listener leaves geometry stale when only one wake signal fires.
	it.each(["pageshow", "visible", "resume"] as const)("re-measures on %s alone", async (event) => {
		const view = render(() => <MobileApp />);
		await waitFor(() => expect(view.getByText("No active sessions")).toBeTruthy());
		flushFrame();
		visibility("hidden");
		viewport.height = 500;
		viewport.offsetTop = 20;
		visibility("hidden");
		flushFrame();
		expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
		if (event === "pageshow") window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
		else if (event === "visible") visibility("visible");
		else document.dispatchEvent(new Event("resume"));
		flushFrame();
		expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("500px");
		expect(document.documentElement.style.getPropertyValue("--app-top")).toBe("20px");
	});

	// Catches: lifecycle listeners or an already scheduled frame write after unmount.
	it("removes wake listeners and cancels a pending measurement on unmount", async () => {
		const view = render(() => <MobileApp />);
		await waitFor(() => expect(view.getByText("No active sessions")).toBeTruthy());
		flushFrame();
		viewport.height = 500;
		viewport.dispatchEvent(new Event("scroll"));
		view.unmount();
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		visibility("visible");
		document.dispatchEvent(new Event("resume"));
		viewport.dispatchEvent(new Event("resize"));
		flushFrame();
		expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
	});
});
