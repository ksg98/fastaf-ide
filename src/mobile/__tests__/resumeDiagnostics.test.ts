// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installResumeDiagnostics } from "../resumeDiagnostics";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn } }));
let dispose: () => void;
let nextFrame: FrameRequestCallback | undefined;
let shell: HTMLElement;
function visible(state: "hidden" | "visible") {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
	document.dispatchEvent(new Event("visibilitychange"));
}
function paint() {
	const callback = nextFrame;
	nextFrame = undefined;
	callback?.(0);
}
function resume() {
	visible("hidden");
	visible("visible");
	paint();
}
function rect(top = 0, height = 800) {
	vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({
		top,
		left: 0,
		bottom: top + height,
		right: 360,
		width: 360,
		height,
		x: 0,
		y: top,
		toJSON: () => ({}),
	});
}

beforeEach(() => {
	sessionStorage.clear();
	warn.mockReset();
	visible("visible");
	document.body.innerHTML = '<div id="mobile-app"><div data-mobile-shell>Sessions</div></div>';
	shell = document.querySelector("[data-mobile-shell]")!;
	rect();
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			nextFrame = callback;
			return 1;
		}),
	);
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn(() => {
			nextFrame = undefined;
		}),
	);
	dispose = installResumeDiagnostics();
});
afterEach(() => {
	dispose();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("mobile resume diagnostics", () => {
	it("reports an empty root after the resume frame instead of silently losing the shell", () => {
		visible("hidden");
		document.getElementById("mobile-app")!.replaceChildren();
		window.dispatchEvent(
			new ErrorEvent("error", { message: "Resume render failed", filename: "mobile.js", lineno: 9, colno: 3 }),
		);
		visible("visible");
		expect(warn).not.toHaveBeenCalled();
		paint();
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"app",
			"Mobile resume has an empty or off-screen shell",
			expect.objectContaining({
				href: location.href,
				rootChildCount: 0,
				shellRect: null,
				visibilityState: "visible",
				lastError: expect.objectContaining({ message: "Resume render failed", lineno: 9 }),
			}),
		);
	});
	it("stays silent for a visible shell through both resume events", () => {
		resume();
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		paint();
		expect(warn).not.toHaveBeenCalled();
	});
	it("reports a shell outside the viewport on a persisted pageshow", () => {
		window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
		rect(900);
		window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
		paint();
		expect(warn).toHaveBeenCalledWith(
			"app",
			expect.any(String),
			expect.objectContaining({ rootChildCount: 1, shellRect: expect.objectContaining({ top: 900 }), lastError: null }),
		);
	});
	it("does not confuse a partially visible shell with an off-screen one", () => {
		rect(-100);
		resume();
		expect(warn).not.toHaveBeenCalled();
	});
	it("clears the previous hide cycle error and cancels inspection when hidden again", () => {
		visible("hidden");
		window.dispatchEvent(new ErrorEvent("error", { message: "Old error" }));
		visible("visible");
		visible("hidden");
		paint();
		expect(warn).not.toHaveBeenCalled();
		document.getElementById("mobile-app")!.replaceChildren();
		visible("visible");
		paint();
		expect(warn).toHaveBeenCalledWith("app", expect.any(String), expect.objectContaining({ lastError: null }));
	});
	it("removes lifecycle listeners when disposed", () => {
		dispose();
		document.getElementById("mobile-app")!.replaceChildren();
		resume();
		expect(warn).not.toHaveBeenCalled();
	});
});
