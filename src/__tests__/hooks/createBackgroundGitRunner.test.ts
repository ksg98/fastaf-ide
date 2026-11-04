import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackgroundGitRunner } from "../../hooks/git/createBackgroundGitRunner";
import { activityStore } from "../../stores/activityStore";
import { toastsStore } from "../../stores/toasts";
import { mockInvoke } from "../mocks/tauri";

function clearToasts() {
	for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
}

describe("createBackgroundGitRunner", () => {
	const setStatusInfo = vi.fn();
	let run: (repoPath: string, op: string, args: string[]) => Promise<void>;

	beforeEach(() => {
		clearToasts();
		setStatusInfo.mockReset();
		const [runningGitOps, setRunningGitOps] = createSignal<Set<string>>(new Set());
		run = createBackgroundGitRunner({ setStatusInfo, runningGitOps, setRunningGitOps });
	});

	afterEach(() => {
		// Catches: background git notifications leave a debounced save after this file ends.
		activityStore.clearAll();
		clearToasts();
		mockInvoke.mockReset();
	});

	// 1867-c863 — catches: a failed sidebar Push/Pull shown only as scrolling status-bar text.
	it("shows a sticky error card when a sidebar git operation fails", async () => {
		mockInvoke.mockResolvedValue({ success: false, stdout: "", stderr: "fatal: remote rejected", exit_code: 1 });

		await run("/repo", "push", ["push"]);

		const card = toastsStore.toasts.find((toast) => toast.level === "error");
		expect(card?.message).toBe("git push failed: fatal: remote rejected");
		expect(setStatusInfo).toHaveBeenCalledWith("git push failed: fatal: remote rejected");
	});

	// 1867-c863 — catches: an IPC exception from Pull/Push left on the status bar only.
	it("shows a sticky error card when the git command cannot run at all", async () => {
		mockInvoke.mockRejectedValue(new Error("spawn failed"));

		await run("/repo", "pull", ["pull"]);

		const card = toastsStore.toasts.find((toast) => toast.level === "error");
		expect(card?.message).toContain("git pull error:");
		expect(card?.message).toContain("spawn failed");
	});

	// catches: the interactive-auth fallback surfaced as a failure card although the command is re-run in a terminal.
	it("raises no error card when the failure only needs a terminal", async () => {
		mockInvoke.mockResolvedValue({
			success: false,
			stdout: "",
			stderr: "fatal: could not read Username",
			exit_code: 128,
		});

		await run("/repo", "pull", ["pull"]);

		expect(toastsStore.toasts.some((toast) => toast.level === "error")).toBe(false);
	});

	// catches: the success path raising an error card.
	it("raises no error card when the git operation succeeds", async () => {
		mockInvoke.mockResolvedValue({ success: true, stdout: "", stderr: "Everything up-to-date", exit_code: 0 });

		await run("/repo", "push", ["push"]);

		expect(toastsStore.toasts.some((toast) => toast.level === "error")).toBe(false);
	});
});
