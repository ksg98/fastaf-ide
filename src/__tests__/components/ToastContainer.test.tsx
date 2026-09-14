import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastContainer } from "../../components/ToastContainer/ToastContainer";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { toastsStore } from "../../stores/toasts";

/**
 * An agent's `ui action=toast` names the repo it came from, but a repo holds
 * many tabs. The toast carries the originating TUIC session id so a click can
 * land on the exact terminal that raised it instead of leaving the user to hunt
 * for it across every open session.
 */
describe("ToastContainer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
		vi.restoreAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	function addTerminal(sessionId: string): string {
		return terminalsStore.add({
			sessionId,
			fontSize: 12,
			name: sessionId,
			nameIsCustom: false,
			cwd: null,
			awaitingInput: null,
			agentType: null,
			ptyDescription: null,
		});
	}

	it("focuses the terminal that produced the toast", () => {
		const other = addTerminal("session-other");
		const origin = addTerminal("session-origin");
		terminalsStore.setActive(other);

		toastsStore.add("done", "tuicommander · built", "info", false, undefined, undefined, undefined, "session-origin");
		render(() => <ToastContainer />);
		fireEvent.click(screen.getByText("done"));

		expect(terminalsStore.state.activeId).toBe(origin);
		expect(toastsStore.toasts).toHaveLength(0);
	});

	it("takes the repo and the tab strip along when the speaker is in another repo", () => {
		repositoriesStore.add({ path: "/here", displayName: "Here" });
		repositoriesStore.setBranch("/here", "main", { worktreePath: "/here" });
		repositoriesStore.add({ path: "/there", displayName: "There" });
		repositoriesStore.setBranch("/there", "feature", { worktreePath: "/there" });
		const here = addTerminal("session-here");
		const there = addTerminal("session-there");
		repositoriesStore.addTerminalToBranch("/here", "main", here);
		repositoriesStore.addTerminalToBranch("/there", "feature", there);
		repositoriesStore.setActive("/here");
		terminalsStore.setActive(here);

		toastsStore.add("built", "ok", "info", false, undefined, undefined, "/there", "session-there");
		render(() => <ToastContainer />);
		fireEvent.click(screen.getByText("built"));

		// Focusing the terminal without its repo left the sidebar and the tab strip
		// on the old repo while the pane drew the new terminal — no tab for it.
		expect(terminalsStore.state.activeId).toBe(there);
		expect(repositoriesStore.state.activeRepoPath).toBe("/there");
		expect(repositoriesStore.get("/there")?.activeBranch).toBe("feature");
	});

	it("names the repo the toast came from", () => {
		repositoriesStore.add({ path: "/Gits/personal/ego", displayName: "Ego" });

		toastsStore.add("built", "ok", "info", false, undefined, undefined, "/Gits/personal/ego", undefined);
		render(() => <ToastContainer />);

		expect(screen.getByText("ego")).toBeTruthy();
	});

	it("falls back to the speaking terminal's repo when the origin resolved to none", () => {
		repositoriesStore.add({ path: "/Gits/personal/mdkb", displayName: "Mdkb" });
		repositoriesStore.setBranch("/Gits/personal/mdkb", "main", { worktreePath: "/Gits/personal/mdkb" });
		const speaker = addTerminal("session-speaker");
		repositoriesStore.addTerminalToBranch("/Gits/personal/mdkb", "main", speaker);

		toastsStore.add("built", "ok", "info", false, undefined, undefined, undefined, "session-speaker");
		render(() => <ToastContainer />);

		expect(screen.getByText("mdkb")).toBeTruthy();
	});

	it("only dismisses when the toast carries no session", () => {
		const only = addTerminal("session-only");
		terminalsStore.setActive(only);

		toastsStore.add("plain", "no origin", "info");
		render(() => <ToastContainer />);
		fireEvent.click(screen.getByText("plain"));

		expect(terminalsStore.state.activeId).toBe(only);
		expect(toastsStore.toasts).toHaveLength(0);
	});

	it("only dismisses when the originating session is already gone", () => {
		const survivor = addTerminal("session-survivor");
		terminalsStore.setActive(survivor);

		toastsStore.add("stale", "closed since", "warn", false, undefined, undefined, undefined, "session-closed");
		render(() => <ToastContainer />);
		fireEvent.click(screen.getByText("stale"));

		// No warning either: the toast resolves the session before asking the
		// store to focus it, so a closed tab is a silent no-op, not a log line.
		expect(terminalsStore.state.activeId).toBe(survivor);
		expect(toastsStore.toasts).toHaveLength(0);
	});
});
