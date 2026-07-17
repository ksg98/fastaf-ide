import { appLogger } from "../stores/appLogger";
import { dictationStore } from "../stores/dictation";
import { terminalsStore } from "../stores/terminals";
import { getShellFamily, sendCommand } from "../utils/sendCommand";

/** Transcription result from the Rust backend */
interface TranscribeResponse {
	text: string;
	skip_reason: string | null;
	duration_s: number;
}

/** Dependencies injected into useDictation */
export interface DictationDeps {
	pty: {
		write: (sessionId: string, data: string) => Promise<void>;
	};
	dictation: {
		state: {
			enabled: boolean;
			recording: boolean;
			processing: boolean;
			loading: boolean;
			modelStatus: "not_downloaded" | "downloaded" | "ready";
		};
		refreshStatus: () => Promise<void>;
		startRecording: () => Promise<void>;
		stopRecording: () => Promise<TranscribeResponse | null>;
	};
	setStatusInfo: (msg: string) => void;
	openSettings: (tab?: string) => void;
}

/** Dictation: start/stop recording, transcription, and terminal injection */
export function useDictation(deps: DictationDeps) {
	// Track the in-flight start promise so stop can await it.
	// Without this, a fast key release can fire handleDictationStop before
	// startRecording resolves, causing it to see recording=false and bail.
	let startPromise: Promise<boolean> | null = null;

	// Capture the focused element at key-press time. During push-to-talk the
	// focus may shift (e.g. to the terminal) by the time the key is released,
	// so we snapshot it here to guarantee dictation targets the right element.
	let focusTarget: Element | null = null;

	const handleDictationStart = async () => {
		if (!deps.dictation.state.enabled) return;
		if (deps.dictation.state.recording || deps.dictation.state.processing || deps.dictation.state.loading) return;

		// Snapshot focus target before any async work
		focusTarget = document.activeElement;

		startPromise = (async () => {
			// Sync state from Rust before proceeding — the store may be stale
			// (e.g. Rust still processing previous transcription)
			await deps.dictation.refreshStatus();

			// Re-check guards after refresh — Rust state is now authoritative
			if (deps.dictation.state.recording || deps.dictation.state.processing) {
				deps.setStatusInfo("Dictation: previous session still active");
				return false;
			}

			if (deps.dictation.state.modelStatus === "not_downloaded") {
				deps.setStatusInfo("Dictation: model not downloaded — open Settings > Dictation");
				deps.openSettings("dictation");
				return false;
			}

			if (deps.dictation.state.modelStatus !== "ready") {
				deps.setStatusInfo("Dictation: loading model into memory (first use takes a moment)…");
			}

			try {
				await deps.dictation.startRecording();
				deps.setStatusInfo("Dictation: recording…");
				return true;
			} catch (err) {
				appLogger.error("dictation", "Dictation start failed", err);
				deps.setStatusInfo("Dictation: failed to start recording");
				return false;
			}
		})();

		await startPromise;
	};

	const handleDictationStop = async () => {
		// Wait for any in-flight start to finish before checking state
		if (startPromise) {
			const started = await startPromise;
			startPromise = null;
			if (!started) return;
		}

		if (!deps.dictation.state.recording) return;
		deps.setStatusInfo("Dictation: transcribing…");
		const response = await deps.dictation.stopRecording();

		if (!response) {
			focusTarget = null;
			deps.setStatusInfo("Dictation: transcription failed");
			return;
		}

		if (response.skip_reason) {
			focusTarget = null;
			deps.setStatusInfo(`Dictation: ${response.skip_reason}`);
			return;
		}

		const text = response.text.trim();
		if (!text) {
			focusTarget = null;
			deps.setStatusInfo("Dictation: no text recognized");
			return;
		}

		// Optional AI rewrite — any failure falls back to the raw transcript.
		// focusTarget stays snapshotted across this extra await.
		let finalText = text;
		if (dictationStore.state.rewriteEnabled) {
			deps.setStatusInfo("Dictation: rewriting with AI…");
			const rewritten = await dictationStore.rewriteText(text);
			if (rewritten?.trim()) {
				finalText = rewritten.trim();
			} else {
				deps.setStatusInfo("Dictation: AI rewrite failed — inserted raw transcript");
			}
		}

		// Use the focus target captured at key-press time
		const el = focusTarget;
		focusTarget = null;

		// Terminal components use hidden input/textarea elements for keyboard capture.
		// Writing directly to .value doesn't reach the PTY — route to the terminal
		// fallback below instead. Covers both xterm (.xterm) and CanvasTerminal
		// ([data-terminal-container]).
		const isTerminalInput =
			(el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) &&
			(el.closest(".xterm") || el.closest("[data-terminal-container]"));

		const autoSend = dictationStore.state.autoSend;

		if (!isTerminalInput && el && (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement)) {
			const start = el.selectionStart ?? el.value.length;
			const end = el.selectionEnd ?? start;
			const before = el.value.slice(0, start);
			const after = el.value.slice(end);
			el.value = before + finalText + after;
			el.selectionStart = el.selectionEnd = start + finalText.length;
			el.dispatchEvent(new Event("input", { bubbles: true }));
			deps.setStatusInfo("Ready");
			return;
		}
		if (el && el.getAttribute("contenteditable") === "true") {
			document.execCommand("insertText", false, finalText);
			deps.setStatusInfo("Ready");
			return;
		}

		const active = terminalsStore.getActive();
		const targetSessionId = active?.sessionId;
		if (active && targetSessionId) {
			try {
				const writeFn = (data: string) => deps.pty.write(targetSessionId, data);
				if (autoSend) {
					const shellFamily = await getShellFamily(targetSessionId);
					await sendCommand(writeFn, finalText, active.agentType, shellFamily);
				} else {
					await writeFn(finalText);
				}
				deps.setStatusInfo("Ready");
				requestAnimationFrame(() => active.ref?.focus());
			} catch (err) {
				appLogger.error("dictation", "Failed to write to terminal", err);
				deps.setStatusInfo("Dictation: failed to write to terminal");
			}
		} else {
			deps.setStatusInfo("Dictation: no active terminal");
		}
	};

	return {
		handleDictationStart,
		handleDictationStop,
	};
}
