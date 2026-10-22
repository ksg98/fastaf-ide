import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SmartButtonStrip } from "../../components/SmartButtonStrip/SmartButtonStrip";
import { promptLibraryStore, type SavedPrompt } from "../../stores/promptLibrary";

// SmartButtonStrip's two looks (SPEC §C5): the composer's ghost "chip" and the
// bordered "split" the sidebar and the PR popover keep. CSS modules are
// non-scoped in tests, so class names are the local ones.

const created: SavedPrompt[] = [];

function addPrompt(name: string, executionMode: SavedPrompt["executionMode"]): SavedPrompt {
	const p = promptLibraryStore.createPrompt({
		name,
		description: `${name} description`,
		content: "echo hi",
		category: "custom",
		isFavorite: false,
		placement: ["git-changes"],
		executionMode,
	});
	created.push(p);
	return p;
}

beforeEach(() => {
	vi.useFakeTimers();
	for (const p of promptLibraryStore.getSmartByPlacement("git-changes")) promptLibraryStore.deletePrompt(p.id);
});

// The store saves on a debounce; drain it so the leak detector does not blame a later test.
afterEach(() => {
	cleanup();
	for (const p of created.splice(0)) promptLibraryStore.deletePrompt(p.id);
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

describe("SmartButtonStrip chip", () => {
	it("names its two halves, which the commit composer's row folds by", () => {
		const run = addPrompt("Alpha", "shell");
		addPrompt("Beta", "shell");
		const { container } = render(() => (
			<SmartButtonStrip appearance="chip" placement="git-changes" repoPath="/repo" defaultPromptId={run.id} />
		));
		const main = container.querySelector('[data-part="main"]') as HTMLButtonElement;
		const arrow = container.querySelector('[data-part="arrow"]') as HTMLButtonElement;
		expect(main.textContent).toBe("Alpha");
		expect(main.title).toBe("Alpha description");
		expect(main.getAttribute("aria-disabled")).toBeNull();
		expect(arrow.getAttribute("aria-haspopup")).toBe("menu");
		expect(arrow.getAttribute("aria-expanded")).toBe("false");
		// The ghost chip draws no icon: the composer's only sparkle is Generate.
		expect(main.querySelector("svg")).toBeNull();
	});

	it("keeps a blocked chip focusable and puts the reason in its tooltip", () => {
		const run = addPrompt("Alpha", "inject"); // inject needs a terminal; the test has none
		addPrompt("Beta", "shell");
		const { container } = render(() => (
			<SmartButtonStrip appearance="chip" placement="git-changes" repoPath="/repo" defaultPromptId={run.id} />
		));
		const main = container.querySelector('[data-part="main"]') as HTMLButtonElement;
		expect(main.disabled).toBe(false);
		expect(main.getAttribute("aria-disabled")).toBe("true");
		expect(main.title).toBe("No active terminal");
	});

	it("opens its menu from the arrow, ticks the active prompt and closes on Esc", () => {
		const run = addPrompt("Alpha", "shell");
		addPrompt("Beta", "shell");
		const { container } = render(() => (
			<SmartButtonStrip appearance="chip" placement="git-changes" repoPath="/repo" defaultPromptId={run.id} />
		));
		const arrow = container.querySelector('[data-part="arrow"]') as HTMLButtonElement;
		fireEvent.click(arrow);
		expect(arrow.getAttribute("aria-expanded")).toBe("true");
		const items = [...container.querySelectorAll('[role="menuitem"]')];
		expect(items.map((i) => i.textContent)).toEqual(["Alpha", "Beta"]);
		expect(items[0].querySelector("svg")).not.toBeNull(); // the check on the active prompt
		expect(items[1].querySelector("svg")).toBeNull();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector('[role="menu"]')).toBeNull();
	});

	it("renders nothing without a prompt for its placement", () => {
		const { container } = render(() => <SmartButtonStrip appearance="chip" placement="git-changes" repoPath="/repo" />);
		expect(container.innerHTML).toBe("");
	});
});

describe("SmartButtonStrip split", () => {
	it("keeps the bordered split's DOM: no part hooks, no ARIA menu, the sparkle leads", () => {
		const run = addPrompt("Alpha", "shell");
		addPrompt("Beta", "shell");
		const { container } = render(() => (
			<SmartButtonStrip placement="git-changes" repoPath="/repo" defaultPromptId={run.id} />
		));
		const root = container.firstElementChild as HTMLElement;
		expect(root.className).toBe("split");
		expect(container.querySelector("[data-part]")).toBeNull();
		const [main, arrow] = [...root.querySelectorAll(":scope > button")];
		expect(main.className).toBe("splitMain");
		expect(main.querySelector("svg")).not.toBeNull();
		expect(arrow.className).toBe("splitArrow");
		expect(arrow.getAttribute("aria-haspopup")).toBeNull();
	});
});
