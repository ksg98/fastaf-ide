import { appLogger } from "../stores/appLogger";

/** localStorage key of the per-device "keep the screen awake while capturing" preference. Absent means on. */
export const KEEP_AWAKE_KEY = "tuic-mobile-keep-awake";

let unavailableLogged = false;

/** Log one unavailable lock per page load: a phone retries on every dictation and the cause never changes. */
function logUnavailable(reason: unknown): void {
	if (unavailableLogged) return;
	unavailableLogged = true;
	appLogger.info("dictation", "Screen wake lock unavailable; the screen may lock during capture", reason);
}

/**
 * Keep the screen awake for as long as audio capture runs, and return the release.
 *
 * The single owner of the lock: every capture path (browser hands-free, browser
 * push-to-talk) calls this on start and the returned function on stop or failure.
 * The browser drops the lock itself when the page is hidden, so it is released
 * here too and requested again when the page is visible and capture still runs.
 * Never throws: a browser without the API, or a refused request, leaves capture
 * working and logs once.
 */
export function holdScreenAwake(): () => void {
	if (localStorage.getItem(KEEP_AWAKE_KEY) === "false") return () => {};
	if (!navigator.wakeLock) {
		logUnavailable("navigator.wakeLock is missing");
		return () => {};
	}
	let held = true;
	let sentinel: WakeLockSentinel | null = null;
	let requesting = false;

	const drop = () => {
		const current = sentinel;
		sentinel = null;
		current?.release().catch(() => {});
	};
	const acquire = async () => {
		if (requesting || sentinel || document.visibilityState !== "visible") return;
		requesting = true;
		try {
			const lock = await navigator.wakeLock.request("screen");
			if (held) sentinel = lock;
			else lock.release().catch(() => {});
		} catch (err) {
			logUnavailable(err);
		} finally {
			requesting = false;
		}
	};
	const onVisibility = () => {
		if (document.visibilityState === "visible") void acquire();
		else drop();
	};

	document.addEventListener("visibilitychange", onVisibility);
	void acquire();
	return () => {
		if (!held) return;
		held = false;
		document.removeEventListener("visibilitychange", onVisibility);
		drop();
	};
}
