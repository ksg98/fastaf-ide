import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";

vi.mock("../../stores/appLogger", () => ({ appLogger: { info: vi.fn() } }));

type Module = typeof import("../../utils/screenWakeLock");
let mod: Module;

function sentinel() {
	return { release: vi.fn(async () => {}) };
}

function setVisibility(state: "visible" | "hidden") {
	Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
	document.dispatchEvent(new Event("visibilitychange"));
}

let request: ReturnType<typeof vi.fn>;
const holds: (() => void)[] = [];
/** Every hold is released after its test, so no visibilitychange listener leaks into the next one. */
const hold = () => {
	const release = mod.holdScreenAwake();
	holds.push(release);
	return release;
};

beforeEach(async () => {
	// The unavailable log is once per page load: a fresh module per test.
	vi.resetModules();
	mod = await import("../../utils/screenWakeLock");
	localStorage.clear();
	request = vi.fn(async () => sentinel());
	Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
	Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
	for (const release of holds.splice(0)) release();
	Reflect.deleteProperty(navigator, "wakeLock");
	vi.clearAllMocks();
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("holdScreenAwake", () => {
	// Catches: capture starts but the phone still auto-locks because no lock was requested.
	it("requests a screen lock when capture starts", async () => {
		hold();
		await flush();
		expect(request).toHaveBeenCalledExactlyOnceWith("screen");
	});

	// Catches: the lock outlives capture and drains the battery with the screen on.
	it("releases the lock when capture stops, and a second release is harmless", async () => {
		const lock = sentinel();
		request.mockResolvedValueOnce(lock);
		const release = hold();
		await flush();
		release();
		release();
		expect(lock.release).toHaveBeenCalledOnce();
	});

	// Catches: stopping while the request is in flight leaves the lock taken forever.
	it("releases a lock granted after capture already stopped", async () => {
		const lock = sentinel();
		let grant: (value: ReturnType<typeof sentinel>) => void = () => {};
		request.mockReturnValueOnce(new Promise((resolve) => (grant = resolve)));
		const release = hold();
		release();
		grant(lock);
		await flush();
		expect(lock.release).toHaveBeenCalledOnce();
	});

	// Catches: the browser drops the lock on a hidden page and it is never taken again on return.
	it("releases on hide and requests again on return while capture still runs", async () => {
		const first = sentinel();
		const second = sentinel();
		request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const release = hold();
		await flush();
		setVisibility("hidden");
		expect(first.release).toHaveBeenCalledOnce();
		setVisibility("visible");
		await flush();
		expect(request).toHaveBeenCalledTimes(2);
		release();
		expect(second.release).toHaveBeenCalledOnce();
	});

	// Catches: a finished capture re-takes the lock when the user returns to the page.
	it("does not request again on return after capture stopped", async () => {
		const release = hold();
		await flush();
		release();
		setVisibility("hidden");
		setVisibility("visible");
		await flush();
		expect(request).toHaveBeenCalledOnce();
	});

	// Catches: the setting is ignored and the screen stays on for a user who turned it off.
	it("requests nothing when the setting is off", async () => {
		localStorage.setItem(mod.KEEP_AWAKE_KEY, "false");
		hold()();
		await flush();
		expect(request).not.toHaveBeenCalled();
	});

	// Catches: an unset setting reads as off, so the feature never works for anyone who did not open Settings.
	it("is on by default", async () => {
		hold();
		await flush();
		expect(request).toHaveBeenCalledOnce();
	});

	// Catches: a browser without the API throws into the capture start and dictation breaks.
	it("keeps working and logs once when the API is missing", () => {
		Reflect.deleteProperty(navigator, "wakeLock");
		expect(() => hold()()).not.toThrow();
		hold()();
		expect(appLogger.info).toHaveBeenCalledOnce();
	});

	// Catches: a refused request (battery saver, not allowed) becomes an unhandled rejection or a repeated log.
	it("keeps working and logs once when the request is refused", async () => {
		request.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
		hold()();
		hold()();
		await flush();
		expect(appLogger.info).toHaveBeenCalledOnce();
	});
});
