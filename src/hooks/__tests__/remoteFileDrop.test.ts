import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn(), confirm: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: mocks.invoke }));
vi.mock("../../transport", () => ({ isTauri: () => false, rpc: vi.fn() }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: mocks.toast } }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../../stores/repositories", () => ({ repositoriesStore: { state: { activeRepoPath: "/local" } } }));

import { confirmFolderDrop, dispatchTauriDrop, setFolderDropConfirmHandler } from "../useFileDrop";

describe("remote OS file drop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		const panel = document.createElement("div");
		panel.dataset.dropConnectionId = "mint";
		const folder = document.createElement("div");
		folder.dataset.dropTarget = "folder";
		folder.dataset.absPath = "/home/stefano/repo/.";
		panel.append(folder);
		Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => folder) });
		setFolderDropConfirmHandler(mocks.confirm);
	});

	// Catches: resolving the remote destination on the Mac or moving the source.
	it("copies a remote folder drop through its owner's backend coordinator", async () => {
		mocks.invoke.mockResolvedValue({ moved: 1, skipped: 0, errors: [], needs_confirm: false });
		await dispatchTauriDrop(["/Users/me/file.txt"], 1, 2);
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("fs_transfer_remote_paths", {
			connectionId: "mint",
			destDir: "/home/stefano/repo/.",
			paths: ["/Users/me/file.txt"],
			allowRecursive: false,
		});
		expect(mocks.toast).toHaveBeenCalledWith("Copied", "Copied 1", "info");
	});

	// Catches: confirmation losing ownership and retrying the transfer locally.
	it("retains the remote owner across directory recursion confirmation", async () => {
		mocks.invoke.mockResolvedValueOnce({ moved: 0, skipped: 0, errors: [], needs_confirm: true });
		mocks.invoke.mockResolvedValueOnce({ moved: 1, skipped: 0, errors: [], needs_confirm: false });
		await dispatchTauriDrop(["/Users/me/folder"], 1, 2);
		const req = mocks.confirm.mock.calls[0][0];
		expect(req.mode).toBe("copy");
		await confirmFolderDrop(req);
		expect(mocks.invoke).toHaveBeenLastCalledWith("fs_transfer_remote_paths", {
			connectionId: "mint",
			destDir: "/home/stefano/repo/.",
			paths: ["/Users/me/folder"],
			allowRecursive: true,
		});
	});

	// Catches: hiding remote failures or falling back to a local transfer.
	it("surfaces backend failures without retrying through the local transfer", async () => {
		mocks.invoke.mockRejectedValue(new Error("upload rejected"));
		await dispatchTauriDrop(["/Users/me/file.txt"], 1, 2);
		expect(mocks.toast).toHaveBeenCalledWith("Transfer failed", expect.stringContaining("upload rejected"), "error");
		expect(mocks.invoke).toHaveBeenCalledTimes(1);
	});

	// Catches: a partial-transfer error hiding the failing remote host/path in the UI.
	it("includes remote per-source failure details in the transfer toast", async () => {
		mocks.invoke.mockResolvedValue({
			moved: 0,
			skipped: 0,
			errors: ["Remote mint /home/stefano/repo/.: upload rejected"],
			needs_confirm: false,
		});
		await dispatchTauriDrop(["/Users/me/file.txt"], 1, 2);
		expect(mocks.toast).toHaveBeenCalledWith(
			"Copied",
			expect.stringContaining("Remote mint /home/stefano/repo/."),
			"warn",
		);
	});

	// Catches: a remote fix changing ordinary local move semantics.
	it("keeps local folder drops on the existing transfer command", async () => {
		const folder = document.createElement("div");
		folder.dataset.dropTarget = "folder";
		folder.dataset.absPath = "/local/folder";
		Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => folder) });
		mocks.invoke.mockResolvedValue({ moved: 1, skipped: 0, errors: [], needs_confirm: false });
		await dispatchTauriDrop(["/Users/me/file.txt"], 1, 2);
		expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("fs_transfer_paths", {
			destDir: "/local/folder",
			paths: ["/Users/me/file.txt"],
			mode: "move",
			allowRecursive: false,
		});
	});
});
