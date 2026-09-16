import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import { appLogger } from "./appLogger";

// ---------------------------------------------------------------------------
// Types (mirror Rust `chatgpt::auth` — snake_case)
// ---------------------------------------------------------------------------

/** A sign-in in flight: the page to finish it on and, in device mode, the code to type. */
export interface ChatGptLoginPrompt {
	mode: "browser" | "device";
	url: string;
	code: string | null;
}

export interface ChatGptStatus {
	signed_in: boolean;
	email: string | null;
	plan: string | null;
	pending: ChatGptLoginPrompt | null;
	/** Why the last sign-in failed, until the next attempt. */
	error: string | null;
}

const SIGNED_OUT: ChatGptStatus = { signed_in: false, email: null, plan: null, pending: null, error: null };

/** How often the status is re-read while a sign-in is in flight. */
export const CHATGPT_POLL_MS = 2000;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function createChatGptAuthStore() {
	const [state, setState] = createStore<{ status: ChatGptStatus; loaded: boolean; busy: boolean }>({
		status: { ...SIGNED_OUT },
		loaded: false,
		busy: false,
	});

	let pollTimer: ReturnType<typeof setTimeout> | null = null;

	function stopPolling(): void {
		if (pollTimer) clearTimeout(pollTimer);
		pollTimer = null;
	}

	/** Take a status from the backend; keep polling only while a sign-in is pending. */
	function adopt(status: ChatGptStatus): void {
		setState({ status, loaded: true });
		stopPolling();
		if (status.pending) pollTimer = setTimeout(() => void refresh(), CHATGPT_POLL_MS);
	}

	async function refresh(): Promise<void> {
		try {
			adopt(await invoke<ChatGptStatus>("chatgpt_auth_status"));
		} catch (e) {
			appLogger.warn("settings", `ChatGPT status check failed: ${String(e)}`);
		}
	}

	/** Start a sign-in; resolves with the prompt to open, or null when it could not start. */
	async function startLogin(): Promise<ChatGptLoginPrompt | null> {
		setState("busy", true);
		try {
			const status = await invoke<ChatGptStatus>("chatgpt_start_login");
			adopt(status);
			return status.pending;
		} catch (e) {
			appLogger.warn("settings", `ChatGPT sign-in failed to start: ${String(e)}`);
			setState("status", "error", String(e));
			return null;
		} finally {
			setState("busy", false);
		}
	}

	async function cancelLogin(): Promise<void> {
		try {
			adopt(await invoke<ChatGptStatus>("chatgpt_cancel_login"));
		} catch (e) {
			appLogger.warn("settings", `ChatGPT sign-in cancel failed: ${String(e)}`);
		}
	}

	async function logout(): Promise<void> {
		setState("busy", true);
		try {
			adopt(await invoke<ChatGptStatus>("chatgpt_logout"));
		} catch (e) {
			appLogger.warn("settings", `ChatGPT sign-out failed: ${String(e)}`);
			setState("status", "error", String(e));
		} finally {
			setState("busy", false);
		}
	}

	function _reset(): void {
		stopPolling();
		setState({ status: { ...SIGNED_OUT }, loaded: false, busy: false });
	}

	return { state, refresh, startLogin, cancelLogin, logout, stopPolling, _reset };
}

export const chatgptAuthStore = createChatGptAuthStore();
