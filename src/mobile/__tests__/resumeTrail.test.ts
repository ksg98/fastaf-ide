// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installResumeDiagnostics } from "../resumeDiagnostics";
import { recordMobileSocketState } from "../resumeTrail";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../transport", () => ({ rpc }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn() } }));
let dispose: (() => void) | undefined;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function visibility(state: "hidden" | "visible") {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
	document.dispatchEvent(new Event("visibilitychange"));
}
beforeEach(() => {
	sessionStorage.clear();
	rpc.mockReset().mockResolvedValue(undefined);
	visibility("visible");
	document.body.innerHTML = '<div id="mobile-app"><div data-mobile-shell>Sessions</div></div>';
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => {
	dispose?.();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	document.documentElement.style.removeProperty("--app-height");
	document.documentElement.style.removeProperty("--app-top");
});
// Catches: a reclaimed document loses every phone-only lifecycle observation;
// the next document has no evidence to send, especially if RAF never ran.
it("uploads the previous lifecycle after a killed document reload", async () => {
	dispose = installResumeDiagnostics();
	visibility("hidden");
	document.dispatchEvent(new Event("freeze"));
	dispose(); // Process loss: no pagehide event or RAF callback.
	visibility("visible");
	dispose = installResumeDiagnostics();
	await flush();
	expect(rpc).toHaveBeenCalledTimes(1);
	expect(rpc).toHaveBeenCalledWith(
		"push_log",
		expect.objectContaining({
			level: "warn",
			source: "app",
			message: "Mobile previous document lifecycle trail",
		}),
	);
	const payload = JSON.parse(rpc.mock.calls[0][1].dataJson);
	expect(payload.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "visibilitychange", visibilityState: "hidden", rootChildCount: 1 }),
			expect.objectContaining({ type: "freeze", visibilityState: "hidden" }),
		]),
	);
	window.dispatchEvent(new Event("online"));
	await flush();
	expect(rpc).toHaveBeenCalledTimes(1);
});

// Catches: ordinary navigation generates a false crash report on the next boot.
it("does not upload a document that ended with a visible clean pagehide", async () => {
	dispose = installResumeDiagnostics();
	window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
	dispose();
	dispose = installResumeDiagnostics();
	await flush();
	expect(rpc).not.toHaveBeenCalled();
});

// Catches: iOS eviction after hiding is misclassified as safe because pagehide fired.
it("uploads a hidden prior document even when pagehide was clean", async () => {
	dispose = installResumeDiagnostics();
	visibility("hidden");
	window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
	dispose();
	visibility("visible");
	dispose = installResumeDiagnostics();
	await flush();
	const payload = JSON.parse(rpc.mock.calls[0][1].dataJson);
	expect(payload.events.at(-1)).toMatchObject({ type: "pagehide", persisted: true, visibilityState: "hidden" });
});

// Catches: transient network failure destroys the only surviving phone evidence.
it("retains a failed upload across boot and retries once after online", async () => {
	dispose = installResumeDiagnostics();
	visibility("hidden");
	dispose();
	rpc.mockRejectedValue(new Error("offline"));
	dispose = installResumeDiagnostics();
	await flush();
	const pending = rpc.mock.calls[0][1].dataJson;
	dispose();
	dispose = installResumeDiagnostics();
	await flush();
	expect(rpc.mock.calls[1][1].dataJson).toBe(pending);
	rpc.mockResolvedValue(undefined);
	window.dispatchEvent(new Event("online"));
	await flush();
	expect(rpc.mock.calls[2][1].dataJson).toBe(pending);
	window.dispatchEvent(new Event("online"));
	document.dispatchEvent(new Event("resume"));
	await flush();
	expect(rpc).toHaveBeenCalledTimes(3);
	expect(JSON.parse(sessionStorage.getItem("tuic-mobile-resume-trail")!).pending).toBeUndefined();
});

// Catches: repeated resume events send concurrent copies of one pending report.
it("keeps only one upload in flight until its acknowledgement", async () => {
	dispose = installResumeDiagnostics();
	dispose();
	let acknowledge!: () => void;
	rpc.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				acknowledge = resolve;
			}),
	);
	dispose = installResumeDiagnostics();
	window.dispatchEvent(new Event("online"));
	document.dispatchEvent(new Event("resume"));
	expect(rpc).toHaveBeenCalledTimes(1);
	acknowledge();
	await flush();
	window.dispatchEvent(new Event("online"));
	expect(rpc).toHaveBeenCalledTimes(1);
});

// Catches: unbounded telemetry exhausts storage or omits the viewport/socket state
// needed to distinguish a lost document from an off-screen shell.
it("bounds synchronous evidence to the latest 30 events with geometry and socket phase", async () => {
	const shell = document.querySelector<HTMLElement>("[data-mobile-shell]")!;
	vi.spyOn(shell, "getBoundingClientRect").mockReturnValue({ top: 12, left: 0, width: 390, height: 844 } as DOMRect);
	vi.stubGlobal("visualViewport", { width: 390, height: 500, offsetTop: 12, offsetLeft: 0 });
	document.documentElement.style.setProperty("--app-height", "500px");
	document.documentElement.style.setProperty("--app-top", "12px");
	dispose = installResumeDiagnostics();
	for (let n = 0; n < 40; n++) document.dispatchEvent(new Event("resume"));
	recordMobileSocketState("session-1", "reconnecting");
	visibility("hidden");
	dispose();
	dispose = installResumeDiagnostics();
	await flush();
	const payload = JSON.parse(rpc.mock.calls[0][1].dataJson);
	expect(payload.events).toHaveLength(30);
	expect(payload.events.at(-1)).toMatchObject({
		type: "visibilitychange",
		rootChildCount: 1,
		shellRect: { top: 12, left: 0, width: 390, height: 844 },
		visualViewport: { width: 390, height: 500, offsetTop: 12, offsetLeft: 0 },
		appHeight: "500px",
		appTop: "12px",
		socket: { sessionId: "session-1", state: "reconnecting" },
	});
});

// Catches: corrupt or denied browser storage prevents MobileApp from mounting.
it.each(["corrupt", "denied"])("does not block boot when storage is %s", async (failure) => {
	if (failure === "corrupt") sessionStorage.setItem("tuic-mobile-resume-trail", "{bad json");
	else {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
	}
	expect(() => {
		dispose = installResumeDiagnostics();
		visibility("hidden");
	}).not.toThrow();
	await flush();
	expect(rpc).not.toHaveBeenCalled();
});

// Catches: an old document's late acknowledgement overwrites the new recorder.
it("ignores late acknowledgements and events after disposal", async () => {
	dispose = installResumeDiagnostics();
	dispose();
	let acknowledge!: () => void;
	rpc.mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				acknowledge = resolve;
			}),
	);
	dispose = installResumeDiagnostics();
	dispose();
	const saved = sessionStorage.getItem("tuic-mobile-resume-trail");
	visibility("hidden");
	recordMobileSocketState("old-session", "closed");
	acknowledge();
	await flush();
	expect(sessionStorage.getItem("tuic-mobile-resume-trail")).toBe(saved);
});
