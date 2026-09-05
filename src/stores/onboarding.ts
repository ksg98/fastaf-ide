import { createStore } from "solid-js/store";

/**
 * What the app has already shown the user, and what they have already done.
 *
 * FastAF's three big ideas — a terminal per branch you can split and tile,
 * dictation into any terminal, and a chat that can drive those terminals —
 * are not discoverable from the chrome alone. The app teaches each one once,
 * at the moment it becomes useful, and remembers so it never nags:
 *
 *   - `dismissed` — hints the user has closed (or outgrown by doing the thing);
 *   - `done` — milestones reached, ticked off under Help › Getting started.
 *
 * Kept in localStorage rather than ui-prefs: losing it only means a hint
 * shows once more, which is not worth a Rust round-trip.
 */
export type HintId = "welcome" | "chat" | "dictation";
export type Milestone = "multi" | "chat" | "dictation";

interface OnboardingState {
	dismissed: HintId[];
	done: Milestone[];
}

const STORAGE_KEY = "fastaf.onboarding.v1";

function load(): OnboardingState {
	try {
		const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
		if (raw) {
			const parsed = JSON.parse(raw) as Partial<OnboardingState>;
			return {
				dismissed: Array.isArray(parsed.dismissed) ? parsed.dismissed : [],
				done: Array.isArray(parsed.done) ? parsed.done : [],
			};
		}
	} catch {
		/* unreadable — start fresh */
	}
	return { dismissed: [], done: [] };
}

function createOnboardingStore() {
	const [state, setState] = createStore<OnboardingState>(load());

	const persist = () => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify({ dismissed: state.dismissed, done: state.done }));
		} catch {
			/* storage unavailable (private mode, quota) — the session still works */
		}
	};

	return {
		state,
		isDismissed: (id: HintId): boolean => state.dismissed.includes(id),
		dismiss(id: HintId): void {
			if (state.dismissed.includes(id)) return;
			setState("dismissed", (list) => [...list, id]);
			persist();
		},
		isDone: (milestone: Milestone): boolean => state.done.includes(milestone),
		markDone(milestone: Milestone): void {
			if (state.done.includes(milestone)) return;
			setState("done", (list) => [...list, milestone]);
			persist();
		},
		/** Forget everything — hints show again from the start. */
		reset(): void {
			setState({ dismissed: [], done: [] });
			persist();
		},
	};
}

export const onboardingStore = createOnboardingStore();
