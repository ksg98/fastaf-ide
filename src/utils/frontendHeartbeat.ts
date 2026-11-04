import { invoke } from "../invoke";
import { isTauri } from "../transport";

/** Mirrors `HEARTBEAT_PERIOD` in `src-tauri/src/frontend_liveness.rs`. The
 *  backend calls the frontend frozen after six missed beats. */
const HEARTBEAT_PERIOD_MS = 5000;

let running = false;

/** Tell the backend, from the main thread, that the main thread is still running.
 *
 *  Deliberately NOT gated on `isPerfDebug()`: unlike every other diagnostic, the
 *  thing this detects is the app being unusable, and it must be reported in the
 *  builds Boss actually runs. One `invoke` every 5s is far below the noise floor.
 *
 *  Desktop only. This watches the embedded WebView; a browser tab that stops
 *  beating has simply been closed, and a second client would mask a dead first
 *  one. The backend never learns about browser clients here.
 *
 *  Errors are swallowed on purpose. A failed beat is indistinguishable to us
 *  from a backend that is shutting down, and the backend already treats absence
 *  as the signal — logging here would turn a quiet shutdown into a burst. */
export function startFrontendHeartbeat() {
	if (running) return;
	if (!isTauri()) return;
	running = true;
	setInterval(() => {
		invoke("frontend_heartbeat").catch(() => {});
	}, HEARTBEAT_PERIOD_MS);
}
