import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnswersPanel } from "../AnswersPanel";

const panelOf = (container: HTMLElement) => container.querySelector("[data-answers-only]") as HTMLElement;

describe("AnswersPanel", () => {
	afterEach(() => vi.restoreAllMocks());

	it("lists each prompt followed by its answers as selectable text", () => {
		const { container } = render(() => (
			<AnswersPanel
				view={[
					{ prompt: "❯ q1", answers: ["💬 one", "💬 two"] },
					{ prompt: "❯ q2", answers: ["💬 three"] },
				]}
				fontFamily="monospace"
				fontSize={13}
			/>
		));
		const panel = panelOf(container);
		expect(panel.textContent).toBe("❯ q1onetwo❯ q2three");
		expect(Array.from(container.querySelectorAll("[data-prompt]")).map((n) => n.textContent)).toEqual(["❯ q1", "❯ q2"]);
		// catches: the layer blocking selection/copy, or being unable to scroll a long history
		expect(panel.style.userSelect).toBe("text");
		expect(panel.style.overflow).toBe("auto");
	});

	it("renders no row for a turn without a 💬 answer", () => {
		// catches: a placeholder or bare prompt row printed for an answerless turn
		const { container } = render(() => (
			<AnswersPanel
				view={[
					{ prompt: "❯ old", answers: [] },
					{ prompt: "❯ answered", answers: ["💬 yes"] },
					{ prompt: "❯ asked just now", answers: [] },
				]}
				fontFamily="monospace"
				fontSize={13}
			/>
		));
		expect(panelOf(container).textContent).toBe("❯ answeredyes");
		expect(container.querySelectorAll("[data-turn]")).toHaveLength(1);
	});

	it("shows a notice for empty and answerless history, then removes it when an answer arrives", () => {
		// catches: filtering all turns leaves a silent black overlay, or the notice stays over real answers
		const [view, setView] = createSignal<Array<{ prompt: string | null; answers: string[] }>>([]);
		const { container } = render(() => <AnswersPanel view={view()} fontFamily="monospace" fontSize={13} />);
		expect(container.querySelector('[role="status"]')?.textContent).toBe(
			"No marked answers in the retained terminal history.",
		);
		setView([{ prompt: "❯ pending", answers: [] }]);
		expect(container.querySelector('[role="status"]')).not.toBeNull();
		expect(container.querySelectorAll("[data-turn]")).toHaveLength(0);
		setView([{ prompt: "❯ pending", answers: ["💬 ready"] }]);
		expect(container.querySelector('[role="status"]')).toBeNull();
		expect(container.querySelector("[data-answer]")?.textContent).toBe("ready");
	});

	it("renders a 300-character multi-line prompt in full", () => {
		// catches: the prompt truncated to one line
		const prompt = `❯ ${"a".repeat(100)}\n  ${"b".repeat(100)}\n  ${"c".repeat(96)}`;
		const { container } = render(() => (
			<AnswersPanel view={[{ prompt, answers: ["💬 a"] }]} fontFamily="monospace" fontSize={13} />
		));
		expect(container.querySelector("[data-prompt]")?.textContent).toBe(prompt);
	});

	it("opens scrolled to the newest entry", () => {
		// catches: the panel opening at the oldest question of a long history
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
		const { container } = render(() => (
			<AnswersPanel view={[{ prompt: "❯ q", answers: ["💬 a"] }]} fontFamily="monospace" fontSize={13} />
		));
		expect(panelOf(container).scrollTop).toBe(1000);
	});
});
