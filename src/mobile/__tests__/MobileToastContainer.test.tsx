import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import { MobileToastContainer } from "../components/MobileToastContainer";

describe("MobileToastContainer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
	});

	afterEach(() => {
		cleanup();
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
	});

	// Catches: removing the composer status label leaves dictation failures unannounced.
	it("announces dictation failures through a stable live region without moving focus", () => {
		const { container } = render(() => <MobileToastContainer />);
		const region = container.querySelector('[aria-live="polite"]');
		expect(region).not.toBeNull();
		const focused = document.activeElement;
		toastsStore.add("Dictation failed", "No microphone found, or it is in use", "error", false);
		const failure = screen.getByRole("button", { name: /Dictation failed/ });
		expect(region?.contains(failure)).toBe(true);
		expect(region?.textContent).toContain("No microphone found, or it is in use");
		expect(document.activeElement).toBe(focused);
		fireEvent.keyDown(failure, { key: "Enter" });
		expect(toastsStore.toasts).toHaveLength(0);
		expect(container.querySelector('[aria-live="polite"]')).toBe(region);
		toastsStore.add("Dictation failed", "Speech service unavailable", "error", false);
		expect(region?.contains(screen.getByText("Speech service unavailable"))).toBe(true);
	});

	it("shows the origin repository and dismisses without desktop navigation", () => {
		toastsStore.add("built", "ok", "info", false, undefined, undefined, "/Gits/personal/ego", "remote-session");
		render(() => <MobileToastContainer />);

		expect(screen.getByText("ego")).toBeTruthy();
		fireEvent.click(screen.getByText("built"));
		expect(toastsStore.toasts).toHaveLength(0);
	});

	it("runs an action without also invoking the dismiss surface", () => {
		const action = vi.fn();
		toastsStore.add("Update ready", "", "info", false, { label: "Install", onClick: action });
		render(() => <MobileToastContainer />);

		fireEvent.click(screen.getByText("Install"));
		expect(action).toHaveBeenCalledOnce();
		expect(toastsStore.toasts).toHaveLength(0);
	});

	it("dismisses a Progress toast without navigating or running its dedicated action", () => {
		repositoriesStore.add({ path: "/mobile-current", displayName: "Current" });
		repositoriesStore.add({ path: "/mobile-origin", displayName: "Origin" });
		repositoriesStore.setActive("/mobile-current");
		const openProgress = vi.fn();
		toastsStore.add(
			"Progress",
			"Work complete",
			"info",
			false,
			{ label: "Open Progress", onClick: openProgress },
			undefined,
			"/mobile-origin",
			"origin-session",
		);
		render(() => <MobileToastContainer />);
		fireEvent.click(screen.getByText("Work complete"));

		expect(toastsStore.toasts).toHaveLength(0);
		expect(repositoriesStore.state.activeRepoPath).toBe("/mobile-current");
		expect(openProgress).not.toHaveBeenCalled();
	});
});
