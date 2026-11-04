import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, hydrate } = vi.hoisted(() => ({
	mockInvoke: vi.fn().mockResolvedValue(undefined),
	hydrate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../invoke", () => ({ invoke: mockInvoke }));
vi.mock("../stores/settings", () => ({ settingsStore: { hydrate } }));
vi.mock("../stores/appLogger", () => ({ appLogger: { error: vi.fn() } }));

import { CloseDialog } from "../components/QuitDialog/CloseDialog";
import { closeDialogStore } from "../stores/closeDialog";

describe("closeDialog", () => {
	beforeEach(() => {
		mockInvoke.mockReset().mockResolvedValue(undefined);
		hydrate.mockClear();
		closeDialogStore.present({ kind: "ask", sessions: 2 });
	});

	// Catches: Ask omitting Background or dropping the remember choice at IPC.
	it("sends background and remember, then refreshes the persisted preference", async () => {
		render(() => <CloseDialog />);
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Background" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("resolve_close", { choice: "background", remember: true });
		expect(hydrate).toHaveBeenCalledOnce();
	});

	// Catches: a missing native tray still offering an unreachable Background choice.
	it("omits Background when the backend reports no tray", () => {
		closeDialogStore.present({ kind: "ask", sessions: 2, background_available: false });
		render(() => <CloseDialog />);
		expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
		expect(screen.getByRole("button", { name: "Quit" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
	});

	// Catches: explicit quit offering background and swallowing Cmd+Q.
	it("offers only quit and cancel for Rust quit confirmation", async () => {
		closeDialogStore.present({ kind: "confirm_quit", sessions: 2 });
		render(() => <CloseDialog />);
		expect(screen.queryByRole("button", { name: "Background" })).toBeNull();
		expect(screen.queryByRole("checkbox")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Quit" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mockInvoke).toHaveBeenCalledExactlyOnceWith("resolve_close", { choice: "quit", remember: false });
	});

	// Catches: Cancel persisting a remembered destructive policy.
	it("cancels without remembering even when the checkbox was checked", async () => {
		render(() => <CloseDialog />);
		fireEvent.click(screen.getByRole("checkbox"));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mockInvoke).toHaveBeenCalledWith("resolve_close", { choice: "cancel", remember: false });
		expect(hydrate).not.toHaveBeenCalled();
	});

	// Catches: an accidental Enter confirming Quit or leaking into the terminal.
	it("captures Enter as cancel before terminal input", async () => {
		render(() => <CloseDialog />);
		const terminalKey = vi.fn();
		document.addEventListener("keydown", terminalKey);
		try {
			fireEvent.keyDown(document, { key: "Enter" });
			await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
			expect(mockInvoke).toHaveBeenCalledWith("resolve_close", { choice: "cancel", remember: false });
			expect(terminalKey).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", terminalKey);
		}
	});

	// Catches: a failed config write dismissing the dialog and preventing retry.
	it("keeps a failed answer visible and permits retry", async () => {
		mockInvoke.mockRejectedValueOnce(new Error("Disk full"));
		render(() => <CloseDialog />);
		fireEvent.click(screen.getByRole("button", { name: "Background" }));
		await screen.findByRole("alert");
		expect(screen.getByRole("alert").textContent).toContain("Disk full");
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(mockInvoke).toHaveBeenCalledTimes(2);
	});

	// Catches: repeated clicks sending concurrent conflicting close choices.
	it("accepts only one answer while the backend resolves it", async () => {
		let finish!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		render(() => <CloseDialog />);
		fireEvent.click(screen.getByRole("button", { name: "Background" }));
		void closeDialogStore.answer("quit");
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledTimes(1));
		expect(mockInvoke).toHaveBeenCalledTimes(1);
		finish();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
	// Catches: completing an old Cancel erases the new confirmation from a rapid second Quit.
	it("keeps the newer quit prompt when an earlier cancel finishes", async () => {
		let completeCancel!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					completeCancel = resolve;
				}),
		);
		render(() => <CloseDialog />);
		const cancelling = closeDialogStore.answer("cancel");
		await waitFor(() =>
			expect(mockInvoke).toHaveBeenCalledWith("resolve_close", { choice: "cancel", remember: false }),
		);
		closeDialogStore.present({ kind: "confirm_quit", sessions: 2 });
		completeCancel();
		await cancelling;
		expect(screen.queryByRole("dialog")).not.toBeNull();
		expect(screen.getByRole("dialog").textContent).toContain("Quit FastAF?");
	});
	// Catches: an old failed answer attaching its error to a replacement prompt.
	it("keeps a newer prompt clean when an earlier answer fails", async () => {
		let fail!: (error: Error) => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((_resolve, reject) => {
					fail = reject;
				}),
		);
		render(() => <CloseDialog />);
		const cancelling = closeDialogStore.answer("cancel");
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledOnce());
		closeDialogStore.present({ kind: "confirm_quit", sessions: 3 });
		fail(new Error("Old answer failed"));
		await cancelling;
		expect(screen.getByRole("dialog").textContent).toContain("Quit FastAF?");
		expect(screen.queryByRole("alert")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	// Catches: treating two prompts with the same fields as the same request.
	it("preserves an identical replacement prompt after an old answer succeeds", async () => {
		let finish!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		render(() => <CloseDialog />);
		const cancelling = closeDialogStore.answer("cancel");
		await waitFor(() => expect(mockInvoke).toHaveBeenCalledOnce());
		closeDialogStore.present({ kind: "ask", sessions: 2 });
		finish();
		await cancelling;
		expect(screen.getByRole("dialog").textContent).toContain("Close FastAF?");
	});
});
