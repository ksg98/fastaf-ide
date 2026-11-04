import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { LastPromptBar } from "../../components/Terminal/LastPromptBar";
import { ViewModeToggle } from "../../components/Terminal/TerminalChatView";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

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

// Catches: the Context preview uses the pixels covered by the absolute view switch.
it.each([true, false])("reserves the view switch gutter only when present=%s", (present) => {
	const style = document.createElement("style");
	style.textContent = readFileSync(resolve(process.cwd(), "src/components/Terminal/LastPromptBar.module.css"), "utf8");
	// CSS modules compile :global away in Vite; mirror that transformation here.
	style.textContent = style.textContent.replace(/:global\(([^)]+)\)/g, "$1");
	document.head.append(style);
	const id = terminalsStore.add(makeTerminal({ agentType: present ? "claude" : null }));
	try {
		const { container } = render(() => (
			<div>
				<ViewModeToggle terminalId={id} />
				<LastPromptBar
					intent={() => "A long preview that must not run under the switch"}
					ptyDescription={() => null}
					prompt={() => null}
				/>
			</div>
		));
		const header = getComputedStyle(container.querySelector(".header")!);
		const padding = parseFloat(header.paddingRight);
		// Recorded toggle is 76px wide, 20px from the pane edge; allow a text gap.
		if (present) expect(padding).toBeGreaterThanOrEqual(106);
		else expect(padding).toBe(10);
		expect(getComputedStyle(container.querySelector(".preview")!).textOverflow).toBe("ellipsis");
	} finally {
		style.remove();
	}
});
