import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockListen } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockListen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../invoke", () => ({
	invoke: mockInvoke,
	listen: mockListen,
}));

vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TerminalTab } from "../../components/SettingsPanel/tabs/TerminalTab";
import { settingsStore } from "../../stores/settings";

/** Follow the visible label association, not the layout around the switch. */
function toggleFor(container: HTMLElement, text: string): HTMLInputElement {
	const label = Array.from(container.querySelectorAll("label")).find((el) => el.textContent === text);
	const input = label ? container.querySelector<HTMLInputElement>(`#${label.htmlFor}`) : null;
	if (!input) throw new Error(`toggle "${text}" not found`);
	return input;
}

const TIMESTAMPS = "Show block timestamps";
const FOLDING = "Block folding";
const MARKS = "Show scrollbar marks";
const REFLOW = "Reflow scrollback on resize";

/** Every Terminal-section display toggle that defaults on, with the config key
 * it round-trips through and the store field it drives. Driving the shared cases
 * off one list is what keeps a fourth toggle from being added with only two of
 * the three checks — which is how `show_scrollbar_marks` reached the config, the
 * store and a reader while having no control at all. */
const DEFAULT_ON = [
	{ label: TIMESTAMPS, key: "show_block_timestamps", field: "showBlockTimestamps" },
	{ label: FOLDING, key: "block_folding_enabled", field: "blockFoldingEnabled" },
	{ label: MARKS, key: "show_scrollbar_marks", field: "showScrollbarMarks" },
	{ label: REFLOW, key: "scrollback_reflow", field: "scrollbackReflow" },
] as const satisfies ReadonlyArray<{ label: string; key: string; field: keyof typeof settingsStore.state }>;

/** Resolve every command the tab's onMount may issue so nothing rejects. */
function invokeImpl(config: Record<string, unknown> = {}) {
	return (cmd: string) => {
		if (cmd === "load_config") return Promise.resolve({ ...config });
		return Promise.resolve(undefined);
	};
}

function savedConfigs(): Record<string, unknown>[] {
	return mockInvoke.mock.calls
		.filter(([cmd]) => cmd === "save_config")
		.map(([, args]) => (args as { config: Record<string, unknown> }).config);
}

describe("TerminalTab block display toggles", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockImplementation(invokeImpl());
		mockListen.mockResolvedValue(vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("renders every display toggle under the Behavior heading", async () => {
		await settingsStore.hydrate();
		const { container } = render(() => <TerminalTab />);

		const terminalHeading = Array.from(container.querySelectorAll("h3")).find((h) => h.textContent === "Behavior");
		expect(terminalHeading).toBeDefined();

		for (const { label } of DEFAULT_ON) {
			const span = Array.from(container.querySelectorAll("label")).find((el) => el.textContent === label);
			expect(span, `no toggle labelled "${label}"`).toBeDefined();
			// Under the Terminal heading, not merely somewhere on the tab.
			expect(
				terminalHeading!.compareDocumentPosition(span!) & Node.DOCUMENT_POSITION_FOLLOWING,
				`"${label}" is not below the Terminal heading`,
			).toBeTruthy();
		}
	});

	it("shows the values the config was loaded with", async () => {
		mockInvoke.mockImplementation(invokeImpl({ show_block_timestamps: false, block_folding_enabled: false }));
		await settingsStore.hydrate();
		const { container } = render(() => <TerminalTab />);

		expect(toggleFor(container, TIMESTAMPS).checked).toBe(false);
		expect(toggleFor(container, FOLDING).checked).toBe(false);
	});

	it("defaults every toggle on when the config carries none of the fields", async () => {
		await settingsStore.hydrate();
		const { container } = render(() => <TerminalTab />);

		for (const { label } of DEFAULT_ON) {
			expect(toggleFor(container, label).checked, `"${label}" did not default on`).toBe(true);
		}
	});

	it.each(DEFAULT_ON)("persists a flipped $label into the saved config", async ({ label, key, field }) => {
		vi.useFakeTimers();
		mockInvoke.mockImplementation(invokeImpl({ [key]: true }));
		await settingsStore.hydrate();

		const { container } = render(() => <TerminalTab />);
		mockInvoke.mockClear();
		fireEvent.change(toggleFor(container, label), { target: { checked: false } });

		// The store debounces its writes, so nothing is saved until the timer runs.
		expect(savedConfigs()).toEqual([]);
		await vi.advanceTimersByTimeAsync(600);

		expect(savedConfigs()).toHaveLength(1);
		expect(savedConfigs()[0][key]).toBe(false);
		expect(settingsStore.state[field]).toBe(false);
	});

	it("re-renders the toggle from a reload that returns the saved value", async () => {
		// The round trip the story asks for, end to end on the frontend side:
		// save writes the field, a fresh load_config returns it, the checkbox
		// comes back off rather than snapping to the `?? true` default.
		vi.useFakeTimers();
		mockInvoke.mockImplementation(invokeImpl({ show_block_timestamps: true }));
		await settingsStore.hydrate();

		const first = render(() => <TerminalTab />);
		fireEvent.change(toggleFor(first.container, TIMESTAMPS), { target: { checked: false } });
		await vi.advanceTimersByTimeAsync(600);
		const written = savedConfigs()[0];
		cleanup();

		mockInvoke.mockImplementation(invokeImpl(written));
		await settingsStore.hydrate();
		const { container } = render(() => <TerminalTab />);
		expect(toggleFor(container, TIMESTAMPS).checked).toBe(false);
	});
});
