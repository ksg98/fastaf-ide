import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
	setup: null as unknown as {
		set: (patch: Record<string, unknown>) => void;
		run: ReturnType<typeof vi.fn>;
		dismiss: ReturnType<typeof vi.fn>;
		requestFirstPrompt: ReturnType<typeof vi.fn>;
	},
	played: [] as string[],
}));

vi.mock("../../stores/voiceSetup", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ running: false, step: "idle", error: null as string | null });
	const run = vi.fn().mockResolvedValue(true);
	const dismiss = vi.fn();
	const requestFirstPrompt = vi.fn();
	world.setup = { set: (patch) => setState(patch), run, dismiss, requestFirstPrompt };
	return {
		voiceSetup: { state, run, dismiss, requestFirstPrompt, percent: () => 37, downloadMb: () => 660 },
	};
});

import { VoiceWelcome } from "../../components/Onboarding/VoiceWelcome";
import { onboardingStore } from "../../stores/onboarding";

const byId = (root: HTMLElement, id: string) => root.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

class FakeAudio {
	constructor(public src: string) {}
	addEventListener() {}
	play() {
		world.played.push(this.src);
		return Promise.resolve();
	}
	pause() {}
}

beforeEach(() => {
	onboardingStore.reset();
	world.played.length = 0;
	world.setup.set({ running: false, step: "idle", error: null });
	world.setup.run.mockClear().mockResolvedValue(true);
	world.setup.dismiss.mockClear();
	world.setup.requestFirstPrompt.mockClear();
	vi.stubGlobal("Audio", FakeAudio);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	onboardingStore.reset();
});

describe("VoiceWelcome", () => {
	it("opens on what FastAF is for, with one way in and one way past", () => {
		const { container } = render(() => <VoiceWelcome />);

		expect(container.textContent).toContain("Talk to your agents.");
		expect(byId(container, "voice-welcome-on")?.textContent).toBe("Turn on voice");
		expect(byId(container, "voice-welcome-later")?.textContent).toBe("Not now, I'll type");
		// The size of what the button starts is said before it is pressed.
		expect(container.textContent).toContain("One download, about 660 MB.");
		expect(world.setup.run).not.toHaveBeenCalled();
	});

	// Catches: the first spoken sentence waiting for a 660 MB download, which
	// is the opposite of what the screen is there to show.
	it("greets out loud on the click, before anything has downloaded", async () => {
		let finish!: (ok: boolean) => void;
		world.setup.run.mockReturnValue(new Promise<boolean>((resolve) => (finish = resolve)));
		const { container } = render(() => <VoiceWelcome />);

		fireEvent.click(byId(container, "voice-welcome-on") as HTMLElement);

		expect(world.played).toHaveLength(1);
		expect(world.setup.run).toHaveBeenCalledOnce();
		finish(true);
	});

	it("shows the download as it goes", () => {
		const { container } = render(() => <VoiceWelcome />);
		world.setup.set({ running: true, step: "speech" });

		expect(byId(container, "voice-welcome-progress")?.textContent).toContain("Getting speech ready · 37%");
		expect(byId(container, "voice-welcome-on")).toBeNull();
	});

	it("moves on to the first prompt, already listening, once voice is ready", async () => {
		const { container } = render(() => <VoiceWelcome />);

		fireEvent.click(byId(container, "voice-welcome-on") as HTMLElement);

		await waitFor(() => expect(world.setup.requestFirstPrompt).toHaveBeenCalledOnce());
		expect(onboardingStore.isDismissed("voice")).toBe(true);
		expect(onboardingStore.isDismissed("welcome")).toBe(true);
	});

	// Catches: a failed download dropping the user on the next screen as if
	// voice were on.
	it("stays put, says why, and offers another try when setup fails", async () => {
		world.setup.run.mockImplementation(async () => {
			world.setup.set({ step: "failed", error: "The speech model could not be downloaded." });
			return false;
		});
		const { container } = render(() => <VoiceWelcome />);

		fireEvent.click(byId(container, "voice-welcome-on") as HTMLElement);

		await waitFor(() => expect(byId(container, "voice-welcome-error")).not.toBeNull());
		expect(byId(container, "voice-welcome-error")?.textContent).toBe("The speech model could not be downloaded.");
		expect(byId(container, "voice-welcome-on")?.textContent).toBe("Try again");
		expect(onboardingStore.isDismissed("voice")).toBe(false);
		expect(world.setup.requestFirstPrompt).not.toHaveBeenCalled();
	});

	it("takes Not now for an answer and goes on to the terminals introduction", () => {
		const { container } = render(() => <VoiceWelcome />);

		fireEvent.click(byId(container, "voice-welcome-later") as HTMLElement);

		expect(onboardingStore.isDismissed("voice")).toBe(true);
		// The terminals introduction has not been seen yet.
		expect(onboardingStore.isDismissed("welcome")).toBe(false);
		expect(world.setup.run).not.toHaveBeenCalled();
		expect(world.played).toHaveLength(0);
	});
});
