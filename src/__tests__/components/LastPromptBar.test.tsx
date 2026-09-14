import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { LastPromptBar } from "../../components/Terminal/LastPromptBar";

afterEach(cleanup);

describe("LastPromptBar", () => {
	it("shows the PTY description and last prompt together", async () => {
		const { container } = render(() => (
			<LastPromptBar
				intent={() => "Running the validation suite"}
				ptyDescription={() => "Validating the release"}
				prompt={() => "Run the full release checks"}
			/>
		));

		expect(container.textContent).toContain("Intent: Running the validation suite");
		expect(container.textContent).toContain("Assignment: Validating the release");
		expect(container.textContent).toContain("Validating the release");
		expect(container.textContent).toContain("Prompt: Run the full release checks");

		await fireEvent.click(container.firstElementChild!);
		expect(container.textContent).toBe(
			"ContextIntentRunning the validation suiteAssignmentValidating the releasePromptRun the full release checks",
		);
		expect(container.textContent?.match(/Prompt/g)).toHaveLength(1);
	});

	it("falls back to the last prompt when no PTY description exists", () => {
		const { container } = render(() => (
			<LastPromptBar intent={() => null} ptyDescription={() => null} prompt={() => "Fix the failing test"} />
		));

		expect(container.textContent).toContain("Prompt: Fix the failing test");
	});

	it("renders intent without requiring a prompt or orchestration description", () => {
		const { container } = render(() => (
			<LastPromptBar intent={() => "Reviewing the parser"} ptyDescription={() => null} prompt={() => null} />
		));

		expect(container.textContent).toBe("ContextIntent: Reviewing the parser");
	});
});
