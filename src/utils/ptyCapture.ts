import { createSignal } from "solid-js";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { toastsStore } from "../stores/toasts";

/**
 * Front-end control for the raw PTY capture tap (`src-tauri/src/pty_capture.rs`).
 *
 * State detection is decided from bytes an agent writes once and never repeats,
 * and the per-session output ring holds only the last 8 KB — so by the time a
 * wrong badge is worth reporting the evidence is already gone. Recording has to
 * start BEFORE the reproduction, which in practice means it has to be one click
 * away from the tab that is misbehaving, not a curl the reporter has to look up.
 */
type CaptureStatus = {
	enabled: boolean;
	session_filter?: string | null;
	dir?: string | null;
	sessions?: { session_id: string; bytes: number }[];
};

const [status, setStatus] = createSignal<CaptureStatus>({ enabled: false });

function bytesFor(state: CaptureStatus, sessionId: string): number {
	return state.sessions?.find((s) => s.session_id === sessionId)?.bytes ?? 0;
}

/**
 * Adopt an IPC answer only when it really is a status.
 *
 * `invoke` is typed, not validated: a transport that resolves with nothing —
 * an unmapped command, a stubbed bridge — would otherwise write `undefined`
 * into the signal, and every reader below dereferences `.enabled`. The tab
 * context menu refreshes in its own builder, so one empty answer took the
 * whole menu down on the next open.
 */
function adopt(next: unknown): void {
	if (next && typeof (next as CaptureStatus).enabled === "boolean") {
		setStatus(next as CaptureStatus);
		return;
	}
	appLogger.debug("app", "[Capture] ignoring malformed status payload", next);
}

export const ptyCaptureStore = {
	/** True when the tap is recording exactly this session. */
	isRecording(sessionId: string): boolean {
		const state = status();
		return state.enabled && state.session_filter === sessionId;
	},

	/** Bytes written so far for this session, as of the last refresh. */
	bytes(sessionId: string): number {
		return bytesFor(status(), sessionId);
	},

	async refresh(): Promise<void> {
		try {
			adopt(await invoke<CaptureStatus>("get_pty_capture"));
		} catch (err) {
			appLogger.debug("app", "[Capture] status read failed", err);
		}
	},

	/**
	 * Start recording this session, or stop if it is already the one recording.
	 *
	 * Starting always begins a fresh file — a capture that appended to a previous
	 * run's bytes would replay as one impossible stream — so the toast on stop
	 * reports the size of THIS recording, not a running total.
	 */
	async toggle(sessionId: string): Promise<void> {
		const wasRecording = this.isRecording(sessionId);
		const written = wasRecording ? this.bytes(sessionId) : 0;
		try {
			const next = await invoke<CaptureStatus>("set_pty_capture", {
				enabled: !wasRecording,
				sessionId: wasRecording ? null : sessionId,
			});
			adopt(next);
			if (wasRecording) {
				toastsStore.add(
					"Capture stopped",
					`${Math.round(written / 1024)} KB written to ${next?.dir ?? "the captures directory"}/${sessionId}.tcap`,
					"info",
				);
			} else {
				toastsStore.add("Capture started", "Reproduce the problem now, then stop the capture.", "info");
			}
		} catch (err) {
			appLogger.error("app", "[Capture] toggle failed", err);
			toastsStore.add("Capture failed", String(err), "error");
		}
	},
};
