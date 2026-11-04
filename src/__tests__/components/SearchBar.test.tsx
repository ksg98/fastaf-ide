import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSearchVisibility, SearchBar } from "../../components/shared/SearchBar";

afterEach(cleanup);

/** Minimal required props — each test overrides only what it asserts on. */
const baseProps = {
	onSearch: () => {},
	onNext: () => {},
	onPrev: () => {},
	onClose: () => {},
	matchIndex: 0,
	matchCount: 0,
};

describe("createSearchVisibility", () => {
	it("bumps focusToken on every open, including while already visible", () =>
		createRoot((dispose) => {
			const search = createSearchVisibility();
			expect(search.visible()).toBe(false);
			const initial = search.focusToken();

			search.open();
			expect(search.visible()).toBe(true);
			const afterFirst = search.focusToken();
			expect(afterFirst).toBeGreaterThan(initial);

			// The regression this guards: pressing the find shortcut again while the
			// bar is still open leaves `visible` unchanged, so the token is the ONLY
			// thing that can carry the re-focus request to the auto-focus effect.
			search.open();
			expect(search.visible()).toBe(true);
			expect(search.focusToken()).toBeGreaterThan(afterFirst);

			dispose();
		}));

	it("close hides the bar without disturbing the token", () =>
		createRoot((dispose) => {
			const search = createSearchVisibility();
			search.open();
			const token = search.focusToken();

			search.close();
			expect(search.visible()).toBe(false);
			expect(search.focusToken()).toBe(token);

			dispose();
		}));
});

describe("SearchBar auto-focus", () => {
	it("focuses the input when the bar becomes visible", async () => {
		const [visible, setVisible] = createSignal(false);
		const { getByPlaceholderText } = render(() => <SearchBar {...baseProps} visible={visible()} focusToken={0} />);

		setVisible(true);
		const input = getByPlaceholderText("Find…") as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(input));
	});

	it("re-focuses on a focusToken bump after focus moved into the content", async () => {
		const [token, setToken] = createSignal(1);
		const { getByPlaceholderText } = render(() => <SearchBar {...baseProps} visible={true} focusToken={token()} />);

		const input = getByPlaceholderText("Find…") as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(input));

		// The user clicks into the page: focus leaves the search input while the bar
		// stays open — exactly the state Cmd+F used to be a no-op in.
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();
		expect(document.activeElement).not.toBe(input);

		// Pressing the find shortcut again bumps the token; `visible` never changes.
		setToken(2);
		await waitFor(() => expect(document.activeElement).toBe(input));

		outside.remove();
	});
});

// Catches: primitive migration loses search options, navigation or replacement handlers.
it("preserves search, option, navigation and replace actions through shared controls", async () => {
	const onSearch = vi.fn(),
		onNext = vi.fn(),
		onPrev = vi.fn(),
		onClose = vi.fn();
	const onReplace = vi.fn(),
		onReplaceAll = vi.fn();
	const view = render(() => (
		<SearchBar
			visible
			{...baseProps}
			onSearch={onSearch}
			onNext={onNext}
			onPrev={onPrev}
			onClose={onClose}
			onReplace={onReplace}
			onReplaceAll={onReplaceAll}
		/>
	));
	const find = view.getByPlaceholderText("Find…");
	fireEvent.input(find, { target: { value: "needle" } });
	expect(onSearch).toHaveBeenLastCalledWith("needle", { caseSensitive: false, regex: false, wholeWord: false });
	fireEvent.click(view.getByTitle("Match Case"));
	await waitFor(() =>
		expect(onSearch).toHaveBeenLastCalledWith("needle", { caseSensitive: true, regex: false, wholeWord: false }),
	);
	fireEvent.keyDown(find, { key: "Enter" });
	fireEvent.keyDown(find, { key: "Enter", shiftKey: true });
	expect(onNext).toHaveBeenCalledTimes(1);
	expect(onPrev).toHaveBeenCalledTimes(1);
	fireEvent.click(view.getByTitle("Toggle Replace"));
	const replace = view.getByPlaceholderText("Replace…");
	fireEvent.input(replace, { target: { value: "new" } });
	fireEvent.keyDown(replace, { key: "Enter" });
	fireEvent.keyDown(replace, { key: "Enter", ctrlKey: true });
	expect(onReplace).toHaveBeenCalledWith("new");
	expect(onReplaceAll).toHaveBeenCalledWith("new");
	fireEvent.keyDown(replace, { key: "Escape" });
	expect(onClose).toHaveBeenCalledTimes(1);
});

describe("SearchBar for a transcript host", () => {
	// A visible bar focuses its field on the next frame; let it land before the next test.
	afterEach(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

	// Catches: the field losing a host's accessible name ("Find in chat") behind the bare "Find…" hint.
	it("names its field with inputLabel and keeps the placeholder as a hint", () => {
		const { getByRole } = render(() => <SearchBar {...baseProps} visible={true} inputLabel="Find in chat" />);
		expect(getByRole("textbox", { name: "Find in chat" }).getAttribute("placeholder")).toBe("Find…");
	});

	// Catches: a phone-width host unable to drop the option toggles that wrap the bar onto a second row.
	it("drops the option toggles with optionToggles={false}, keeping navigation and close", () => {
		const titles = (container: HTMLElement) => [...container.querySelectorAll("button")].map((b) => b.title);
		const full = render(() => <SearchBar {...baseProps} visible={true} />);
		expect(titles(full.container)).toEqual(
			expect.arrayContaining(["Match Case", "Match Whole Word", "Use Regular Expression"]),
		);
		cleanup();
		const compact = render(() => <SearchBar {...baseProps} visible={true} optionToggles={false} />);
		expect(titles(compact.container)).toEqual(["Previous Match (Shift+Enter)", "Next Match (Enter)", "Close (Escape)"]);
	});
});
