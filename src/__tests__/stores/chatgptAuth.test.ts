import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

import { invoke } from "../../invoke";
import { CHATGPT_POLL_MS, type ChatGptStatus, chatgptAuthStore } from "../../stores/chatgptAuth";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const signedOut: ChatGptStatus = { signed_in: false, email: null, plan: null, pending: null, error: null };
const pendingDevice: ChatGptStatus = {
	...signedOut,
	pending: { mode: "device", url: "https://auth.openai.com/codex/device", code: "ABCD-1234" },
};
const signedIn: ChatGptStatus = { ...signedOut, signed_in: true, email: "me@example.com", plan: "pro" };

describe("chatgptAuthStore", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockInvoke.mockReset();
		chatgptAuthStore._reset();
	});

	afterEach(() => {
		chatgptAuthStore._reset();
		vi.useRealTimers();
	});

	it("refresh adopts the backend status", async () => {
		mockInvoke.mockResolvedValueOnce(signedIn);
		await chatgptAuthStore.refresh();
		expect(mockInvoke).toHaveBeenCalledWith("chatgpt_auth_status");
		expect(chatgptAuthStore.state.status.email).toBe("me@example.com");
		expect(chatgptAuthStore.state.loaded).toBe(true);
	});

	it("startLogin returns the prompt and polls until the sign-in settles", async () => {
		mockInvoke.mockResolvedValueOnce(pendingDevice);
		const prompt = await chatgptAuthStore.startLogin();
		expect(mockInvoke).toHaveBeenCalledWith("chatgpt_start_login");
		expect(prompt?.code).toBe("ABCD-1234");
		expect(chatgptAuthStore.state.busy).toBe(false);

		// Still pending on the first poll, signed in on the second.
		mockInvoke.mockResolvedValueOnce(pendingDevice).mockResolvedValueOnce(signedIn);
		await vi.advanceTimersByTimeAsync(CHATGPT_POLL_MS);
		expect(chatgptAuthStore.state.status.pending).not.toBeNull();
		await vi.advanceTimersByTimeAsync(CHATGPT_POLL_MS);
		expect(chatgptAuthStore.state.status.signed_in).toBe(true);
		expect(chatgptAuthStore.state.status.pending).toBeNull();

		// Settled: no more polling.
		const calls = mockInvoke.mock.calls.length;
		await vi.advanceTimersByTimeAsync(CHATGPT_POLL_MS * 3);
		expect(mockInvoke.mock.calls.length).toBe(calls);
	});

	it("startLogin surfaces a failure to start as the row's error", async () => {
		mockInvoke.mockRejectedValueOnce("OpenAI would not start a device sign-in (HTTP 503)");
		const prompt = await chatgptAuthStore.startLogin();
		expect(prompt).toBeNull();
		expect(chatgptAuthStore.state.status.error).toContain("HTTP 503");
		expect(chatgptAuthStore.state.busy).toBe(false);
	});

	it("cancelLogin and logout adopt what the backend answers", async () => {
		mockInvoke.mockResolvedValueOnce(pendingDevice);
		await chatgptAuthStore.startLogin();

		mockInvoke.mockResolvedValueOnce(signedOut);
		await chatgptAuthStore.cancelLogin();
		expect(mockInvoke).toHaveBeenLastCalledWith("chatgpt_cancel_login");
		expect(chatgptAuthStore.state.status.pending).toBeNull();

		mockInvoke.mockResolvedValueOnce(signedIn);
		await chatgptAuthStore.refresh();
		mockInvoke.mockResolvedValueOnce(signedOut);
		await chatgptAuthStore.logout();
		expect(mockInvoke).toHaveBeenLastCalledWith("chatgpt_logout");
		expect(chatgptAuthStore.state.status.signed_in).toBe(false);
	});
});
