import { settingsStore } from "../stores/settings";

/** localStorage key written just before an update relaunch. */
const UPDATE_RESTART_KEY = "tuic.updateRestartAt";

/** Read and remove the marker, so only the boot right after the relaunch sees it. */
function consumeMarker(): boolean {
	try {
		const raw = localStorage.getItem(UPDATE_RESTART_KEY);
		if (raw === null) return false;
		localStorage.removeItem(UPDATE_RESTART_KEY);
		return true;
	} catch {
		return false;
	}
}

let armed = consumeMarker();

/** Record that the next start follows an update. */
export function markUpdateRestart(): void {
	try {
		localStorage.setItem(UPDATE_RESTART_KEY, String(Date.now()));
	} catch {
		// Storage unavailable: the restart is treated as an ordinary one.
	}
}

/** Withdraw the marker after a relaunch that failed. */
export function clearUpdateRestartMark(): void {
	try {
		localStorage.removeItem(UPDATE_RESTART_KEY);
	} catch {
		// Nothing was written.
	}
}

/** True for the whole boot that follows an update, while the user setting allows it. */
export function isEagerResumeArmed(): boolean {
	return armed && settingsStore.state.eagerResumeAfterUpdate;
}

/** End the post-update window once every saved agent tab has been handled. */
export function disarmEagerResume(): void {
	armed = false;
}
