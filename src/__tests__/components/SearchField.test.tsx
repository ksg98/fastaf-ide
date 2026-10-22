import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchField, SearchFieldToggle } from "../../components/shared/SearchField";

afterEach(cleanup);

/** A controlled field, the way every panel uses it. */
function renderField(initial = "", extra: Record<string, unknown> = {}) {
	const onInput = vi.fn();
	const onClear = vi.fn();
	const [value, setValue] = createSignal(initial);
	const result = render(() => (
		<SearchField
			value={value()}
			onInput={(v) => {
				onInput(v);
				setValue(v);
			}}
			onClear={onClear}
			placeholder="Filter files"
			title="* matches within a folder, ** across folders"
			{...extra}
		/>
	));
	const input = result.container.querySelector("input") as HTMLInputElement;
	const clearButton = () => result.container.querySelector('button[title="Clear"]') as HTMLButtonElement | null;
	return { ...result, input, onInput, onClear, value, setValue, clearButton };
}

describe("SearchField", () => {
	it("renders the query and a plain placeholder, which is also its accessible name", () => {
		const { input } = renderField("ts");
		expect(input.value).toBe("ts");
		expect(input.placeholder).toBe("Filter files");
		expect(input.getAttribute("aria-label")).toBe("Filter files");
	});

	it("puts the syntax help in the field's tooltip, not the placeholder", () => {
		const { input } = renderField();
		expect(input.closest("[title]")?.getAttribute("title")).toBe("* matches within a folder, ** across folders");
		expect(input.placeholder).not.toMatch(/wildcard|\*/);
	});

	it("reports every edit", () => {
		const { input, onInput } = renderField();
		fireEvent.input(input, { target: { value: "pan" } });
		expect(onInput).toHaveBeenLastCalledWith("pan");
	});

	it("shows the clear button only while there is a query", () => {
		const { clearButton, setValue } = renderField();
		expect(clearButton()).toBeNull();
		setValue("x");
		expect(clearButton()).not.toBeNull();
	});

	it("clears from the button, tells the panel, and keeps the caret in the field", () => {
		const { input, clearButton, onInput, onClear } = renderField("panel");
		const button = clearButton() as HTMLButtonElement;
		// The press must not steal focus from the query.
		const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		button.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);
		button.click();
		expect(onInput).toHaveBeenLastCalledWith("");
		expect(onClear).toHaveBeenCalledOnce();
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("");
	});

	it("clears on Esc and keeps that Esc from reaching the panel", () => {
		const panelKeyDown = vi.fn();
		document.addEventListener("keydown", panelKeyDown);
		try {
			const { input, onInput, onClear } = renderField("voice");
			fireEvent.keyDown(input, { key: "Escape" });
			expect(onInput).toHaveBeenLastCalledWith("");
			expect(onClear).toHaveBeenCalledOnce();
			expect(panelKeyDown).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener("keydown", panelKeyDown);
		}
	});

	it("keeps the clearing Esc from a panel's own onKeyDown, which would read it as a list Esc", () => {
		const listKeyDown = vi.fn();
		const [value, setValue] = createSignal("voice");
		const { container } = render(() => (
			<div onKeyDown={listKeyDown}>
				<SearchField value={value()} onInput={setValue} placeholder="Filter branches" />
			</div>
		));
		const input = container.querySelector("input") as HTMLInputElement;
		fireEvent.keyDown(input, { key: "Escape" });
		expect(value()).toBe("");
		expect(listKeyDown).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Escape" });
		expect(listKeyDown).toHaveBeenCalledOnce();
	});

	it("lets Esc through on an empty field so the panel can use it", () => {
		const panelKeyDown = vi.fn();
		document.addEventListener("keydown", panelKeyDown);
		try {
			const { input, onInput, onClear } = renderField("");
			fireEvent.keyDown(input, { key: "Escape" });
			expect(onInput).not.toHaveBeenCalled();
			expect(onClear).not.toHaveBeenCalled();
			expect(panelKeyDown).toHaveBeenCalledOnce();
		} finally {
			document.removeEventListener("keydown", panelKeyDown);
		}
	});

	it("runs the panel's own key handler first; preventDefault keeps the query", () => {
		const onKeyDown = vi.fn((e: KeyboardEvent) => e.preventDefault());
		const { input, onInput } = renderField("keep", { onKeyDown });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(onKeyDown).toHaveBeenCalledOnce();
		expect(onInput).not.toHaveBeenCalled();
	});

	it("forwards data-* attributes to the input, where focus restore looks for them", () => {
		const { input } = renderField("", { "data-focus-target": "file-browser-search", "data-repo-path": "/repo" });
		expect(input.dataset.focusTarget).toBe("file-browser-search");
		expect(input.dataset.repoPath).toBe("/repo");
		expect(document.querySelector('[data-focus-target="file-browser-search"][data-repo-path="/repo"]')).toBe(input);
	});

	it("hands the input to a ref callback", () => {
		let received: HTMLInputElement | undefined;
		const { input } = renderField("", {
			ref: (el: HTMLInputElement) => {
				received = el;
			},
		});
		expect(received).toBe(input);
	});

	it("adds the consumer's hook class to the input and its layout class to the field", () => {
		const { input } = renderField("", { inputClass: "filterInput", class: "filterRow" });
		expect(input.classList.contains("filterInput")).toBe(true);
		expect(input.closest(".filterRow")).not.toBeNull();
	});

	it("puts the caret in the input when the field's chrome is pressed", () => {
		const { container, input } = renderField();
		const icon = container.querySelector("svg") as SVGElement;
		fireEvent.mouseDown(icon);
		expect(document.activeElement).toBe(input);
	});

	it("disables the input and hides the clear button when disabled", () => {
		const { input, clearButton } = renderField("x", { disabled: true });
		expect(input.disabled).toBe(true);
		expect(clearButton()).toBeNull();
	});
});

describe("SearchFieldToggle", () => {
	it("renders inside the field's trailing slot and reports its pressed state", () => {
		const onToggle = vi.fn();
		const [active, setActive] = createSignal(false);
		const { container } = render(() => (
			<SearchField
				value=""
				onInput={() => {}}
				placeholder="Search in files"
				trailing={
					<SearchFieldToggle
						active={active()}
						title="Match case"
						onClick={() => {
							onToggle();
							setActive((v) => !v);
						}}
					>
						Aa
					</SearchFieldToggle>
				}
			/>
		));
		const toggle = container.querySelector('button[title="Match case"]') as HTMLButtonElement;
		expect(toggle.getAttribute("aria-pressed")).toBe("false");
		expect(toggle.getAttribute("aria-label")).toBe("Match case");

		const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
		toggle.dispatchEvent(press);
		expect(press.defaultPrevented).toBe(true);

		toggle.click();
		expect(onToggle).toHaveBeenCalledOnce();
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
	});

	it("keeps a consumer's hook class (e.g. the Files mode toggle)", () => {
		const { container } = render(() => (
			<SearchFieldToggle active={false} title="Switch to content search" onClick={() => {}} class="modeToggle">
				T
			</SearchFieldToggle>
		));
		expect(container.querySelector('button[title="Switch to content search"]')?.classList.contains("modeToggle")).toBe(
			true,
		);
	});
});
