import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	writeClipboard: vi.fn().mockResolvedValue(undefined),
	handleOpenUrl: vi.fn(),
}));

vi.mock("../../utils/clipboard", () => ({ writeClipboard: mocks.writeClipboard }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mocks.handleOpenUrl }));
vi.mock("../../invoke", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

import { ChatGptSignIn } from "../../components/SettingsPanel/tabs/ChatGptSignIn";
import { invoke } from "../../invoke";
import { type ChatGptStatus, chatgptAuthStore } from "../../stores/chatgptAuth";

const mockInvoke = invoke as ReturnType<typeof vi.fn>;

const signedOut: ChatGptStatus = { signed_in: false, email: null, plan: null, pending: null, error: null };

/** Route each chatgpt_* command to a canned status. */
function answer(byCommand: Record<string, ChatGptStatus>) {
	mockInvoke.mockImplementation(async (cmd: string) => byCommand[cmd] ?? signedOut);
}

describe("ChatGptSignIn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		chatgptAuthStore._reset();
	});

	afterEach(async () => {
		cleanup();
		// Let in-flight status reads land, then drop any poll they scheduled.
		await new Promise((resolve) => setTimeout(resolve, 0));
		chatgptAuthStore._reset();
	});

	it("offers a sign-in when signed out", async () => {
		answer({ chatgpt_auth_status: signedOut });
		const { findByTestId } = render(() => <ChatGptSignIn />);
		expect((await findByTestId("chatgpt-sign-in-btn")).textContent).toContain("Sign in with ChatGPT");
		expect(mockInvoke).toHaveBeenCalledWith("chatgpt_auth_status");
	});

	it("device sign-in shows the code, copies it and opens the page", async () => {
		const pending: ChatGptStatus = {
			...signedOut,
			pending: { mode: "device", url: "https://auth.openai.com/codex/device", code: "WXYZ-9876" },
		};
		answer({ chatgpt_auth_status: signedOut, chatgpt_start_login: pending });
		const { findByTestId } = render(() => <ChatGptSignIn />);
		fireEvent.click(await findByTestId("chatgpt-sign-in-btn"));

		expect((await findByTestId("chatgpt-code")).textContent).toBe("WXYZ-9876");
		await waitFor(() => expect(mocks.handleOpenUrl).toHaveBeenCalledWith("https://auth.openai.com/codex/device"));
		expect(mocks.writeClipboard).toHaveBeenCalledWith("WXYZ-9876");
	});

	it("browser sign-in opens the authorize page without a code", async () => {
		const pending: ChatGptStatus = {
			...signedOut,
			pending: { mode: "browser", url: "https://auth.openai.com/oauth/authorize?x=1", code: null },
		};
		answer({ chatgpt_auth_status: signedOut, chatgpt_start_login: pending });
		const { findByTestId, queryByTestId, findByText } = render(() => <ChatGptSignIn />);
		fireEvent.click(await findByTestId("chatgpt-sign-in-btn"));

		expect(await findByText(/Finish signing in in your browser/)).toBeTruthy();
		expect(queryByTestId("chatgpt-code")).toBeNull();
		await waitFor(() =>
			expect(mocks.handleOpenUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?x=1"),
		);
		expect(mocks.writeClipboard).not.toHaveBeenCalled();

		answer({ chatgpt_cancel_login: signedOut });
		fireEvent.click(await findByTestId("chatgpt-cancel-btn"));
		expect(await findByTestId("chatgpt-sign-in-btn")).toBeTruthy();
		expect(mockInvoke).toHaveBeenCalledWith("chatgpt_cancel_login");
	});

	it("shows who is signed in and signs out", async () => {
		answer({
			chatgpt_auth_status: { ...signedOut, signed_in: true, email: "me@example.com", plan: "team" },
			chatgpt_logout: signedOut,
		});
		const { findByTestId } = render(() => <ChatGptSignIn />);
		const account = await findByTestId("chatgpt-account");
		expect(account.textContent).toContain("me@example.com");
		expect(account.textContent).toContain("Team");

		fireEvent.click(await findByTestId("chatgpt-sign-out-btn"));
		expect(await findByTestId("chatgpt-sign-in-btn")).toBeTruthy();
		expect(mockInvoke).toHaveBeenCalledWith("chatgpt_logout");
	});

	it("shows why the last sign-in failed", async () => {
		answer({ chatgpt_auth_status: { ...signedOut, error: "Sign-in timed out after 15 minutes" } });
		const { findByTestId } = render(() => <ChatGptSignIn />);
		expect((await findByTestId("chatgpt-error")).textContent).toContain("timed out");
	});
});
